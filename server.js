const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7860;
const API_URL = 'https://moviebox-api-steel.vercel.app';

const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://moviebox.ph',
  'Referer': 'https://moviebox.ph/',
  'X-Client-Info': '{"timezone":"Asia/Dhaka"}'
};

// --- DIRECT MB RESOLVER (Fly.io IP is not blocked) ---
async function mbGetPlay(subjectId, slug, se, ep) {
  try {
    const url = `https://netfilm.world/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { headers: CDN_HEADERS, timeout: 15000 });
    const json = await res.json();
    return json.data || null;
  } catch (e) { return null; }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- PRODUCTION GRADE PROXY ---
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const proxyHeaders = { ...CDN_HEADERS };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;
    const response = await fetch(url, { headers: proxyHeaders, redirect: 'follow', timeout: 30000 });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    if (response.headers.get('content-type')) res.setHeader('Content-Type', response.headers.get('content-type'));
    if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
    if (response.headers.get('content-range')) res.setHeader('Content-Range', response.headers.get('content-range'));
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.status === 206) res.status(206);
    response.body.pipe(res);
  } catch (e) { res.status(500).send('Proxy error'); }
});

// --- API ROUTES ---
app.get('/api/home', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/home`).then(r => r.json());
    res.json({ sections: (data.sections || []).map(s => ({
      title: s.section,
      items: (s.items || []).map(it => ({
        id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, badge: it.badge, source: 'nexmovies', type: it.subject_type === 2 ? 'tv' : 'movie', backdrop: it.image_url || it.poster_url
      }))
    })) });
  } catch (e) { res.json({ sections: [] }); }
});

app.get('/api/detail', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/detail/${req.query.slug}`).then(r => r.json());
    const s = data?.data?.subject;
    if (!s) return res.status(404).send('Not found');
    res.json({
      id: s.subjectId, title: s.title, poster: s.cover?.url, backdrop: s.stills?.url || s.cover?.url,
      year: s.releaseDate?.substring(0,4), rating: s.imdbRatingValue, overview: s.description,
      genres: s.genre ? s.genre.split(',').map(g=>g.trim()) : [], type: s.subjectType === 2 ? 'tv' : 'movie',
      slug: s.detailPath, source: 'nexmovies', resource: data.data.resource || {}, dubs: s.dubs || []
    });
  } catch (e) { res.status(500).send('Error'); }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const s = se !== undefined ? parseInt(se) : 0;
  const e = ep !== undefined ? parseInt(ep) : 0;

  try {
    // 1. Resolve directly on Fly.io (bypass Vercel Block)
    const play = await mbGetPlay(subject_id, slug, s, e);
    if (play && (play.streams || play.dash)) {
      const host = `${req.get('x-forwarded-proto') || 'https'}://${req.get('host')}`;
      const sources = (play.streams || []).map(src => ({ ...src, url: `${host}/api/proxy?url=${encodeURIComponent(src.url)}`, resolution: src.resolutions + 'p' }));
      const dash = (play.dash || []).map(d => ({ ...d, url: `${host}/api/proxy?url=${encodeURIComponent(d.url)}` }));
      return res.json({ subject_id, se: s, ep: e, has_resource: true, sources, dash, hls: play.hls || [] });
    }
  } catch (err) {}

  // 2. Fallback to your Vercel API
  try {
    const r = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${slug}&se=${s}&ep=${e}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.status(502).json({ error: 'Failed' }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q)}`).then(r => r.json());
    res.json({ movies: (data?.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'nexmovies' })) });
  } catch(e) { res.json({ movies: [] }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexmovies Engine Ready on ${PORT}`));
