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
  'Referer': 'https://moviebox.ph/',
  'Origin': 'https://moviebox.ph',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// --- Direct upstream stream resolver ---
// Upstream (moviebox.ph / aoneroom) serves EMPTY stream lists to serverless
// IPs (Vercel/AWS), so the play API can't live on the backend anymore — it is
// resolved here, on this always-on host, whose IP gets real stream data.
const MB_API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';

const MB_PLAYER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'X-Client-Info': '{"timezone":"Asia/Dhaka"}',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

// Domain + guest token are cached, refreshed when stale
let mbSession = { ts: 0, domain: null, token: null };
async function mbGetSession(forceRefresh = false) {
  if (!forceRefresh && mbSession.domain && Date.now() - mbSession.ts < 10 * 60 * 1000) {
    return mbSession;
  }
  const res = await fetch(`${MB_API_BASE}/media-player/get-domain`, {
    headers: {
      ...CDN_HEADERS,
      'Accept': 'application/json',
    },
    timeout: 10000,
  });
  const data = await res.json();
  const domain = String(data.data || 'https://netfilm.world/').replace(/\/+$/, '');

  // A fresh guest JWT rides the x-user response header / set-cookie
  let token = null;
  const xUser = res.headers.get('x-user');
  if (xUser) {
    try { token = JSON.parse(xUser).token || null; } catch (e) {}
  }
  if (!token) {
    const cookie = res.headers.get('set-cookie') || '';
    const m = cookie.match(/token=([^;]+)/);
    if (m) token = m[1];
  }

  mbSession = { ts: Date.now(), domain, token: token || mbSession.token };
  return mbSession;
}

