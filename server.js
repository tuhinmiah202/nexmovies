const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
// Fly.io usually expects 8080 or uses the PORT env variable
const PORT = process.env.PORT || 8080;
const API_URL = 'https://moviebox-api-steel.vercel.app';

const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://moviebox.ph',
  'Referer': 'https://moviebox.ph/'
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- STABLE VIDEO PROXY ---
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
  } catch (e) {
    res.status(500).send('Proxy failed');
  }
});

// --- API ROUTES ---
app.get('/api/home', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/home`).then(res => res.json());
    res.json({ sections: (r.sections || []).map(s => ({
      title: s.section,
      items: (s.items || []).map(it => ({
        id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, badge: it.badge, source: 'nexmovies', type: it.subject_type === 2 ? 'tv' : 'movie', backdrop: it.image_url || it.poster_url
      }))
    })) });
  } catch (e) { res.json({ sections: [] }); }
});

app.get('/api/detail', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/detail/${req.query.slug}`).then(res => res.json());
    const s = r?.data?.subject;
    if (!s) return res.status(404).send('Not found');
    res.json({
      id: s.subjectId, title: s.title, poster: s.cover?.url, backdrop: s.stills?.url || s.cover?.url,
      year: s.releaseDate?.substring(0,4), rating: s.imdbRatingValue, overview: s.description,
      genres: s.genre ? s.genre.split(',').map(g=>g.trim()) : [], type: s.subjectType === 2 ? 'tv' : 'movie',
      slug: s.detailPath, source: 'nexmovies', resource: r.data.resource || {}, dubs: s.dubs || []
    });
  } catch (e) { res.status(500).send('Error'); }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const s = se !== undefined ? parseInt(se) : 0;
  const e = ep !== undefined ? parseInt(ep) : 0;

  try {
    // 1. Try Resolving directly on Fly.io using its IP
    const directUrl = `https://netfilm.world/wefeed-h5api-bff/subject/play?subjectId=${subject_id}&se=${s || 1}&ep=${e || 1}&detailPath=${encodeURIComponent(slug)}`;
    const directRes = await fetch(directUrl, { headers: CDN_HEADERS, timeout: 10000 });
    const directData = await directRes.json();

    if (directData && directData.data && (directData.data.streams || directData.data.dash)) {
      const play = directData.data;
      const host = `${req.protocol}://${req.get('host')}`;
      const sources = (play.streams || []).map(src => ({ ...src, url: `${host}/api/proxy?url=${encodeURIComponent(src.url)}`, resolution: src.resolutions + 'p' }));
      const dash = (play.dash || []).map(d => ({ ...d, url: `${host}/api/proxy?url=${encodeURIComponent(d.url)}` }));
      return res.json({ subject_id, se: s, ep: e, has_resource: true, sources, dash, hls: play.hls || [] });
    }
  } catch (err) {}

  // 2. Fallback to Vercel API
  try {
    const response = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${slug}&se=${s}&ep=${e}`);
    const data = await response.json();
    if (data && data.has_resource) {
       const host = `${req.protocol}://${req.get('host')}`;
       if (data.sources) data.sources.forEach(src => { if (src.url) src.url = `${host}/api/proxy?url=${encodeURIComponent(src.url)}`; });
       if (data.dash) data.dash.forEach(d => { if (d.url) d.url = `${host}/api/proxy?url=${encodeURIComponent(d.url)}`; });
       return res.json(data);
    }
  } catch (err) {}

  res.status(404).json({ error: 'Stream not found' });
});

app.get('/api/search', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q)}`).then(res => res.json());
    res.json({ movies: (r.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'nexmovies' })) });
  } catch(e) { res.json({ movies: [] }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexmovies Engine listening on ${PORT}`));
