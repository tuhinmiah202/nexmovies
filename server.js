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

// --- PRODUCTION GRADE VIDEO PROXY ---
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const proxyHeaders = { ...CDN_HEADERS };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

    const upstreamResponse = await fetch(url, {
      headers: proxyHeaders,
      redirect: 'follow',
      timeout: 30000,
    });

    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      return res.status(upstreamResponse.status).send(`Upstream error: ${upstreamResponse.status}`);
    }

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const isM3U8 = url.includes('.m3u8') || contentType.includes('mpegurl');
    const isMPD = url.includes('.mpd') || contentType.includes('dash+xml');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    if (isM3U8 || isMPD) {
      let text = await upstreamResponse.text();
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const host = `${req.protocol}://${req.get('host')}`;

      if (isM3U8) {
        const lines = text.split('\n');
        text = lines.map(line => {
          if (!line.trim() || line.startsWith('#')) return line;
          const absolute = line.startsWith('http') ? line : new URL(line, baseUrl).href;
          return `${host}/api/proxy?url=${encodeURIComponent(absolute)}`;
        }).join('\n');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else {
        const proxyBase = `${host}/api/proxy?url=${encodeURIComponent(baseUrl)}`;
        if (text.includes('<BaseURL>')) {
          text = text.replace(/<BaseURL>.*?<\/BaseURL>/g, `<BaseURL>${proxyBase}</BaseURL>`);
        } else {
          text = text.replace('<Period', `<BaseURL>${proxyBase}</BaseURL><Period`);
        }
        res.setHeader('Content-Type', 'application/dash+xml');
      }
      return res.send(text);
    }

    if (contentType) res.setHeader('Content-Type', contentType);
    ['content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const val = upstreamResponse.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    if (upstreamResponse.status === 206) res.status(206);
    upstreamResponse.body.pipe(res);
  } catch (e) {
    res.status(500).send('Proxy failed');
  }
});

// --- API ROUTES (PURELY FROM YOUR VERCEL API) ---
app.get('/api/home', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/home`).then(r => r.json());
    res.json({ sections: (data.sections || []).map(s => ({
      title: s.section,
      items: (s.items || []).map(it => ({
        id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, badge: it.badge, source: 'moviebox', type: it.subject_type === 2 ? 'tv' : 'movie', backdrop: it.image_url || it.poster_url
      }))
    })) });
  } catch (e) { res.json({ sections: [] }); }
});

app.get('/api/detail', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/detail/${req.query.slug}`).then(r => r.json());
    if (data?.data?.subject) {
      const s = data.data.subject;
      res.json({
        id: s.subjectId, title: s.title, poster: s.cover?.url, backdrop: s.stills?.url || s.cover?.url,
        year: s.releaseDate?.substring(0,4), rating: s.imdbRatingValue, overview: s.description,
        genres: s.genre ? s.genre.split(',').map(g=>g.trim()) : [], type: s.subjectType === 2 ? 'tv' : 'movie',
        slug: s.detailPath, source: 'moviebox', resource: data.data.resource || {}, dubs: s.dubs || []
      });
    } else { res.status(404).send('Not found'); }
  } catch(e) { res.status(500).send('Error'); }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const s = se || 0;
  const e = ep || 0;
  try {
    const data = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${slug}&se=${s}&ep=${e}`).then(r => r.json());
    if (data && data.has_resource) {
      const host = `${req.protocol}://${req.get('host')}`;
      if (data.sources) data.sources.forEach(src => { if (src.url) src.url = `${host}/api/proxy?url=${encodeURIComponent(src.url)}`; });
      if (data.dash) data.dash.forEach(d => { if (d.url) d.url = `${host}/api/proxy?url=${encodeURIComponent(d.url)}`; });
      if (data.hls) data.hls.forEach(h => { if (h.url) h.url = `${host}/api/proxy?url=${encodeURIComponent(h.url)}`; });
      return res.json(data);
    }
    res.status(404).json({ error: 'No stream' });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/stream/:id/captions', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/api/stream/${req.params.id}/captions?detail_path=${req.query.detail_path}&se=${req.query.se || 0}&ep=${req.query.ep || 0}`).then(r => r.json());
    res.json(data || { captions: [] });
  } catch(e) { res.json({ captions: [] }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q)}`).then(r => r.json());
    res.json({ movies: (data?.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'moviebox' })) });
  } catch(e) { res.json({ movies: [] }); }
});

app.get('/api/cast', async (req, res) => {
  try {
    const r = await fetch(`${TMDB_BASE}/${req.query.type || 'movie'}/${req.query.id}/credits?api_key=${TMDB_KEY}`).then(r => r.json());
    res.json({ cast: (r.cast || []).slice(0, 15) });
  } catch(e) { res.json({ cast: [] }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexmovies Pure Backend Ready on ${PORT}`));