// Fetch play data (streams/dash/hls) directly from the player domain
async function mbFetchPlay(subjectId, slug, se, ep, forceRefresh = false) {
  const { domain, token } = await mbGetSession(forceRefresh);
  const referer = `${domain}/spa/videoPlayPage/movies/${slug}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const url = `${domain}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(slug)}`;
  const headers = { ...MB_PLAYER_HEADERS, 'Referer': referer };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: 'follow', timeout: 20000 });
  if (!res.ok) throw new Error(`play fetch ${res.status}`);
  const json = await res.json();
  let data = json.data || {};

  // Retry once with a fresh session if upstream served an empty payload
  if (!forceRefresh && !data.hasResource && !(data.streams || []).length) {
    data = await mbFetchPlay(subjectId, slug, se, ep, true);
  }
  return data;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- VIDEO PROXY (bypass CORS/Referer) ---
// Allowed CDN domains (add more as needed)
const ALLOWED_PROXY_HOSTS = [
  'bcdnxw.hakunaymatata.com',
  'sbcdnw.hakunaymatata.com',
  'sacdn.hakunaymatata.com',
  'cacdn.hakunaymatata.com',
  'netfilm.world',
  'moviebox.ph',
  'image.tmdb.org',
  'pbcdnw.aoneroom.com',
  'pbcdn.aoneroom.com',
  'macdn.aoneroom.com',
  'h5-api.aoneroom.com',
  'ugc-video.com',
  'akamaized.net',
  'mcloud.to',
  'vizcloud.online',
  'rabbitstream.net'
];

app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  // Validate URL
  let targetUrl = url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const isAllowed = ALLOWED_PROXY_HOSTS.some(h => host === h || host.endsWith('.' + h));
    // If not in allowed list, we still try but with caution (or you can strict block)
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  try {
    const proxyHeaders = {
      ...CDN_HEADERS,
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

    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    // Forward content length for progress
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Forward content range for partial responses
    const contentRange = response.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    // Allow range requests for seeking
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Forward status 206 (Partial Content) for range requests
    if (response.status === 206) {
      res.status(206);
    }

    // Stream the video
    response.body.pipe(res);
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).send('Proxy failed');
  }
});

// --- VIDEO DOWNLOAD (sets Content-Disposition: attachment) ---
app.get('/api/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).send('Missing url');

  // Validate URL — only allow known CDN hosts
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const isAllowed = ALLOWED_PROXY_HOSTS.some(h => host === h || host.endsWith('.' + h));
    if (!isAllowed) {
      return res.status(403).send('Host not allowed');
    }
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  try {
    const proxyHeaders = { ...CDN_HEADERS };

    const response = await fetch(url, {
      headers: proxyHeaders,
      redirect: 'follow',
      timeout: 60000,
    });

    if (!response.ok) {
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

    // Build filename from title
    const cleanTitle = (title || 'download').replace(/[^\w\s\-]/g, '').replace(/\s+/g, '_').substring(0, 80);
    const contentType = response.headers.get('content-type') || 'video/mp4';
    const ext = contentType.includes('mp4') ? '.mp4' : contentType.includes('webm') ? '.webm' : '.mp4';
    const filename = `${cleanTitle}${ext}`;

    // Content-Length for progress
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    response.body.pipe(res);
  } catch (e) {
    console.error('Download error:', e.message);
    res.status(500).send('Download failed');
  }
});

// --- HEVC -> H.264 TRANSCODE ----
// Some movies/series lock higher resolutions (1080p/720p/480p) behind VIP and
// only expose them inside an HEVC (h265) DASH stream. Browsers without HEVC
// hardware support then play audio-only with a black screen. These endpoints
// transcode any DASH representation to H.264 HLS on the fly with FFmpeg.
let FFMPEG_PATH = null;
try { FFMPEG_PATH = require('ffmpeg-static'); } catch (e) { FFMPEG_PATH = null; }

const transcodeSessions = new Map(); // id -> { proc, dir, lastTouched, videoPushed, audioPushed }
const TRANSCODE_MAX_SESSIONS = 2;
const TRANSCODE_TTL_MS = 20 * 60 * 1000;

// Fetch a remote file and pipe it into a writable stream (returns promise)
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

// Parse a DASH MPD into representation list + segment URLs
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

// Periodically reap idle transcode sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of transcodeSessions) {
    if (now - s.lastTouched > TRANSCODE_TTL_MS) killTranscodeSession(id);
  }
}, 60000).unref();

app.get('/api/transcode/status', (req, res) => {
  res.json({ ffmpeg: !!FFMPEG_PATH, sessions: transcodeSessions.size, max: TRANSCODE_MAX_SESSIONS });
});

// Start a transcode session: /api/transcode/start?url=<mpd>&height=1080
app.get('/api/transcode/start', async (req, res) => {
  const { url } = req.query;
  const reqHeight = parseInt(req.query.height) || 0;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!FFMPEG_PATH) return res.status(501).json({ error: 'FFmpeg not available on server' });

  try {
    const { reps } = await parseDashForTranscode(url);
    const videoReps = reps.filter(r => r.isVideo).sort((a, b) => b.height - a.height);
    const audioRep = reps.find(r => r.isAudio);
    if (!videoReps.length) return res.status(404).json({ error: 'No video tracks in manifest' });

    // Pick the video rep: closest to requested height (prefer the requested one)
    let videoRep = videoReps.find(r => r.height === reqHeight)
      || videoReps.find(r => r.height >= reqHeight)
      || videoReps[videoReps.length - 1];

    // Enforce session limit — kill oldest
    if (transcodeSessions.size >= TRANSCODE_MAX_SESSIONS) {
      let oldestId = null, oldest = Infinity;
      for (const [sid, s] of transcodeSessions) if (s.lastTouched < oldest) { oldest = s.lastTouched; oldestId = sid; }
      if (oldestId) killTranscodeSession(oldestId);
    }

    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(os.tmpdir(), 'mb-transcode', id);
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-thread_queue_size', '4096',
      '-f', 'mp4', '-i', 'pipe:0',
    ];
    if (audioRep) args.push('-thread_queue_size', '4096', '-f', 'mp4', '-i', 'pipe:3');
    args.push('-map', '0:v:0');
    if (audioRep) args.push('-map', '1:a:0');
    args.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0',
    );
    if (audioRep) args.push('-c:a', 'aac', '-b:a', '128k');
    args.push(
      '-f', 'hls', '-hls_time', '5', '-hls_list_size', '0',
      '-hls_flags', 'independent_segments+program_date_time',
      '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
      path.join(dir, 'index.m3u8'),
    );

    const proc = spawn(FFMPEG_PATH, args, {
      stdio: audioRep ? ['pipe', 'ignore', 'inherit', 'pipe'] : ['pipe', 'ignore', 'inherit'],
    });

    const session = { proc, dir, lastTouched: Date.now(), height: videoRep.height, done: false, error: null };
    transcodeSessions.set(id, session);

    proc.on('error', (e) => { session.error = e.message; });
    proc.on('exit', () => {
      session.done = true;
      // keep files briefly for in-flight segment requests, then clean
      setTimeout(() => killTranscodeSession(id), 60000).unref();
    });

    // Feed video and audio segments into ffmpeg in the background.
    // IMPORTANT: both pipes must be fed in parallel — interleaving starves
    // ffmpeg's input probing and deadlocks the pipeline.
    (async () => {
      try {
        const videoOut = proc.stdin;
        const audioOut = audioRep ? proc.stdio[3] : null;
        const feedAll = async (urls, out) => {
          for (const u of urls) {
            await pipeUrlToStream(u, out);
            session.lastTouched = Date.now();
          }
          out.end();
        };
        const feeds = [feedAll(videoRep.urls, videoOut)];
        if (audioRep) feeds.push(feedAll(audioRep.urls, audioOut));
        await Promise.all(feeds);
      } catch (e) {
        console.error('Transcode feed error:', e.message);
        session.error = e.message;
        try { proc.kill('SIGKILL'); } catch (err) {}
      }
    })();

    res.json({ id, height: videoRep.height, playlist: `/api/transcode/${id}/index.m3u8` });
  } catch (e) {
    console.error('Transcode start error:', e.message);
    res.status(500).json({ error: 'Transcode failed: ' + e.message });
  }
});

app.get('/api/transcode/:id/stop', (req, res) => {
  killTranscodeSession(req.params.id);
  res.json({ stopped: true });
});

// Serve transcoded HLS files; waits for the file if FFmpeg hasn't produced it yet
app.get('/api/transcode/:id/:file', async (req, res) => {
  const { id, file } = req.params;
  const session = transcodeSessions.get(id);
  if (!session) return res.status(404).send('Session not found');
  if (!/^[\w.-]+$/.test(file)) return res.status(400).send('Bad file');

  session.lastTouched = Date.now();
  const filePath = path.join(session.dir, file);

  // Wait until FFmpeg produces the file (up to 30s)
  for (let waited = 0; waited < 30000; waited += 250) {
    if (fs.existsSync(filePath)) {
      // For .ts segments make sure FFmpeg finished writing (next segment exists or proc done)
      if (file.endsWith('.ts') && !session.done) {
        const idx = parseInt((file.match(/seg(\d+)\.ts/) || [])[1] || 0);
        const next = path.join(session.dir, `seg${String(idx + 1).padStart(5, '0')}.ts`);
        if (!fs.existsSync(next)) { await new Promise(r => setTimeout(r, 500)); }
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      return fs.createReadStream(filePath).pipe(res);
    }
    if (session.error) return res.status(500).send('Transcode error: ' + session.error);
    await new Promise(r => setTimeout(r, 250));
  }
  res.status(504).send('Timed out waiting for transcode output');
});

// --- TMDB helpers ---
async function tmdbFetch(endpoint, params = {}) {
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  url.searchParams.set('api_key', TMDB_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`TMDB error: ${endpoint} - ${e.message}`);
    return null;
  }
}

function formatTmdbMovie(item, type) {
  return {
    id: item.id,
    title: item.title || item.name || 'Untitled',
    poster: item.poster_path ? TMDB_IMG + item.poster_path : '',
    backdrop: item.backdrop_path ? TMDB_IMG + item.backdrop_path : '',
    year: (item.release_date || item.first_air_date || '').substring(0, 4) || 'N/A',
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
    overview: item.overview || '',
    type: type || (item.title ? 'movie' : 'tv'),
    source: 'tmdb',
    // TMDB original_language is a two-letter code (en, ja, ko, hi, etc.) — preserve it for the client
    language: item.original_language || (item.spoken_languages && item.spoken_languages[0] && item.spoken_languages[0].iso_639_1) || '',
  };
}

// --- Recently Released Movies (hero carousel) ---
// Movie-only feed from TMDB "Now Playing" — proper recently released movies
// with proper landscape backdrops, genres, year and ratings.
const TMDB_IMG_HI = 'https://image.tmdb.org/t/p/w1280';
let tmdbGenreCache = { ts: 0, map: {} };

async function tmdbGenreMap() {
  if (Date.now() - tmdbGenreCache.ts < 6 * 3600 * 1000 && Object.keys(tmdbGenreCache.map).length) {
    return tmdbGenreCache.map;
  }
  const data = await tmdbFetch('/genre/movie/list');
  const map = {};
  for (const g of (data?.genres || [])) map[g.id] = g.name;
  if (Object.keys(map).length) tmdbGenreCache = { ts: Date.now(), map };
  return map;
}

app.get('/api/recent-movies', async (req, res) => {
  const [genreMap, nowPlaying] = await Promise.all([
    tmdbGenreMap(),
    tmdbFetch('/movie/now_playing', { page: 1 }),
  ]);

  let results = (nowPlaying?.results || []).filter(m => m.backdrop_path);
  // Fallback: latest releases via discover when now_playing is unavailable
  if (!results.length) {
    const today = new Date().toISOString().substring(0, 10);
    const disc = await tmdbFetch('/discover/movie', {
      sort_by: 'release_date.desc', 'release_date.lte': today,
      'vote_count.gte': 10, page: 1, include_adult: false,
    });
    results = (disc?.results || []).filter(m => m.backdrop_path);
  }

  const items = results.slice(0, 10).map(m => ({
    id: m.id,
    title: m.title || 'Untitled',
    poster: m.poster_path ? TMDB_IMG + m.poster_path : '',
    backdrop: TMDB_IMG_HI + m.backdrop_path,
    year: (m.release_date || '').substring(0, 4) || 'N/A',
    rating: m.vote_average ? m.vote_average.toFixed(1) : null,
    genre: (m.genre_ids || []).map(id => genreMap[id]).filter(Boolean).slice(0, 3).join(' · '),
    overview: m.overview || '',
    language: m.original_language || '',
    type: 'movie',
    source: 'tmdb',
  }));
  res.json({ items });
});

// Paginated catalog endpoints (round-robin used by Most Trending)
app.get('/api/movies', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const data = await movieboxFetch(`/movies?page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({ page, items: (data.items || []).map(item => ({
    subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
    slug: item.slug, badge: item.badge || '',
  })) });
});

