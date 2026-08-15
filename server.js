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

// CDN proxy headers
const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Referer': 'https://moviebox.ph/',
  'Origin': 'https://moviebox.ph',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const MB_API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const MB_PLAYER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'X-Client-Info': '{"timezone":"Asia/Dhaka"}',
};

let mbSession = { ts: 0, domain: null, token: null };
async function mbGetSession(forceRefresh = false) {
  if (!forceRefresh && mbSession.domain && Date.now() - mbSession.ts < 10 * 60 * 1000) {
    return mbSession;
  }
  try {
    const res = await fetch(`${MB_API_BASE}/media-player/get-domain`, { headers: { ...CDN_HEADERS, 'Accept': 'application/json' }, timeout: 10000 });
    const data = await res.json();
    const domain = String(data.data || 'https://netfilm.world/').replace(/\/+$/, '');
    let token = null;
    const xUser = res.headers.get('x-user');
    if (xUser) try { token = JSON.parse(xUser).token || null; } catch (e) {}
    if (!token) {
      const cookie = res.headers.get('set-cookie') || '';
      const m = cookie.match(/token=([^;]+)/);
      if (m) token = m[1];
    }
    mbSession = { ts: Date.now(), domain, token: token || mbSession.token };
    return mbSession;
  } catch (e) {
    console.error('Session error:', e.message);
    return mbSession;
  }
}

async function mbFetchPlay(subjectId, slug, se, ep, forceRefresh = false) {
  const { domain, token } = await mbGetSession(forceRefresh);
  const referer = `${domain}/spa/videoPlayPage/movies/${slug}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const url = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(slug)}`;
  const headers = { ...MB_PLAYER_HEADERS, 'Referer': referer };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: 'follow', timeout: 20000 });
  if (!res.ok) throw new Error(`play fetch ${res.status}`);
  const json = await res.json();
  let data = json.data || {};
  if (!forceRefresh && !data.hasResource && !(data.streams || []).length) {
    data = await mbFetchPlay(subjectId, slug, se, ep, true);
  }
  return data;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health check for Fly.io
app.get('/health', (req, res) => res.status(200).send('OK'));

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
    if (!response.ok && response.status !== 206) return res.status(response.status).send(`Upstream error: ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    const contentRange = response.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (response.status === 206) res.status(206);
    response.body.pipe(res);
  } catch (e) { res.status(500).send('Proxy failed'); }
});

app.get('/api/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const host = new URL(url).hostname;
    if (!ALLOWED_PROXY_HOSTS.some(h => host === h || host.endsWith('.' + h))) return res.status(403).send('Host not allowed');
    const response = await fetch(url, { headers: CDN_HEADERS, redirect: 'follow', timeout: 60000 });
    if (!response.ok) return res.status(response.status).send(`Upstream error: ${response.status}`);
    const cleanTitle = (title || 'download').replace(/[^\w\s\-]/g, '').replace(/\s+/g, '_').substring(0, 80);
    const contentType = response.headers.get('content-type') || 'video/mp4';
    const ext = contentType.includes('mp4') ? '.mp4' : contentType.includes('webm') ? '.webm' : '.mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}${ext}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.body.pipe(res);
  } catch (e) { res.status(500).send('Download failed'); }
});

let FFMPEG_PATH = null;
try { FFMPEG_PATH = require('ffmpeg-static'); } catch (e) {}
const transcodeSessions = new Map();

app.get('/api/transcode/status', (req, res) => res.json({ ffmpeg: !!FFMPEG_PATH, sessions: transcodeSessions.size }));

// --- Moviebox-API helpers ---
async function movieboxFetch(endpoint) {
  const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${MOVIEBOX_API}/api${cleanPath}`;
  try {
    console.log(`[Moviebox-API] Fetching: ${url}`);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 15000 });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`[Moviebox-API] Failed: ${url} - ${e.message}`);
    return null;
  }
}

function formatMovieboxItem(item) {
  if (!item) return null;
  const id = item.subject_id || item.id || item.subjectId || '';
  const title = item.name || item.title || 'Untitled';
  const poster = item.poster_url || item.poster || (item.cover && item.cover.url) || item.image_url || '';
  const slug = item.slug || item.detail_path || item.detailPath || '';
  if (!title && !id) return null;
  return {
    id, title, poster, slug,
    backdrop: item.image_url || item.backdrop || poster || '',
    badge: item.badge || item.corner || '',
    year: item.year || (item.releaseDate ? item.releaseDate.substring(0, 4) : ''),
    rating: item.rating || item.imdbRatingValue || null,
    source: 'moviebox', type: 'moviebox',
    language: item.language || item.lang || '',
  };
}

function processMovieboxResponse(data) {
  if (!data) return [];
  const root = data.data || data.items || data.list || data.results || (Array.isArray(data) ? data : null);
  if (Array.isArray(root)) return root.map(formatMovieboxItem).filter(Boolean);
  if (root && typeof root === 'object') {
    if (root.sections) return root.sections;
    for (const key in root) if (Array.isArray(root[key])) return root[key].map(formatMovieboxItem).filter(Boolean);
  }
  return [];
}

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

async function tmdbFetch(endpoint, params = {}) {
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  url.searchParams.set('api_key', TMDB_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString());
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}

