import { addonBuilder, serveHTTP } from "stremio-addon-sdk";

const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const MDBLIST_BASE = "https://mdblist.com/api";

// Basic in-memory cache (per function instance)
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

  const res = await fetch(url, { headers: { "User-Agent": "stremio-mdblist-addon/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const json = await res.json();
  cacheSet(url, json);
  return json;
}

function formatRatingsBlock(mdblist) {
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

const manifest = {
  id: "org.joshuawlambert.mdblist.ratings.description",
  version: "1.0.1",
  name: "MDBList Ratings (Description)",
  description: "Adds MDBList ratings into the summary description for movies and series.",
  resources: ["meta"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async ({ type, id }) => {
  // Always start from Cinemeta
  const cinemetaUrl = `${CINEMETA_BASE}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const cinemeta = await fetchJson(cinemetaUrl);
  const meta = cinemeta?.meta;
  if (!meta) return { meta };

  const apiKey = process.env.MDBLIST_API_KEY;
  if (!apiKey) return { meta }; // no key = no augmentation, but do not crash

  // MDBList by IMDb id
  const mdblistUrl = `${MDBLIST_BASE}/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(id)}`;

  try {
    const mdblist = await fetchJson(mdblistUrl);
    const block = formatRatingsBlock(mdblist);
    if (block) {
      const original = meta.description || "";
      meta.description = `${block}\n\n${original}`.trim();
    }
  } catch {
    // If MDBList fails, still return Cinemeta meta
  }

  return { meta };
});

export default async function handler(req, res) {
  try {
    await serveHTTP(builder.getInterface(), { req, res });
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: e?.message || String(e) }));
  }
}