app.get('/api/tv-series', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const data = await movieboxFetch(`/tv-series?page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({ page, items: (data.items || []).map(item => ({
    subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
    slug: item.slug, badge: item.badge || '',
  })) });
});

app.get('/api/animation', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const data = await movieboxFetch(`/animation?page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({ page, items: (data.items || []).map(item => ({
    subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
    slug: item.slug, badge: item.badge || '',
  })) });
});

app.get('/api/ranking', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const data = await movieboxFetch(`/ranking?page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({ page, total: data.total || 0, items: (data.items || []).map(item => ({
    subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
    slug: item.slug, badge: item.badge || '', rating: item.rating || null,
  })) });
});

app.get('/api/top-imdb', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const data = await movieboxFetch(`/top-imdb?page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({ page, total: data.total || 0, items: (data.items || []).map(item => ({
    subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
    slug: item.slug, badge: item.badge || '', rating: item.rating || null,
  })) });
});

// Dubbed content (Hindi etc.) — discovery feed from Moviebox-API
app.get('/api/dubbed', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const language = req.query.language || 'Hindi';
  const data = await movieboxFetch(`/dubbed?language=${encodeURIComponent(language)}&page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({ page, language: data.language || language, items: (data.items || []).map(item => ({
    subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
    slug: item.slug, badge: item.badge || '', rating: item.rating || null,
    subject_type: item.subject_type,
  })) });
});

// Genre browsing — pooled per-type feeds filtered server-side by genre field
app.get('/api/genres', async (req, res) => {
  const data = await movieboxFetch('/genres');
  res.json(data || { genres: [], types: ['movie', 'tv', 'animation'] });
});

app.get('/api/genre/:name', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const type = ['movie', 'tv', 'animation'].includes(req.query.type) ? req.query.type : 'movie';
  const name = req.params.name;
  const data = await movieboxFetch(`/genre/${encodeURIComponent(name)}?type=${type}&page=${page}`);
  if (!data) return res.json({ items: [] });
  res.json({
    genre: name, type, page,
    total: data.total || 0,
    has_more: !!data.has_more,
    items: (data.items || []).map(item => ({
      subject_id: item.subject_id, name: item.name, poster_url: item.poster_url || '',
      slug: item.slug, badge: item.badge || '', rating: item.rating || null,
      subject_type: item.subject_type,
    })),
  });
});

// Simple in-memory cache
const apiCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function movieboxFetch(endpoint) {
  const cacheKey = endpoint;
  const cached = apiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    const res = await fetch(`${MOVIEBOX_API}${endpoint}`, { timeout: 15000 });
    if (!res.ok) throw new Error(`Moviebox-API ${res.status}`);
    const data = await res.json();
    apiCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (e) {
    console.error(`Moviebox-API error: ${endpoint} - ${e.message}`);
    // Return stale cache if error, or null
    return cached ? cached.data : null;
  }
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
    // Moviebox API sometimes exposes language under different keys — preserve if present
    language: item.language || item.lang || item.locale || '',
  };
}

// --- API Routes ---

// Trending - try Moviebox-API first, fallback to TMDB
app.get('/api/trending', async (req, res) => {
  const data = await movieboxFetch('/home');
  if (data && data.sections) {
    const movies = [];
    for (const section of data.sections) {
      if (section.items) {
        for (const item of section.items) {
          movies.push(formatMovieboxItem(item));
        }
      }
    }
    if (movies.length > 0) return res.json({ movies: movies.slice(0, 40), total: movies.length });
  }

  // Fallback to TMDB
  const [moviesRes, tvRes] = await Promise.allSettled([
    tmdbFetch('/trending/movie/week'),
    tmdbFetch('/trending/tv/week'),
  ]);
  const movies = (moviesRes.value?.results || []).map(m => formatTmdbMovie(m, 'movie'));
  const tv = (tvRes.value?.results || []).map(m => formatTmdbMovie(m, 'tv'));
  res.json({ movies: [...movies, ...tv], total: movies.length + tv.length });
});

// Home - full sectioned layout from Moviebox-API /home (with TMDB fallback)
app.get('/api/home', async (req, res) => {
  const data = await movieboxFetch('/home');
  if (data && Array.isArray(data.sections) && data.sections.length > 0) {
    const sections = data.sections
      .filter(s => s.items && s.items.length > 0)
      .map(s => ({
        title: s.section,
        items: s.items.map(item => ({
          id: item.subject_id,
          title: item.name || 'Untitled',
          poster: item.poster_url || '',
          backdrop: item.image_url || item.poster_url || '',
          slug: item.slug,
          badge: item.badge || '',
          source: 'moviebox',
          type: 'moviebox',
          // Preserve language info from Moviebox-API when available
          language: item.language || item.lang || item.locale || '',
        })),
      }));
    if (sections.length > 0) {
      return res.json({ sections });
    }
  }

  // Fallback: reuse trending flat list as a single section
  const trending = await movieboxFetch('/home');
  if (data && data.sections) {
    const all = [];
    for (const s of data.sections) {
      for (const it of (s.items || [])) {
        all.push({
          id: it.subject_id, title: it.name || 'Untitled',
          poster: it.poster_url || '', slug: it.slug,
          badge: it.badge || '', source: 'moviebox', type: 'moviebox',
        });
      }
    }
    if (all.length) return res.json({ sections: [{ title: 'Trending', items: all.slice(0, 40) }] });
  }
  res.json({ sections: [] });
});

// Home categories — sections grouped by type (movie, tv, animation)
app.get('/api/home/categories', async (req, res) => {
  const data = await movieboxFetch('/home/categories');
  const result = { movie: [], tv: [], animation: [] };

  if (data && data.categories) {
    for (const [cat, sections] of Object.entries(data.categories)) {
      result[cat] = (sections || []).map(s => ({
        title: s.title,
        items: (s.items || []).map(item => ({
          id: item.subject_id,
          title: item.name || 'Untitled',
          poster: item.poster_url || '',
          slug: item.slug,
          badge: item.badge || '',
          rating: item.rating || null,
          source: 'moviebox',
          type: 'moviebox',
        }))
      }));
    }
  }

  // Add TMDB animation sections for more content — paginate until a healthy number of posters found
  try {
    async function collectTmdb(endpoint, maxItems = 20, maxPages = 6) {
      const collected = [];
      const seen = new Set();
      for (let p = 1; p <= maxPages && collected.length < maxItems; p++) {
        const res = await tmdbFetch(endpoint, { with_genres: '16', sort_by: 'popularity.desc', page: p, include_adult: false });
        const results = (res?.results || []).map(m => formatTmdbMovie(m, endpoint.includes('/movie') ? 'movie' : 'tv')).filter(m => m.poster);
        for (const it of results) {
          if (!seen.has(it.id)) { seen.add(it.id); collected.push(it); if (collected.length >= maxItems) break; }
        }
      }
      return collected;
    }

    const animeTvItems = await collectTmdb('/discover/tv', 20, 6);
    const animeMovieItems = await collectTmdb('/discover/movie', 20, 6);

    if (animeTvItems.length) {
      result.animation.push({ title: 'Popular Anime TV', items: animeTvItems });
    }
    if (animeMovieItems.length) {
      result.animation.push({ title: 'Popular Anime Movies', items: animeMovieItems });
    }
  } catch (e) { /* skip TMDB fallback */ }

  res.json(result);
});

// Section view — "See More" for a home section.
// Page 1 returns that section's items from /home; further pages pull from the
// paginated category endpoints so the section page can keep loading more.
const SECTION_CATEGORY = {
  'banner': 'movie',
  'trending now': 'movie',
  'cinema': 'movie',
  'hot short tv': 'movie',
  'bollywood': 'movie',
  'hollywood': 'movie',
  'south indian': 'movie',
  'popular movie': 'movie',
  'asian': 'tv',
  'top series this week': 'tv',
  'top anime series': 'tv',
  'best asian dramas': 'tv',
  'indian dramas': 'tv',
  'western tv': 'tv',
  'turkish drama': 'tv',
  'popular series': 'tv',
  'sitcom': 'tv',
  'teen romance': 'tv',
  'superhero series': 'tv',
  'teen fantasy': 'tv',
  'gangster': 'tv',
  'epic fantasy': 'tv',
  'action&thriller': 'tv',
  'bet+': 'tv',
  'adult animation': 'tv',
  'bl story': 'tv',
  'c-drama': 'tv',
  'k-drama': 'tv',
};

// Resolve which paginated catalog (movie/tv/animation) feeds a section's
// "More" pages. Static map first, then /home/categories (cached), then
// keyword heuristics as a last resort.
let sectionCatCache = { ts: 0, map: {} };
async function resolveSectionCategory(name) {
  const key = (name || '').replace(/^[^\w+]+|[^\w+]+$/g, '').toLowerCase();
  if (SECTION_CATEGORY[key]) return SECTION_CATEGORY[key];

  if (Date.now() - sectionCatCache.ts > 5 * 60 * 1000) {
    try {
      const data = await movieboxFetch('/home/categories');
      const map = {};
      if (data && data.categories) {
        for (const [cat, sections] of Object.entries(data.categories)) {
          for (const s of (sections || [])) {
            const sk = (s.title || '').replace(/^[^\w+]+|[^\w+]+$/g, '').toLowerCase();
            if (sk) map[sk] = cat;
          }
        }
      }
      sectionCatCache = { ts: Date.now(), map };
    } catch (e) { /* keep old cache */ }
  }
  if (sectionCatCache.map[key]) return sectionCatCache.map[key];

  if (/anime|animation|cartoon/.test(key)) return 'animation';
  if (/series|sitcom|drama|tv|show/.test(key)) return 'tv';
  return 'movie';
}

app.get('/api/section', async (req, res) => {
  const name = (req.query.name || '').replace(/^[^\w]+|[^\w]+$/g, ''); // strip leading/trailing emoji
  const page = parseInt(req.query.page) || 1;

  if (page === 1) {
    // Return the actual section's items from /home
    const data = await movieboxFetch('/home');
    if (data && Array.isArray(data.sections)) {
      const match = data.sections.find(s =>
        (s.section || '').replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase() === name.toLowerCase()
      );
      if (match && match.items && match.items.length) {
        return res.json({
          title: match.section,
          page: 1,
          items: match.items.map(item => ({
            id: item.subject_id,
            title: item.name || 'Untitled',
            poster: item.poster_url || '',
            backdrop: item.image_url || item.poster_url || '',
            slug: item.slug,
            badge: item.badge || '',
            source: 'moviebox',
            type: 'moviebox',
          })),
          hasMore: true,
        });
      }
    }
  }

  // Pages > 1 (or fallback) — pull from the mapped paginated category endpoint
  const cat = await resolveSectionCategory(name);
  const endpoint = cat === 'movie' ? '/api/movies' : cat === 'tv' ? '/api/tv-series' : '/api/animation';
  const data = await movieboxFetch(`${endpoint.replace('/api', '')}?page=${page}`);
  if (!data) return res.json({ title: name, page, items: [], hasMore: false });
  return res.json({
    title: name,
    page,
    items: (data.items || []).map(it => ({
      id: it.subject_id,
      title: it.name || 'Untitled',
      poster: it.poster_url || '',
      slug: it.slug,
      badge: it.badge || '',
      source: 'moviebox',
      type: 'moviebox',
    })),
    hasMore: (data.items || []).length > 0,
  });
});

// Search suggestions (autocomplete)
app.get('/api/search/suggest', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 1) return res.json({ suggestions: [] });

  const data = await movieboxFetch(`/search/suggest?q=${encodeURIComponent(q)}`);
  if (data && data.suggestions) {
    return res.json({ suggestions: data.suggestions });
  }
  res.json({ suggestions: [] });
});

// Search - Moviebox-API first (has Hindi/Tamil/Telugu), fallback TMDB
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ movies: [], total: 0 });

  // Try Moviebox-API (has Hindi dubbed content)
  const data = await movieboxFetch(`/search?q=${encodeURIComponent(q)}`);
  if (data && data.items && data.items.length > 0) {
    const movies = data.items.map(item => ({
      id: item.subject_id,
      title: item.name,
      poster: item.poster_url || '',
      slug: item.slug,
      year: item.year || '',
      badge: item.badge || '',
      rating: item.rating || null,
      genre: item.genre || '',
      country: item.country || '',
      source: 'moviebox',
      type: 'moviebox',
    }));
    return res.json({ movies, total: movies.length });
  }

  // Fallback to TMDB
  const tmdb = await tmdbFetch('/search/multi', { query: q, include_adult: false });
  const movies = (tmdb?.results || [])
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .map(m => formatTmdbMovie(m, m.media_type));
  res.json({ movies, total: movies.length });
});

// Detail
app.get('/api/detail', async (req, res) => {
  const { type, id, slug, source } = req.query;

  // Moviebox-API detail (has Hindi/Tamil/Telugu dubs, episodes, etc.)
  if (source === 'moviebox' && slug) {
    const data = await movieboxFetch(`/detail/${slug}`);
    if (data && data.data && data.data.subject) {
      const s = data.data.subject;
      const year = s.releaseDate ? s.releaseDate.substring(0, 4) : '';
      const genres = s.genre ? s.genre.split(',').map(g => g.trim()) : [];

      // Get resource info (seasons, episodes, source)
      const resource = data.data.resource || {};

      return res.json({
        id: s.subjectId || id,
        title: s.title || 'Untitled',
        poster: s.cover?.url || '',
        backdrop: s.stills?.url || s.cover?.url || '',
        year: year,
        rating: s.imdbRatingValue || '',
        ratingCount: s.imdbRatingCount || 0,
        overview: s.description || '',
        genres: genres,
        country: s.countryName || '',
        corner: s.corner || '',
        subtitles: s.subtitles || '',
        type: s.subjectType === 2 ? 'tv' : 'movie',
        slug: s.detailPath || slug,
        source: 'moviebox',
        hasResource: s.hasResource || false,
        resource: resource,
        dubs: s.dubs || [],
        trailer: s.trailer?.videoAddress?.url || '',
      });
    }

    // Detail API returned empty — fallback: build response from slug
    const slugParts = slug.split('-');
    const fallbackTitle = slug
      .replace(/-[a-zA-Z0-9]{8,}$/, '')  // Remove trailing hash
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    return res.json({
      id: id,
      title: fallbackTitle || 'Untitled',
      poster: '',
      backdrop: '',
      year: '',
      rating: '',
      ratingCount: 0,
      overview: '',
      genres: [],
      country: '',
      corner: '',
      subtitles: '',
      type: 'movie',
      slug: slug,
      source: 'moviebox',
      hasResource: true,
      resource: {},
      dubs: [],
      trailer: '',
    });
  }

  // TMDB detail
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/${mediaType}/${id}`);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: data.id,
    title: data.title || data.name,
    poster: data.poster_path ? TMDB_IMG + data.poster_path : '',
    backdrop: data.backdrop_path ? TMDB_IMG + data.backdrop_path : '',
    year: (data.release_date || data.first_air_date || '').substring(0, 4),
    rating: data.vote_average ? data.vote_average.toFixed(1) : null,
    overview: data.overview || '',
    genres: (data.genres || []).map(g => g.name),
    type: mediaType,
    source: 'tmdb',
  });
});