function formatTmdbMovie(item, type) {
  return {
    id: item.id,
    title: item.title || item.name || 'Untitled',
    poster: item.poster_path ? TMDB_IMG + item.poster_path : '',
    backdrop: item.backdrop_path ? TMDB_IMG + item.backdrop_path : '',
    year: (item.release_date || item.first_air_date || '').substring(0, 4) || 'N/A',
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
    type: type || (item.title ? 'movie' : 'tv'),
    source: 'tmdb',
  };
}

app.get('/api/home', async (req, res) => {
  const data = await movieboxFetch('/home');
  const root = (data && data.data) || data;
  let sections = [];
  if (root && root.sections && Array.isArray(root.sections)) {
    sections = root.sections.filter(s => s && (s.items || s.list)).map(s => ({
      title: s.section || s.title || 'Trending',
      items: (s.items || s.list).map(formatMovieboxItem).filter(Boolean)
    }));
  }
  if (sections.length === 0) {
    const items = processMovieboxResponse(data);
    if (items.length > 0) sections = [{ title: 'Trending Now', items: items.slice(0, 40) }];
  }
  if (sections.length === 0) {
    const tmdb = await tmdbFetch('/trending/all/week');
    if (tmdb && tmdb.results) sections = [{ title: 'Popular Right Now', items: tmdb.results.slice(0, 20).map(m => formatTmdbMovie(m)) }];
  }
  res.json({ sections });
});

app.get('/api/trending', async (req, res) => {
  const data = await movieboxFetch('/home');
  const items = processMovieboxResponse(data);
  if (items.length > 0) return res.json({ movies: items.slice(0, 40), total: items.length });
  const tmdb = await tmdbFetch('/trending/all/week');
  const movies = (tmdb?.results || []).map(m => formatTmdbMovie(m));
  res.json({ movies, total: movies.length });
});

app.get('/api/movies', async (req, res) => {
  const page = req.query.page || 1;
  const data = await movieboxFetch(`/movies?page=${page}`);
  res.json({ page, items: processMovieboxResponse(data) });
});

app.get('/api/tv-series', async (req, res) => {
  const page = req.query.page || 1;
  const data = await movieboxFetch(`/tv-series?page=${page}`);
  res.json({ page, items: processMovieboxResponse(data) });
});

app.get('/api/animation', async (req, res) => {
  const page = req.query.page || 1;
  const data = await movieboxFetch(`/animation?page=${page}`);
  res.json({ page, items: processMovieboxResponse(data) });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ movies: [], total: 0 });
  const data = await movieboxFetch(`/search?q=${encodeURIComponent(q)}`);
  const items = processMovieboxResponse(data);
  if (items.length > 0) return res.json({ movies: items, total: items.length });
  const tmdb = await tmdbFetch('/search/multi', { query: q });
  const movies = (tmdb?.results || []).filter(r => r.media_type !== 'person').map(m => formatTmdbMovie(m, m.media_type));
  res.json({ movies, total: movies.length });
});

app.get('/api/detail', async (req, res) => {
  const { type, id, slug, source } = req.query;
  if (source === 'moviebox' && slug) {
    const data = await movieboxFetch(`/detail/${slug}`);
    const s = data?.data?.subject;
    if (s) {
      return res.json({
        id: s.subjectId || id, title: s.title || 'Untitled',
        poster: s.cover?.url || '', backdrop: s.stills?.url || s.cover?.url || '',
        year: s.releaseDate ? s.releaseDate.substring(0, 4) : '',
        rating: s.imdbRatingValue || '', overview: s.description || '',
        type: s.subjectType === 2 ? 'tv' : 'movie', slug: s.detailPath || slug,
        source: 'moviebox', hasResource: s.hasResource || false,
        resource: data.data.resource || {}, dubs: s.dubs || [], trailer: s.trailer?.videoAddress?.url || '',
      });
    }
  }
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/${mediaType}/${id}`);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(formatTmdbMovie(data, mediaType));
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const season = se || 1; const episode = ep || 1;
  try {
    const play = await mbFetchPlay(subject_id, slug, season, episode);
    const sources = (play.streams || []).map(s => ({ resolution: `${s.resolutions}p`, format: s.format, url: s.url }));
    if (sources.length || (play.dash || []).length) {
      return res.json({ subject_id, se: season, ep: episode, has_resource: true, sources, hls: play.hls || [], dash: play.dash || [] });
    }
  } catch (e) {}
  const data = await movieboxFetch(`/stream/${subject_id}?detail_path=${slug}&se=${season}&ep=${episode}`);
  res.json(data || { error: 'Stream failed' });
});

app.get('/api/stream/:subject_id/captions', async (req, res) => {
  const { subject_id } = req.params; const { detail_path, se, ep } = req.query;
  try {
    const play = await mbFetchPlay(subject_id, detail_path, se || 1, ep || 1);
    const streamId = (play.streams && play.streams[0]?.id) || (play.dash && play.dash[0]?.id);
    if (streamId) {
      const { token } = await mbGetSession();
      const capRes = await fetch(`${MB_API_BASE}/subject/caption?id=${streamId}&subjectId=${subject_id}&detailPath=${encodeURIComponent(detail_path)}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const capData = await capRes.json();
      return res.json({ subject_id, captions: capData.data?.captions || [] });
    }
  } catch (e) {}
  const data = await movieboxFetch(`/stream/${subject_id}/captions?detail_path=${encodeURIComponent(detail_path)}&se=${se || 1}&ep=${ep || 1}`);
  res.json(data || { captions: [] });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Server running at http://0.0.0.0:${PORT}`);
  console.log(`📡 API: ${MOVIEBOX_API}`);
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
