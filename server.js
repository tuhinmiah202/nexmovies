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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Moviebox-API helpers ---
async function movieboxFetch(endpoint) {
  const base = MOVIEBOX_API.replace(/\/api$/, '').replace(/\/$/, '');
  const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  // Try both /api/endpoint and /endpoint
  const urls = [
    `${base}/api${cleanPath}`,
    `${base}${cleanPath}`
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  };

  for (const url of urls) {
    try {
      console.log(`[Moviebox-API] Fetching: ${url}`);
      const res = await fetch(url, { headers, timeout: 15000 });
      if (res.ok) {
        const json = await res.json();
        if (json) return json;
      }
    } catch (e) {
      console.warn(`[Moviebox-API] Failed ${url}: ${e.message}`);
    }
  }
  return null;
}

function formatMovieboxItem(item) {
  if (!item) return null;
  // Deep search for fields
  const id = item.subject_id || item.id || item.subjectId || item.movieId || item._id || '';
  const title = item.name || item.title || item.titleName || item.movieName || item.label || 'Untitled';
  const poster = item.poster_url || item.poster || (item.cover && item.cover.url) || item.image_url || item.thumb || item.img || item.image || '';
  const slug = item.slug || item.detail_path || item.detailPath || item.path || '';

  if (!title && !id) return null;

  return {
    id: id,
    title: title,
    poster: poster,
    backdrop: item.image_url || item.backdrop || (item.stills && item.stills.url) || poster || '',
    slug: slug,
    badge: item.badge || item.corner || item.tag || '',
    year: item.year || (item.releaseDate ? String(item.releaseDate).substring(0, 4) : ''),
    rating: item.rating || item.imdbRatingValue || item.imdb || null,
    source: 'moviebox',
    type: 'moviebox',
    language: item.language || item.lang || item.locale || '',
  };
}

function extractItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  // Common wrappers
  const root = data.data || data.items || data.list || data.results || data.movies || data.subjects || data;
  if (Array.isArray(root)) return root;

  // If it's an object, look for any array property
  if (typeof root === 'object') {
    for (const key in root) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  return [];
}

// --- API Routes ---

app.get('/api/home', async (req, res) => {
  const data = await movieboxFetch('/home');
  let sections = [];

  const parsed = (data && data.data) || data;
  if (parsed && parsed.sections && Array.isArray(parsed.sections)) {
    sections = parsed.sections.map(s => ({
      title: s.section || s.title || 'Trending',
      items: extractItems(s).map(formatMovieboxItem).filter(Boolean)
    })).filter(s => s.items.length > 0);
  }

  if (sections.length === 0) {
    const items = extractItems(data);
    if (items.length > 0) {
      sections = [{ title: 'Trending Now', items: items.map(formatMovieboxItem).filter(Boolean) }];
    }
  }

  // Fallback to TMDB Trending if Moviebox API returns nothing
  if (sections.length === 0) {
    console.log('[Moviebox-API] No data from primary API, falling back to TMDB');
    const TMDB_KEY = '2dca580c2a14b55200e784d157207b4d';
    try {
      const tmdbRes = await fetch(`https://api.themoviedb.org/3/trending/all/week?api_key=${TMDB_KEY}`);
      const tmdbData = await tmdbRes.json();
      if (tmdbData.results) {
        sections = [{
          title: 'Popular Right Now',
          items: tmdbData.results.slice(0, 20).map(m => ({
            id: m.id,
            title: m.title || m.name,
            poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : '',
            type: m.title ? 'movie' : 'tv',
            source: 'tmdb'
          }))
        }];
      }
    } catch (e) {}
  }

  res.json({ sections });
});

app.get('/api/movies', async (req, res) => {
  const page = req.query.page || 1;
  const data = await movieboxFetch(`/movies?page=${page}`);
  res.json({ page, items: extractItems(data).map(formatMovieboxItem).filter(Boolean) });
});

app.get('/api/tv-series', async (req, res) => {
  const page = req.query.page || 1;
  const data = await movieboxFetch(`/tv-series?page=${page}`);
  res.json({ page, items: extractItems(data).map(formatMovieboxItem).filter(Boolean) });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ movies: [], total: 0 });
  const data = await movieboxFetch(`/search?q=${encodeURIComponent(q)}`);
  const items = extractItems(data).map(formatMovieboxItem).filter(Boolean);
  res.json({ movies: items, total: items.length });
});

// Basic details and streaming stubs for compatibility
app.get('/api/detail', async (req, res) => {
  const { slug } = req.query;
  const data = await movieboxFetch(`/detail/${slug}`);
  const root = (data && data.data) || data;
  const s = root.subject || root;
  if (s) {
    res.json({
      ...formatMovieboxItem(s),
      overview: s.description || s.overview || '',
      resource: root.resource || {},
      dubs: s.dubs || [],
      hasResource: s.hasResource || true
    });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const data = await movieboxFetch(`/stream/${subject_id}?detail_path=${slug}&se=${se || 1}&ep=${ep || 1}`);
  res.json(data || { error: 'Stream not found' });
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 MovieBox Server running on port ${PORT}`);
  console.log(`📡 Backend API: ${MOVIEBOX_API}`);
});