// Stream - resolved directly on this host (upstream blocks serverless IPs);
// falls back to Moviebox-API if the direct fetch fails.
app.get('/api/stream', async (req, res) => {
  const { subject_id, slug, se, ep } = req.query;
  if (!subject_id || !slug) return res.status(400).json({ error: 'Missing params' });

  const season = se || 0; // default to 0 for movies
  const episode = ep || 0;

  try {
    // Try Moviebox-API first (your new backend)
    const data = await movieboxFetch(`/api/stream/${subject_id}?detail_path=${slug}&se=${season}&ep=${episode}`);
    if (data && (data.sources || data.dash || data.hls)) {
      return res.json(data);
    }
  } catch (e) {
    console.error('API backend stream error:', e.message);
  }

  try {
    // Fallback: Direct upstream resolution
    const play = await mbFetchPlay(subject_id, slug, season || 1, episode || 1);
    const sources = (play.streams || []).map(s => ({
      resolution: `${s.resolutions}p`,
      format: s.format,
      url: s.url,
      size: s.size,
      duration: s.duration,
      codec: s.codecName,
    }));
    if (!!play.hasResource && (sources.length > 0 || (play.dash || []).length > 0 || (play.hls || []).length > 0)) {
      return res.json({
        subject_id, se: season, ep: episode,
        has_resource: true,
        sources,
        hls: play.hls || [],
        dash: play.dash || [],
        free_episodes: play.freeNum,
        limited: play.limited || false,
      });
    }
  } catch (e) {
    console.error('Direct fallback stream error:', e.message);
  }

  res.status(502).json({ error: 'Stream unavailable' });
});

