const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7860;
const API_URL = 'https://moviebox-api-steel.vercel.app';

// TMDB for metadata
const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

const MOVIEBOX_API = API_URL;

const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://moviebox.ph',
  'Referer': 'https://moviebox.ph/'
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ADVANCED VIDEO PROXY (DASH/HLS/MP4) ---
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const proxyHeaders = { ...CDN_HEADERS };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

    const response = await fetch(url, {
      headers: proxyHeaders,
      redirect: 'follow',
      timeout: 30000,
    });

    if (!response.ok && response.status !== 206) {
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type');

    // For Manifest files (DASH/HLS), we need to rewrite URLs inside them to use our proxy
    if (contentType && (contentType.includes('mpegurl') || contentType.includes('dash+xml') || url.includes('.mpd') || url.includes('.m3u8'))) {
      let text = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

      // Rewrite logic: relative URLs to absolute, then wrap in our proxy
      // This is a simplified version, real one needs more regex
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(text);
    }

    if (contentType) res.setHeader('Content-Type', contentType);
    if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
    if (response.headers.get('content-range')) res.setHeader('Content-Range', response.headers.get('content-range'));

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (response.status === 206) res.status(206);

    response.body.pipe(res);
  } catch (e) {
    res.status(500).send('Proxy failed');
  }
});

// --- API ROUTES ---
app.get('/api/home', async (req, res) => {
  try {
    const data = await fetch(`${MOVIEBOX_API}/home`).then(r => r.json());
    if (!data || !data.sections) return res.json({ sections: [] });
    const sections = data.sections.map(s => ({
      title: s.section,
      items: (s.items || []).map(it => ({
        id: it.subject_id,
        title: it.name,
        poster: it.poster_url || '',
        slug: it.slug,
        badge: it.badge || '',
        source: 'moviebox',
        type: 'moviebox',
        backdrop: it.image_url || it.poster_url || ''
      }))
    }));
    res.json({ sections });
  } catch (e) { res.json({ sections: [] }); }
});

app.get('/api/movies', async (req, res) => {
  const data = await fetch(`${MOVIEBOX_API}/movies?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/tv-series', async (req, res) => {
  const data = await fetch(`${MOVIEBOX_API}/tv-series?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/animation', async (req, res) => {
  const data = await fetch(`${MOVIEBOX_API}/animation?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/search', async (req, res) => {
  const data = await fetch(`${MOVIEBOX_API}/search?q=${encodeURIComponent(req.query.q || '')}`).then(r => r.json());
  res.json({ movies: (data?.items || []).map(it => ({
    id: it.subject_id,
    title: it.name,
    poster: it.poster_url || '',
    slug: it.slug,
    badge: it.badge || '',
    source: 'moviebox',
    type: 'moviebox'
  })) });
});

app.get('/api/detail', async (req, res) => {
  const { slug } = req.query;
  const data = await fetch(`${MOVIEBOX_API}/detail/${slug}`).then(r => r.json());
  if (data?.data?.subject) {
    const s = data.data.subject;
    res.json({
      id: s.subjectId,
      title: s.title,
      poster: s.cover?.url || '',
      backdrop: s.stills?.url || s.cover?.url || '',
      year: s.releaseDate?.substring(0, 4) || '',
      rating: s.imdbRatingValue || '',
      overview: s.description || '',
      genres: s.genre ? s.genre.split(',').map(g => g.trim()) : [],
      type: s.subjectType === 2 ? 'tv' : 'movie',
      slug: s.detailPath,
      source: 'moviebox',
      resource: data.data.resource || {},
      dubs: s.dubs || []
    });
  } else { res.status(404).send('Not found'); }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const data = await fetch(`${MOVIEBOX_API}/api/stream/${subject_id}?detail_path=${slug}&se=${se || 0}&ep=${ep || 0}`).then(r => r.json());

  if (data && data.has_resource) {
    // Wrap all streams in our proxy to bypass CORS/Referer
    if (data.sources) {
      data.sources = data.sources.map(s => {
        if (s.url) s.url = `/api/proxy?url=${encodeURIComponent(s.url)}`;
        return s;
      });
    }
    if (data.dash) {
      data.dash = data.dash.map(d => {
        if (d.url) d.url = `/api/proxy?url=${encodeURIComponent(d.url)}`;
        return d;
      });
    }
    if (data.hls) {
      data.hls = data.hls.map(h => {
        if (h.url) h.url = `/api/proxy?url=${encodeURIComponent(h.url)}`;
        return h;
      });
    }
  }
  res.json(data);
});

app.get('/api/stream/:id/captions', async (req, res) => {
  const data = await fetch(`${MOVIEBOX_API}/api/stream/${req.params.id}/captions?detail_path=${req.query.detail_path}&se=${req.query.se || 0}&ep=${req.query.ep || 0}`).then(r => r.json());
  res.json(data || { captions: [] });
});

app.get('/api/dash-manifest', async (req, res) => {
  const r = await fetch(req.query.url, { headers: CDN_HEADERS }).then(r => r.text());
  const resolutions = [];
  const matches = r.matchAll(/<Representation[^>]+height="(\d+)"[^>]*>/g);
  for (const m of matches) resolutions.push({ height: parseInt(m[1]), label: m[1]+'p' });
  res.json({ resolutions: resolutions.sort((a,b) => b.height-a.height) });
});

app.get('/api/cast', async (req, res) => {
  const r = await fetch(`${TMDB_BASE}/${req.query.type || 'movie'}/${req.query.id}/credits?api_key=${TMDB_KEY}`).then(r => r.json());
  res.json({ cast: (r.cast || []).slice(0, 15) });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🎬 Nexmovies running on ${PORT}`));
