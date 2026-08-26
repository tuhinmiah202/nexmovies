const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7860;
const API_URL = 'https://moviebox-api-steel.vercel.app';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- API ROUTES ---
app.get('/api/home', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/home`).then(res => res.json());
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
    const data = await fetch(`${API_URL}/detail/${req.query.slug}`).then(res => res.json());
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
  const s = se !== undefined ? parseInt(se) : 0;
  const e = ep !== undefined ? parseInt(ep) : 0;
  try {
    const data = await fetch(`${API_URL}/api/stream/${subject_id}?detail_path=${slug}&se=${s}&ep=${e}`).then(res => res.json());
    if (data && data.has_resource) {
      // Instead of server-side proxy, we use /api/proxy which will be intercepted by Service Worker
      if (data.sources) data.sources.forEach(src => { if (src.url) src.url = `/api/proxy?url=${encodeURIComponent(src.url)}`; });
      if (data.dash) data.dash.forEach(d => { if (d.url) d.url = `/api/proxy?url=${encodeURIComponent(d.url)}`; });
      if (data.hls) data.hls.forEach(h => { if (h.url) h.url = `/api/proxy?url=${encodeURIComponent(h.url)}`; });
      return res.json(data);
    }
    res.status(404).json({ error: 'No stream' });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const data = await fetch(`${API_URL}/search?q=${encodeURIComponent(req.query.q)}`).then(r => r.json());
    res.json({ movies: (data?.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'moviebox' })) });
  } catch(e) { res.json({ movies: [] }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexmovies Browser-Proxy Ready on ${PORT}`));