// DASH Manifest Parser — extract all resolutions from .mpd
app.get('/api/dash-manifest', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Referer': 'https://moviebox.ph/',
        'Accept': 'application/dash+xml, application/xml, */*',
      },
      redirect: 'follow',
      timeout: 15000,
    });

    if (!response.ok) return res.status(response.status).json({ error: 'Failed to fetch manifest', status: response.status });

    const xml = await response.text();

    // Parse ALL video representations from MPD XML (handle any attribute order)
    const resolutions = [];
    const videoAdaptation = xml.match(/<AdaptationSet[^>]*contentType="video"[^>]*>[\s\S]*?<\/AdaptationSet>/);
    const searchBlock = videoAdaptation ? videoAdaptation[0] : xml;

    // Match each Representation tag and extract attributes individually
    const repMatches = searchBlock.matchAll(/<Representation[^>]+>/g);
    for (const rep of repMatches) {
      const tag = rep[0];
      const idMatch = tag.match(/ id="([^"]+)"/);
      const bwMatch = tag.match(/ bandwidth="(\d+)"/);
      const wMatch = tag.match(/ width="(\d+)"/);
      const hMatch = tag.match(/ height="(\d+)"/);
      const mimeMatch = tag.match(/ mimeType="([^"]+)"/);

      // Skip audio-only representations
      if (mimeMatch && mimeMatch[1].startsWith('audio')) continue;
      if (!hMatch) continue;

      resolutions.push({
        id: idMatch ? idMatch[1] : String(resolutions.length),
        bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
        width: wMatch ? parseInt(wMatch[1]) : 0,
        height: parseInt(hMatch[1]),
        label: `${hMatch[1]}p`,
      });
    }

    // Parse codec
    const codecMatch = xml.match(/codecs="([^"]+)"/);
    const codec = codecMatch ? codecMatch[1] : 'unknown';

    // Parse duration
    const durMatch = xml.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(\d+\.?\d*)S"/);
    let duration = 0;
    if (durMatch) {
      duration = (parseInt(durMatch[1] || 0) * 3600) + (parseInt(durMatch[2] || 0) * 60) + parseFloat(durMatch[3]);
    }

    res.json({
      url: url,
      codec: codec,
      duration: duration,
      resolutions: resolutions.sort((a, b) => b.height - a.height),
    });
  } catch (e) {
    console.error('DASH manifest parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse manifest: ' + e.message });
  }
});

