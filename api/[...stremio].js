import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = pkg;

const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const MDBLIST_BASE = "https://mdblist.com/api";

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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} for ${url} :: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  cacheSet(url, json);
  return json;
}

function formatRatingsBlock(mdblist) {
  const r = mdblist?.ratings ? mdblist.ratings : mdblist;

  const fields = [
    ["IMDb", r?.imdb],
    ["TMDb", r?.tmdb],
    ["Trakt", r?.trakt],
    ["Letterboxd", r?.letterboxd],
    ["Rotten Tomatoes", r?.tomato != null ? (String(r.tomato).includes("%") ? r.tomato : `${r.tomato}%`) : null],
    ["Metacritic", r?.metacritic]
  ];

  const lines = fields
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${v}`);

  if (!lines.length) return null;
  return `Ratings\n${lines.join("\n")}`;
}

const manifest = {
  id: "org.joshuawlambert.mdblist.ratings.description",
  version: "1.0.3",
  name: "MDBList Ratings (Description)",
  description: "Appends MDBList ratings into the summary description for movies and series.",
  resources: ["meta"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async ({ type, id }) => {
  // Base meta from Cinemeta
  const cinemetaUrl = `${CINEMETA_BASE}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const cinemeta = await fetchJson(cinemetaUrl);
  const meta = cinemeta?.meta;
  if (!meta) return { meta };

  // No key? Return Cinemeta unchanged (don’t crash).
  const apiKey = process.env.MDBLIST_API_KEY;
  if (!apiKey) return { meta };

  // Augment from MDBList
  const mdblistUrl = `${MDBLIST_BASE}/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(id)}`;

  try {
    const mdblist = await fetchJson(mdblistUrl);
    const block = formatRatingsBlock(mdblist);
    if (block) {
      const original = meta.description || "";
      meta.description = `${block}\n\n${original}`.trim();
    }
  } catch {
    // If MDBList fails, keep Cinemeta meta
  }

  return { meta };
});

const stremioInterface = builder.getInterface();

export default async function handler(req, res) {
  try {
    await serveHTTP(stremioInterface, { req, res });
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: e?.message || String(e), stack: e?.stack || null }, null, 2));
  }
}
