import { addonBuilder, serveHTTP } from "stremio-addon-sdk";

const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const MDBLIST_BASE = "https://mdblist.com/api";

// In-memory cache (works per-serverless instance; good enough for rate limiting)
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = TTL_MS) {
  cache.set(key, { exp: Date.now() + ttl, value });
}

async function fetchJson(url) {
  const cached = cacheGet(url);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: { "User-Agent": "stremio-mdblist-addon/1.0" }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} for ${url} :: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  cacheSet(url, json);
  return json;
}

function formatRatingsBlock(mdblist) {
  // MDBList can return either top-level keys or nested ratings depending on settings/endpoint.
  const r = mdblist?.ratings ? mdblist.ratings : mdblist;

  const imdb = r?.imdb;
  const tmdb = r?.tmdb;
  const trakt = r?.trakt;
  const tomato = r?.tomato;
  const metacritic = r?.metacritic;
  const letterboxd = r?.letterboxd;

  const lines = [];

  if (imdb != null) lines.push(`IMDb: ${imdb}`);
  if (tmdb != null) lines.push(`TMDb: ${tmdb}`);
  if (trakt != null) lines.push(`Trakt: ${trakt}`);
  if (letterboxd != null) lines.push(`Letterboxd: ${letterboxd}`);
  if (tomato != null) lines.push(`Rotten Tomatoes: ${String(tomato).includes("%") ? tomato : `${tomato}%`}`);
  if (metacritic != null) lines.push(`Metacritic: ${metacritic}`);

  if (!lines.length) return null;

  return `Ratings\n${lines.join("\n")}`;
}

const apiKey = process.env.MDBLIST_API_KEY;

const manifest = {
  id: "org.josh.mdblist.ratings.description",
  version: "1.0.0",
  name: "MDBList Ratings (Description)",
  description: "Appends MDBList ratings (IMDb/TMDb/Trakt/RT/Metacritic/etc.) into the summary description for movies and series.",
  resources: ["meta"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async ({ type, id }) => {
  // Always return Cinemeta meta even if MDBList fails.
  const cinemetaUrl = `${CINEMETA_BASE}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;

  let cinemeta;
  try {
    cinemeta = await fetchJson(cinemetaUrl);
  } catch {
    return { meta: null };
  }

  const meta = cinemeta?.meta;
  if (!meta) return { meta };

  // If no MDBList key is set, don't break the addon—just return Cinemeta.
  if (!apiKey) return { meta };

  const mdblistUrl = `${MDBLIST_BASE}/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(id)}`;

  let mdblist;
  try {
    mdblist = await fetchJson(mdblistUrl);
  } catch {
    return { meta };
  }

  const block = formatRatingsBlock(mdblist);
  if (!block) return { meta };

  // Put the ratings at the TOP of description for easy reading everywhere.
  const originalDesc = meta.description || "";
  meta.description = `${block}\n\n${originalDesc}`.trim();

  return { meta };
});

// Vercel handler
export default async function handler(req, res) {
  // serveHTTP supports Node req/res style used by Vercel
  await serveHTTP(builder.getInterface(), { req, res });
}