// Captions/Subtitles — resolved directly on this host (same reason as /api/stream)
app.get('/api/stream/:subject_id/captions', async (req, res) => {
  const { subject_id } = req.params;
  const { detail_path, se, ep } = req.query;
  if (!subject_id || !detail_path) return res.status(400).json({ error: 'Missing params' });

  const season = se || 1;
  const episode = ep || 1;
  const empty = { subject_id, se: season, ep: episode, count: 0, captions: [] };

  try {
    const play = await mbFetchPlay(subject_id, detail_path, season, episode);
    const streams = play.streams || [];
    const dash = play.dash || [];

    let streamId = null;
    let streamFormat = null;
    if (streams.length) {
      streamId = streams[0].id;
      streamFormat = streams[0].format || 'MP4';
    } else if (dash.length) {
      streamId = dash[0].id;
      streamFormat = dash[0].format || 'DASH';
    }
    if (!streamId) return res.json(empty);

    const { token } = await mbGetSession();
    const capHeaders = { ...CDN_HEADERS, 'Accept': 'application/json' };
    if (token) capHeaders['Authorization'] = `Bearer ${token}`;
    const capUrl = `${MB_API_BASE}/subject/caption?format=${encodeURIComponent(streamFormat)}&id=${streamId}&subjectId=${subject_id}&detailPath=${encodeURIComponent(detail_path)}`;
    const capRes = await fetch(capUrl, { headers: capHeaders, redirect: 'follow', timeout: 15000 });
    if (capRes.ok) {
      const capData = await capRes.json();
      const inner = capData.data;
      const captions = (inner && inner.captions) || (Array.isArray(inner) ? inner : []);
      return res.json({ subject_id, se: season, ep: episode, count: captions.length, captions });
    }
  } catch (e) {
    console.error('Direct captions error:', e.message);
  }

  // Fallback: Moviebox-API (Vercel)
  const data = await movieboxFetch(`/api/stream/${subject_id}/captions?detail_path=${encodeURIComponent(detail_path)}&se=${season}&ep=${episode}`);
  if (!data) return res.status(502).json({ error: 'Captions fetch failed', ...empty });
  res.json(data);
});

