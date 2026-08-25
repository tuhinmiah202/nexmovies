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

// TMDB for metadata (set TMDB_API_KEY env var for production)
const TMDB_KEY = process.env.TMDB_API_KEY || '2dca580c2a14b55200e784d157207b4d';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

// Moviebox-API for search & content
const MOVIEBOX_API = API_URL;

// CDN proxy headers (bypass CORS/Referer)
const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- VIDEO PROXY ---
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const proxyHeaders = {
      ...CDN_HEADERS,
      // Use dynamic referer or fixed moviebox depending on source
      'Referer': url.includes('aoneroom') || url.includes('moviebox') ? 'https://moviebox.ph/' : new URL(url).origin,
      'Origin': new URL(url).origin
    };

    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(url, {
      headers: proxyHeaders,
      redirect: 'follow',
      timeout: 30000,
    });

    if (!response.ok && response.status !== 206) {
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

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
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).send('Proxy failed');
  }
});

// --- VIDEO DOWNLOAD ---
app.get('/api/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const proxyHeaders = {
      ...CDN_HEADERS,
      'Referer': url.includes('aoneroom') || url.includes('moviebox') ? 'https://moviebox.ph/' : new URL(url).origin
    };

    const response = await fetch(url, {
      headers: proxyHeaders,
      redirect: 'follow',
      timeout: 60000,
    });

    if (!response.ok) return res.status(response.status).send(`Upstream error: ${response.status}`);

    const cleanTitle = (title || 'download').replace(/[^\w\s\-]/g, '').replace(/\s+/g, '_').substring(0, 80);
    const contentType = response.headers.get('content-type') || 'video/mp4';
    const ext = contentType.includes('mp4') ? '.mp4' : contentType.includes('webm') ? '.webm' : '.mp4';
    const filename = `${cleanTitle}${ext}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');

    response.body.pipe(res);
  } catch (e) {
    console.error('Download error:', e.message);
    res.status(500).send('Download failed');
  }
});

// --- HEVC -> H.264 TRANSCODE ----
let FFMPEG_PATH = null;
try { FFMPEG_PATH = require('ffmpeg-static'); } catch (e) { FFMPEG_PATH = null; }

const transcodeSessions = new Map();
const TRANSCODE_MAX_SESSIONS = 2;
const TRANSCODE_TTL_MS = 20 * 60 * 1000;

function pipeUrlToStream(url, out) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: CDN_HEADERS }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        pipeUrlToStream(resp.headers.location, out).then(resolve, reject);
        return;
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        reject(new Error(`Segment fetch failed: ${resp.statusCode}`));
        return;
      }
      resp.on('data', (chunk) => {
        if (!out.write(chunk)) {
          resp.pause();
          out.once('drain', () => resp.resume());
        }
      });
      resp.on('end', resolve);
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Segment fetch timeout')); });
  });
}

async function parseDashForTranscode(mpdUrl) {
  const response = await fetch(mpdUrl, {
    headers: { ...CDN_HEADERS, 'Accept': 'application/dash+xml, application/xml, */*' },
    redirect: 'follow',
    timeout: 20000,
  });
  if (!response.ok) throw new Error(`MPD fetch failed: ${response.status}`);
  let xml = await response.text();

  const durMatch = xml.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(\d+\.?\d*)S"/);
  let totalSec = 0;
  if (durMatch) totalSec = (parseInt(durMatch[1] || 0) * 3600) + (parseInt(durMatch[2] || 0) * 60) + parseFloat(durMatch[3]);

  const reps = [];
  const repMatches = xml.matchAll(/<Representation[^>]*>[\s\S]*?<\/Representation>/g);
  for (const rep of repMatches) {
    const block = rep[0];
    const openTag = block.match(/<Representation[^>]*>/)[0];
    const mime = (openTag.match(/mimeType="([^"]+)"/) || [])[1] || '';
    const id = (openTag.match(/ id="([^"]+)"/) || [])[1];
    const height = parseInt((openTag.match(/ height="(\d+)"/) || [])[1] || 0);
    const isVideo = mime.startsWith('video');
    const isAudio = mime.startsWith('audio');

    const tplMatch = block.match(/<SegmentTemplate[^>]*>/);
    if (!tplMatch || !id) continue;
    const tpl = tplMatch[0];
    const initTpl = (tpl.match(/ initialization="([^"]+)"/) || [])[1];
    const mediaTpl = (tpl.match(/ media="([^"]+)"/) || [])[1];
    const segDur = parseInt((tpl.match(/ duration="(\d+)"/) || [])[1] || 0);
    const timescale = parseInt((tpl.match(/ timescale="(\d+)"/) || [])[1] || 1);
    const startNumber = parseInt((tpl.match(/ startNumber="(\d+)"/) || [])[1] || 1);
    if (!initTpl || !mediaTpl || !segDur) continue;

    const unescape = (s) => s.replace(/&amp;/g, '&');
    const fill = (t, n) => unescape(t)
      .replace(/\$RepresentationID\$/g, encodeURIComponent(id))
      .replace(/\$Number%0(\d)d\$/g, (_, w) => String(n).padStart(parseInt(w), '0'))
      .replace(/\$Number\$/g, String(n));

    const segSeconds = segDur / timescale;
    const count = totalSec > 0 ? Math.ceil(totalSec / segSeconds) : 0;
    const urls = [fill(initTpl)];
    for (let i = 0; i < count; i++) urls.push(fill(mediaTpl, startNumber + i));

    reps.push({ id, height, isVideo, isAudio, urls });
  }
  return { reps, duration: totalSec };
}

function killTranscodeSession(id) {
  const s = transcodeSessions.get(id);
  if (!s) return;
  try { if (s.proc && !s.proc.killed) s.proc.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) {}
  transcodeSessions.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of transcodeSessions) if (now - s.lastTouched > TRANSCODE_TTL_MS) killTranscodeSession(id);
}, 60000).unref();

app.get('/api/transcode/start', async (req, res) => {
  const { url } = req.query;
  const reqHeight = parseInt(req.query.height) || 0;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!FFMPEG_PATH) return res.status(501).json({ error: 'FFmpeg not available' });

  try {
    const { reps } = await parseDashForTranscode(url);
    const videoReps = reps.filter(r => r.isVideo).sort((a, b) => b.height - a.height);
    const audioRep = reps.find(r => r.isAudio);
    if (!videoReps.length) return res.status(404).json({ error: 'No video' });

    let videoRep = videoReps.find(r => r.height === reqHeight) || videoReps[0];
    if (transcodeSessions.size >= TRANSCODE_MAX_SESSIONS) {
      const oldestId = transcodeSessions.keys().next().value;
      killTranscodeSession(oldestId);
    }

    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(os.tmpdir(), 'mb-transcode', id);
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-f', 'mp4', '-i', 'pipe:0',
    ];
    if (audioRep) args.push('-f', 'mp4', '-i', 'pipe:3');
    args.push('-map', '0:v:0');
    if (audioRep) args.push('-map', '1:a:0');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'hls', '-hls_time', '5', '-hls_list_size', '0', path.join(dir, 'index.m3u8'));

    const proc = spawn(FFMPEG_PATH, args, { stdio: audioRep ? ['pipe', 'ignore', 'inherit', 'pipe'] : ['pipe', 'ignore', 'inherit'] });
    const session = { proc, dir, lastTouched: Date.now(), height: videoRep.height, done: false, error: null };
    transcodeSessions.set(id, session);

    (async () => {
      try {
        const feed = async (urls, out) => { for (const u of urls) await pipeUrlToStream(u, out); out.end(); };
        const feeds = [feed(videoRep.urls, proc.stdin)];
        if (audioRep) feeds.push(feed(audioRep.urls, proc.stdio[3]));
        await Promise.all(feeds);
      } catch (e) { proc.kill('SIGKILL'); }
    })();

    res.json({ id, playlist: `/api/transcode/${id}/index.m3u8` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/transcode/:id/:file', async (req, res) => {
  const { id, file } = req.params;
  const session = transcodeSessions.get(id);
  if (!session) return res.status(404).send('Not found');
  const filePath = path.join(session.dir, file);
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(filePath)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      return fs.createReadStream(filePath).pipe(res);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  res.status(504).send('Timeout');
});

// --- API HELPERS ---
const apiCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

async function movieboxFetch(endpoint) {
  const cached = apiCache.get(endpoint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  try {
    const res = await fetch(`${MOVIEBOX_API}${endpoint}`, { timeout: 15000 });
    if (!res.ok) return null;
    const data = await res.json();
    apiCache.set(endpoint, { ts: Date.now(), data });
    return data;
  } catch (e) { return cached ? cached.data : null; }
}

function formatMovieboxItem(item) {
  return {
    id: item.subject_id,
    title: item.name,
    poster: item.poster_url || '',
    slug: item.slug,
    badge: item.badge || '',
    source: 'moviebox',
    type: 'moviebox',
    language: item.language || item.lang || ''
  };
}

// --- API ROUTES ---
app.get('/api/home', async (req, res) => {
  const data = await movieboxFetch('/home');
  if (!data || !data.sections) return res.json({ sections: [] });
  const sections = data.sections.map(s => ({
    title: s.section,
    items: (s.items || []).map(it => ({
      ...formatMovieboxItem(it),
      backdrop: it.image_url || it.poster_url || ''
    }))
  }));
  res.json({ sections });
});

app.get('/api/movies', async (req, res) => {
  const data = await movieboxFetch(`/movies?page=${req.query.page || 1}`);
  res.json({ items: data?.items || [] });
});

app.get('/api/tv-series', async (req, res) => {
  const data = await movieboxFetch(`/tv-series?page=${req.query.page || 1}`);
  res.json({ items: data?.items || [] });
});

app.get('/api/animation', async (req, res) => {
  const data = await movieboxFetch(`/animation?page=${req.query.page || 1}`);
  res.json({ items: data?.items || [] });
});

app.get('/api/ranking', async (req, res) => {
  const data = await movieboxFetch(`/ranking?page=${req.query.page || 1}`);
  res.json({ items: data?.items || [] });
});

app.get('/api/top-imdb', async (req, res) => {
  const data = await movieboxFetch(`/top-imdb?page=${req.query.page || 1}`);
  res.json({ items: data?.items || [] });
});

app.get('/api/dubbed', async (req, res) => {
  const data = await movieboxFetch(`/dubbed?language=${encodeURIComponent(req.query.language || 'Hindi')}&page=${req.query.page || 1}`);
  res.json({ items: data?.items || [] });
});

app.get('/api/genre/:name', async (req, res) => {
  const data = await movieboxFetch(`/genre/${encodeURIComponent(req.params.name)}?type=${req.query.type || 'movie'}&page=${req.query.page || 1}`);
  res.json({ items: data?.items || [], has_more: !!data?.has_more });
});

app.get('/api/search/suggest', async (req, res) => {
  const data = await movieboxFetch(`/search/suggest?q=${encodeURIComponent(req.query.q || '')}`);
  res.json({ suggestions: data?.suggestions || [] });
});

app.get('/api/search', async (req, res) => {
  const data = await movieboxFetch(`/search?q=${encodeURIComponent(req.query.q || '')}`);
  res.json({ movies: (data?.items || []).map(formatMovieboxItem) });
});

app.get('/api/detail', async (req, res) => {
  const { id, slug, source } = req.query;
  if (source === 'moviebox' && slug) {
    const data = await movieboxFetch(`/detail/${slug}`);
    if (data?.data?.subject) {
      const s = data.data.subject;
      return res.json({
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
    }
  }
  res.status(404).json({ error: 'Not found' });
});

app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  const data = await movieboxFetch(`/api/stream/${subject_id}?detail_path=${slug}&se=${se || 0}&ep=${ep || 0}`);
  if (data) return res.json(data);
  res.status(502).json({ error: 'Failed' });
});

app.get('/api/stream/:id/captions', async (req, res) => {
  const data = await movieboxFetch(`/api/stream/${req.params.id}/captions?detail_path=${req.query.detail_path}&se=${req.query.se || 0}&ep=${req.query.ep || 0}`);
  res.json(data || { captions: [] });
});

app.get('/api/dash-manifest', async (req, res) => {
  try {
    const r = await fetch(req.query.url, { headers: CDN_HEADERS });
    const xml = await r.text();
    const resolutions = [];
    const matches = xml.matchAll(/<Representation[^>]+height="(\d+)"[^>]*>/g);
    for (const m of matches) resolutions.push({ height: parseInt(m[1]), label: m[1]+'p' });
    res.json({ resolutions: resolutions.sort((a,b) => b.height-a.height) });
  } catch(e) { res.status(500).send(e.message); }
});

app.get('/api/cast', async (req, res) => {
  const url = `${TMDB_BASE}/${req.query.type || 'movie'}/${req.query.id}/credits?api_key=${TMDB_KEY}`;
  const r = await fetch(url).then(r => r.json());
  res.json({ cast: (r.cast || []).slice(0, 15) });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🎬 Nexmovies running on ${PORT}`));
