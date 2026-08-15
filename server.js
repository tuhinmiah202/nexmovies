const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const API_URL = process.env.API_URL || 'https://moviebox-api-steel.vercel.app';
const MOVIEBOX_API = API_URL;

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://moviebox.ph/',
  'Origin': 'https://moviebox.ph',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const MB_API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const MB_PLAYER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'X-Client-Info': '{"timezone":"Asia/Dhaka"}',
};

let mbSession = { ts: 0, domain: null, token: null };
async function mbGetSession(forceRefresh = false) {
  if (!forceRefresh && mbSession.domain && Date.now() - mbSession.ts < 10 * 60 * 1000) return mbSession;
  try {
    const res = await fetch(`${MB_API_BASE}/media-player/get-domain`, { headers: CDN_HEADERS, timeout: 10000 });
    const json = await res.json();
    const domain = String(json.data || 'https://netfilm.world/').replace(/\/+$/, '');
    let token = null;
    const xUser = res.headers.get('x-user');
    if (xUser) try { token = JSON.parse(xUser).token; } catch (e) {}
    if (!token) {
      const cookie = res.headers.get('set-cookie') || '';
      const m = cookie.match(/token=([^;]+)/);
      if (m) token = m[1];
    }
    mbSession = { ts: Date.now(), domain, token: token || mbSession.token };
    return mbSession;
  } catch (e) { return mbSession; }
}

async function mbFetchPlay(subjectId, slug, se, ep, forceRefresh = false) {
  const { domain, token } = await mbGetSession(forceRefresh);
  const referer = `${domain}/spa/videoPlayPage/movies/${slug}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const url = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(slug)}`;
  const headers = { ...MB_PLAYER_HEADERS, 'Referer': referer };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: 'follow', timeout: 20000 });
  const json = await res.json();
  let data = json.data || {};
  if (!forceRefresh && !data.hasResource && !(data.streams || []).length) return await mbFetchPlay(subjectId, slug, se, ep, true);
  return data;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

async function movieboxFetch(endpoint) {
  const base = MOVIEBOX_API.replace(/\/api$/, '').replace(/\/$/, '');
  const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const urls = [`${base}/api${cleanPath}`, `${base}${cleanPath}`];
  for (const url of urls) {
    try {
      console.log(`[Moviebox-API] Fetching: ${url}`);
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 15000 });
      if (res.ok) return await res.json();
    } catch (e) { console.warn(`[Moviebox-API] Failed ${url}: ${e.message}`); }
  }
  return null;
}

function formatMovieboxItem(item) {
  if (!item) return null;
  const id = item.subject_id || item.id || item.subjectId || '';
  const title = item.name || item.title || 'Untitled';
  const poster = item.poster_url || item.poster || (item.cover && item.cover.url) || item.image_url || '';
  const slug = item.slug || item.detail_path || item.detailPath || '';
  return { id, title, poster, slug, backdrop: item.image_url || item.backdrop || poster || '', badge: item.badge || item.corner || '', year: item.year || (item.releaseDate ? String(item.releaseDate).substring(0, 4) : ''), rating: item.rating || item.imdbRatingValue || null, source: 'moviebox', type: 'moviebox' };
}

function extractItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const root = data.data || data.items || data.list || data.results || data.movies || data;
  if (Array.isArray(root)) return root;
  if (typeof root === 'object') for (const key in root) if (Array.isArray(root[key])) return root[key];
  return [];
}

const ALLOWED_PROXY_HOSTS = [
  'bcdnxw.hakunaymatata.com', 'sbcdnw.hakunaymatata.com', 'sacdn.hakunaymatata.com', 'cacdn.hakunaymatata.com',
  'netfilm.world', 'moviebox.ph', 'image.tmdb.org', 'pbcdnw.aoneroom.com', 'pbcdn.aoneroom.com',
  'macdn.aoneroom.com', 'h5-api.aoneroom.com', 'moviebox-api-steel.vercel.app'
];

app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const host = new URL(url).hostname;
    if (!ALLOWED_PROXY_HOSTS.some(h => host === h || host.endsWith('.' + h))) return res.status(403).send('Host not allowed');
    const proxyHeaders = { ...CDN_HEADERS };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;
    const response = await fetch(url, { headers: proxyHeaders, redirect: 'follow', timeout: 30000 });
    const headers = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    headers.forEach(h => { if (response.headers.get(h)) res.setHeader(h, response.headers.get(h)); });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (response.status === 206) res.status(206);
    response.body.pipe(res);
  } catch (e) { res.status(500).send('Proxy failed'); }
});