// Cast
app.get('/api/cast', async (req, res) => {
  const { type, id } = req.query;
  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/${mediaType}/${id}/credits`);
  if (!data) return res.json({ cast: [] });
  res.json({ cast: (data.cast || []).slice(0, 20) });
});

// TMDB ID lookup — search TMDB by movie title for embed fallback
app.get('/api/tmdb-id', async (req, res) => {
  const { title, year, type } = req.query;
  if (!title) return res.json({ tmdb_id: null });

  // Clean title — remove [Hindi], [CAM], etc.
  const cleanTitle = title.replace(/\[.*?\]/g, '').trim();

  const mediaType = type === 'tv' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/search/${mediaType}`, { query: cleanTitle, year: year || '' });
  if (!data || !data.results || data.results.length === 0) return res.json({ tmdb_id: null });

  // Return the first match
  const best = data.results[0];
  res.json({
    tmdb_id: best.id,
    title: best.title || best.name,
    type: mediaType,
    poster: best.poster_path ? TMDB_IMG + best.poster_path : '',
    year: (best.release_date || best.first_air_date || '').substring(0, 4),
  });
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎬 MovieBox running at http://localhost:${PORT}`);
  console.log(`📡 Moviebox-API: ${MOVIEBOX_API}`);
  console.log(`🔍 Search: MovieBox.ph (Hindi/Tamil/Telugu available)\n`);
});
