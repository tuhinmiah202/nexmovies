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

const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://moviebox.ph',
  'Referer': 'https://moviebox.ph/'
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ADVANCED PROXY WITH MANIFEST REWRITING ---
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

    const contentType = response.headers.get('content-type') || '';
    const isM3U8 = url.includes('.m3u8') || contentType.includes('mpegurl');
    const isMPD = url.includes('.mpd') || contentType.includes('dash+xml');

    // Handle HLS (.m3u8) Rewriting
    if (isM3U8) {
      let text = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const lines = text.split('\n');
      const rewritten = lines.map(line => {
        if (!line.trim() || line.startsWith('#')) return line;
        const absolute = line.startsWith('http') ? line : new URL(line, baseUrl).href;
        return `/api/proxy?url=${encodeURIComponent(absolute)}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    // Handle DASH (.mpd) Rewriting
    if (isMPD) {
      let text = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

      // Inject BaseURL to point to our proxy
      // This forces the player to fetch all segments through our proxy
      const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(baseUrl)}`;

      if (text.includes('<BaseURL>')) {
        text = text.replace(/<BaseURL>.*?<\/BaseURL>/g, `<BaseURL>${proxyBase}</BaseURL>`);
      } else {
        text = text.replace('<Period', `<BaseURL>${proxyBase}</BaseURL><Period`);
      }

      res.setHeader('Content-Type', 'application/dash+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(text);
    }

    // Regular video/binary stream
    if (contentType) res.setHeader('Content-Type', contentType);
    ['content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

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
    const data = await fetch(`${API_URL}/home`).then(r => r.json());
    const sections = (data.sections || []).map(s => ({
      title: s.section,
      items: (s.items || []).map(it => ({
        id: it.subject_id,
        title: it.name,
        poster: it.poster_url || '',
        slug: it.slug,
        badge: it.badge || '',
        source: 'moviebox',
        type: it.subject_type === 2 ? 'tv' : 'movie',
        backdrop: it.image_url || it.poster_url || ''
      }))
    }));
    res.json({ sections });
  } catch (e) { res.json({ sections: [] }); }
});

app.get('/api/movies', async (req, res) => {
  const data = await fetch(`${API_URL}/movies?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/tv-series', async (req, res) => {
  const data = await fetch(`${API_URL}/tv-series?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/animation', async (req, res) => {
  const data = await fetch(`${API_URL}/animation?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/ranking', async (req, res) => {
  const data = await fetch(`${API_URL}/ranking?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/top-imdb', async (req, res) => {
  const data = await fetch(`${API_URL}/top-imdb?page=${req.query.page || 1}`).then(r => r.json());
  res.json({ items: data?.items || [] });
});

app.get('/api/search', async (req, res) => {
  const data = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q || '')}`).then(r => r.json());
  res.json({ movies: (data?.items || []).map(it => ({
    id: it.subject_id,
    title: it.name,
    poster: it.poster_url || '',
    slug: it.slug,
    badge: it.badge || '',
    source: 'moviebox',
    type: it.subject_type === 2 ? 'tv' : 'movie'
  })) });
});

app.get('/api/detail', async (req, res) => {
  const { slug } = req.query;
  try {
    const data = await fetch(`${API_URL}/detail/${slug}`).then(r => r.json());
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
  } catch(e) { res.status(500).send(e.message); }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  // Use se=0, ep=0 for movies to match API preference
  const s = se || 0;
  const e = ep || 0;

  try {
    const data = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${slug}&se=${s}&ep=${e}`).then(r => r.json());
    if (data && data.has_resource) {
      // Wrap main manifest/video URLs in proxy
      if (data.sources) data.sources.forEach(src => { if (src.url) src.url = `/api/proxy?url=${encodeURIComponent(src.url)}`; });
      if (data.dash) data.dash.forEach(d => { if (d.url) d.url = `/api/proxy?url=${encodeURIComponent(d.url)}`; });
      if (data.hls) data.hls.forEach(h => { if (h.url) h.url = `/api/proxy?url=${encodeURIComponent(h.url)}`; });
      return res.json(data);
    }
    res.status(404).json({ error: 'No stream' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stream/:id/captions', async (req, res) => {
  const data = await fetch(`${API_URL}/api/stream/${req.params.id}/captions?detail_path=${req.query.detail_path}&se=${req.query.se || 0}&ep=${req.query.ep || 0}`).then(r => r.json());
  res.json(data || { captions: [] });
});

app.get('/api/dash-manifest', async (req, res) => {
  try {
    const r = await fetch(req.query.url, { headers: CDN_HEADERS }).then(r => r.text());
    const resolutions = [];
    const matches = r.matchAll(/<Representation[^>]+height="(\d+)"[^>]*>/g);
    for (const m of matches) resolutions.push({ height: parseInt(m[1]), label: m[1]+'p' });
    res.json({ resolutions: resolutions.sort((a,b) => b.height-a.height) });
  } catch(e) { res.status(500).send(e.message); }
});

app.get('/api/cast', async (req, res) => {
  try {
    const r = await fetch(`${TMDB_BASE}/${req.query.type || 'movie'}/${req.query.id}/credits?api_key=${TMDB_KEY}`).then(r => r.json());
    res.json({ cast: (r.cast || []).slice(0, 15) });
  } catch(e) { res.json({ cast: [] }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🎬 Nexmovies running on ${PORT}`));