app.get('/api/home', async (req, res) => {
  const data = await movieboxFetch('/home');
  const root = (data && data.data) || data;
  let sections = [];
  if (root && root.sections && Array.isArray(root.sections)) {
    sections = root.sections.map(s => ({ title: s.section || s.title || 'Trending', items: extractItems(s).map(formatMovieboxItem).filter(Boolean) })).filter(s => s.items.length > 0);
  }
  if (sections.length === 0) {
    const items = extractItems(data);
    if (items.length > 0) sections = [{ title: 'Trending Now', items: items.map(formatMovieboxItem).filter(Boolean) }];
  }
  if (sections.length === 0) {
    try {
      const tmdbRes = await fetch(`${TMDB_BASE}/trending/all/week?api_key=${TMDB_KEY}`);
      const tmdbData = await tmdbRes.json();
      if (tmdbData.results) sections = [{ title: 'Popular Right Now', items: tmdbData.results.slice(0, 20).map(m => ({ id: m.id, title: m.title || m.name, poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : '', source: 'tmdb' })) }];
    } catch (e) {}
  }
  res.json({ sections });
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const season = se || 0; const episode = ep || 0;
  try {
    const play = await mbFetchPlay(subject_id, slug, season, episode);
    const sources = (play.streams || []).map(s => ({ resolution: `${s.resolutions}p`, format: s.format, url: s.url, size: s.size }));
    if (sources.length || (play.dash || []).length) {
      return res.json({ subject_id, se: season, ep: episode, has_resource: true, sources, dash: play.dash || [], hls: play.hls || [] });
    }
  } catch (e) { console.error('Direct stream error:', e.message); }
  const data = await movieboxFetch(`/stream/${subject_id}?detail_path=${slug}&se=${season}&ep=${episode}`);
  res.json(data || { error: 'Stream failed' });
});

app.get('/api/detail', async (req, res) => {
  const { id, slug, source } = req.query;
  if (source === 'moviebox' && slug) {
    const data = await movieboxFetch(`/detail/${slug}`);
    const root = (data && data.data) || data;
    const s = root.subject || root;
    if (s) return res.json({ ...formatMovieboxItem(s), overview: s.description || s.overview || '', genres: s.genre ? s.genre.split(',') : [], ratingCount: s.imdbRatingCount || 0, country: s.countryName || '', corner: s.corner || '', resource: root.resource || {}, dubs: s.dubs || [], trailer: s.trailer?.videoAddress?.url || '', hasResource: s.hasResource || true });
  }
  const tmdb = await fetch(`${TMDB_BASE}/movie/${id}?api_key=${TMDB_KEY}`).then(r => r.json());
  res.json({ id: tmdb.id, title: tmdb.title || tmdb.name, poster: tmdb.poster_path ? TMDB_IMG + tmdb.poster_path : '', backdrop: tmdb.backdrop_path ? TMDB_IMG + tmdb.backdrop_path : '', year: (tmdb.release_date || '').substring(0, 4), rating: tmdb.vote_average, overview: tmdb.overview, genres: (tmdb.genres || []).map(g => g.name), source: 'tmdb' });
});

app.get('/api/movies', async (req, res) => {
  const data = await movieboxFetch(`/movies?page=${req.query.page || 1}`);
  res.json({ items: extractItems(data).map(formatMovieboxItem).filter(Boolean) });
});

app.get('/api/tv-series', async (req, res) => {
  const data = await movieboxFetch(`/tv-series?page=${req.query.page || 1}`);
  res.json({ items: extractItems(data).map(formatMovieboxItem).filter(Boolean) });
});

app.get('/api/search', async (req, res) => {
  const data = await movieboxFetch(`/search?q=${encodeURIComponent(req.query.q)}`);
  res.json({ movies: extractItems(data).map(formatMovieboxItem).filter(Boolean) });
});

app.get('/api/cast', async (req, res) => {
  const tmdb = await fetch(`${TMDB_BASE}/movie/${req.query.id}/credits?api_key=${TMDB_KEY}`).then(r => r.json());
  res.json({ cast: (tmdb.cast || []).slice(0, 20) });
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🎬 MovieBox on port ${PORT}`));
