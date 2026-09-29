const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.set('trust proxy', true); // Trust reverse proxies (Fly.io/Render) for HTTPS headers

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

// Helper to construct secure HTTPS host URL for proxy links
function getHostUrl(req) {
  const host = req.get('host') || 'localhost:8080';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isLocal ? req.protocol : 'https';
  return `${protocol}://${host}`;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- STABLE VIDEO PROXY WITH HTTPS SSL SUPPORT & DIRECT DOWNLOAD ---
app.get('/api/proxy', async (req, res) => {
  const { url, download, title, filename } = req.query;
  if (!url) return res.status(400).send('Missing url');

  const isDownload = download === '1' || !!filename || !!title;

  try {
    const proxyHeaders = { ...CDN_HEADERS };
    // Pass Range header ONLY if explicitly requested by video player (seeking) AND NOT downloading
    if (req.headers.range && !isDownload) {
      proxyHeaders['Range'] = req.headers.range;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      headers: proxyHeaders,
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok && response.status !== 206) {
      console.error(`CDN Proxy status error: ${response.status} for ${url}`);
      return res.status(response.status).send('CDN response error');
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
    res.setHeader('Accept-Ranges', 'bytes');

    if (isDownload) {
      const rawName = (filename || title || 'video').toString();
      const safeAsciiName = rawName.replace(/["\r\n\t]/g, '').replace(/[^\x20-\x7E]/g, '').trim() || 'video';
      const asciiNameWithExt = safeAsciiName.toLowerCase().endsWith('.mp4') ? safeAsciiName : `${safeAsciiName}.mp4`;
      const encodedUtf8Name = encodeURIComponent(rawName.toLowerCase().endsWith('.mp4') ? rawName : `${rawName}.mp4`);

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${asciiNameWithExt}"; filename*=UTF-8''${encodedUtf8Name}`);
      res.status(200);
    } else {
      if (response.headers.get('content-type')) res.setHeader('Content-Type', response.headers.get('content-type'));
      if (response.headers.get('content-range')) res.setHeader('Content-Range', response.headers.get('content-range'));
      if (response.status === 206) res.status(206);
    }

    // Free fetch stream immediately when client disconnects to prevent Render hanging/RAM overload
    res.on('close', () => {
      if (response.body && typeof response.body.destroy === 'function') {
        response.body.destroy();
      }
    });

    response.body.pipe(res);
  } catch (e) {
    console.error('Proxy error:', e);
    if (!res.headersSent) res.status(500).send('Proxy failed');
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

app.get('/api/home/categories', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/home/categories`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({}); }
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

  // 1. Fetch from backend API which generates signed stream hash automatically
  try {
    const response = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${encodeURIComponent(slug || '')}&se=${s}&ep=${e}`);
    const data = await response.json();
    const hasSources = Array.isArray(data?.sources) && data.sources.length > 0;
    const hasDash = Array.isArray(data?.dash) && data.dash.length > 0;
    const hasHls = Array.isArray(data?.hls) && data.hls.length > 0;

    if (data && data.has_resource && (hasSources || hasDash || hasHls)) {
      const host = getHostUrl(req);
      if (data.sources) data.sources.forEach(src => { if (src.url) src.url = `${host}/api/proxy?url=${encodeURIComponent(src.url)}`; });
      if (data.dash) data.dash.forEach(d => { if (d.url) d.url = `${host}/api/proxy?url=${encodeURIComponent(d.url)}`; });
      if (data.hls) data.hls.forEach(h => { if (h.url) h.url = `${host}/api/proxy?url=${encodeURIComponent(h.url)}`; });
      return res.json(data);
    }
  } catch (err) {}

  // 2. Direct fallback to netfilm if non-empty streams exist
  try {
    const directUrl = `https://netfilm.world/wefeed-h5api-bff/subject/play?subjectId=${subject_id}&se=${s}&ep=${e}&detailPath=${encodeURIComponent(slug || '')}`;
    const directRes = await fetch(directUrl, { headers: CDN_HEADERS, timeout: 10000 });
    const directData = await directRes.json();

    const play = directData?.data;
    const hasStreams = Array.isArray(play?.streams) && play.streams.length > 0;
    const hasDash = Array.isArray(play?.dash) && play.dash.length > 0;

    if (directData && play && (hasStreams || hasDash)) {
      const host = getHostUrl(req);
      const sources = (play.streams || []).map(src => ({ ...src, url: `${host}/api/proxy?url=${encodeURIComponent(src.url)}`, resolution: (src.resolutions || '') + 'p' }));
      const dash = (play.dash || []).map(d => ({ ...d, url: `${host}/api/proxy?url=${encodeURIComponent(d.url)}` }));
      return res.json({ subject_id, se: s, ep: e, has_resource: true, sources, dash, hls: play.hls || [] });
    }
  } catch (err) {}

  res.status(404).json({ error: 'Stream not found' });
});

app.get('/api/search', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q || '')}`).then(res => res.json());
    res.json({ movies: (r.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'nexmovies' })) });
  } catch(e) { res.json({ movies: [] }); }
});

app.get('/api/search/suggest', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/search/suggest?q=${encodeURIComponent(req.query.q || '')}`).then(res => res.json());
    res.json(r);
  } catch(e) { res.json({ suggestions: [] }); }
});

app.get('/api/recent-movies', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/movies?page=1`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/movies', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const r = await fetch(`${API_URL}/movies?page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/tv-series', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const r = await fetch(`${API_URL}/tv-series?page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/animation', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const r = await fetch(`${API_URL}/animation?page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/ranking', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const r = await fetch(`${API_URL}/ranking?page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/top-imdb', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const r = await fetch(`${API_URL}/top-imdb?page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/dubbed', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const lang = req.query.language || 'Hindi';
    const r = await fetch(`${API_URL}/dubbed?language=${encodeURIComponent(lang)}&page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/genre/:name', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const type = req.query.type || 'movie';
    const r = await fetch(`${API_URL}/genre/${encodeURIComponent(req.params.name)}?type=${type}&page=${page}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ items: [] }); }
});

app.get('/api/section', async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/home`).then(res => res.json());
    const target = (req.query.name || '').toLowerCase();
    const sec = (r.sections || []).find(s => s.section && s.section.toLowerCase().includes(target));
    res.json({ title: sec?.section || req.query.name, items: sec?.items || [], hasMore: false });
  } catch (e) { res.json({ items: [], hasMore: false }); }
});

app.get('/api/stream/:id/captions', async (req, res) => {
  try {
    const { detail_path, se, ep } = req.query;
    const r = await fetch(`${API_URL}/api/stream/${req.params.id}/captions?detail_path=${encodeURIComponent(detail_path || '')}&se=${se || 0}&ep=${ep || 0}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.json({ captions: [] }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexmovies Engine listening on ${PORT}`));
