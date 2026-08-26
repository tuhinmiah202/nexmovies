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
  'Referer': 'https://moviebox.ph/'
};

// --- DIRECT RESOLVER TO BYPASS BLOCKS ---
async function resolveStream(subjectId, slug, se, ep) {
  try {
    const url = `https://netfilm.world/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { headers: CDN_HEADERS, timeout: 10000 });
    const json = await res.json();
    return json.data || null;
  } catch (e) { return null; }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ADVANCED PROXY WITH REWRITING ---
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const response = await fetch(url, {
      headers: { ...CDN_HEADERS, 'Range': req.headers.range || '' },
      redirect: 'follow',
      timeout: 30000,
    });

    const contentType = response.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    if (url.includes('.mpd') || url.includes('.m3u8')) {
      let text = await response.text();
      const host = `${req.get('x-forwarded-proto') || 'https'}://${req.get('host')}`;
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

      if (url.includes('.mpd')) {
        const proxyBase = `${host}/api/proxy?url=${encodeURIComponent(baseUrl)}`;
        text = text.replace(/<BaseURL>.*?<\/BaseURL>/g, `<BaseURL>${proxyBase}</BaseURL>`);
        if (!text.includes('<BaseURL>')) text = text.replace('<Period', `<BaseURL>${proxyBase}</BaseURL><Period`);
      } else {
        const lines = text.split('\n');
        text = lines.map(l => (!l.trim() || l.startsWith('#')) ? l : `${host}/api/proxy?url=${encodeURIComponent(l.startsWith('http') ? l : new URL(l, baseUrl).href)}`).join('\n');
      }
      return res.send(text);
    }

    if (contentType) res.setHeader('Content-Type', contentType);
    ['content-length', 'content-range', 'accept-ranges'].forEach(h => {
      if (response.headers.get(h)) res.setHeader(h, response.headers.get(h));
    });

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
        id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, badge: it.badge, source: 'moviebox', type: it.subject_type === 2 ? 'tv' : 'movie', backdrop: it.image_url || it.poster_url
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
      slug: s.detailPath, source: 'moviebox', resource: data.data.resource || {}, dubs: s.dubs || []
    });
  } catch (e) { res.status(500).send('Error'); }
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const s = parseInt(se) || 1;
  const e = parseInt(ep) || 1;

  try {
    // RESOLVE DIRECTLY ON FLY.IO TO AVOID VERCEL IP BLOCK
    const play = await resolveStream(subject_id, slug, s, e);
    if (play && (play.streams || play.dash)) {
      const host = `${req.get('x-forwarded-proto') || 'https'}://${req.get('host')}`;
      const sources = (play.streams || []).map(src => ({ ...src, url: `${host}/api/proxy?url=${encodeURIComponent(src.url)}`, resolution: src.resolutions + 'p' }));
      const dash = (play.dash || []).map(d => ({ ...d, url: `${host}/api/proxy?url=${encodeURIComponent(d.url)}` }));
      const hls = (play.hls || []).map(h => ({ ...h, url: `${host}/api/proxy?url=${encodeURIComponent(h.url)}` }));
      return res.json({ subject_id, se: s, ep: e, has_resource: true, sources, dash, hls });
    }
  } catch (err) {}

  // Fallback to Vercel API
  try {
    const r = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${slug}&se=${se || 0}&ep=${ep || 0}`).then(res => res.json());
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/search', async (req, res) => {
  const data = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q)}`).then(r => r.json());
  res.json({ movies: (data?.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'moviebox' })) });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexmovies Final Ready on ${PORT}`));
