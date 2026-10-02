export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    // 2. Cloudflare Edge Proxy for /api/* routes
    if (url.pathname.startsWith('/api/')) {
      let targetUrl = '';

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q') || '';
        let mbItems = [];
        let tmdbItems = [];
        try {
          const r = await fetch(`https://moviebox-api-steel.vercel.app/search?q=${encodeURIComponent(q)}`).then(res => res.json());
          mbItems = (r.items || []).map(it => ({ id: it.subject_id, title: it.name, poster: it.poster_url, slug: it.slug, source: 'nexmovies', type: it.subject_type === 2 ? 'tv' : 'movie' }));
        } catch(e) {}
        try {
          const tmdbRes = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=15d2166f21f17216a3e2005f7701a0a5&query=${encodeURIComponent(q)}`).then(res => res.json());
          tmdbItems = (tmdbRes.results || []).filter(it => (it.media_type === 'movie' || it.media_type === 'tv') && it.poster_path).map(it => ({
            id: String(it.id), title: it.title || it.name || '', poster: `https://image.tmdb.org/t/p/w500${it.poster_path}`, slug: (it.title || it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'), source: 'tmdb', type: it.media_type
          }));
        } catch(e) {}
        const seen = new Set();
        const combined = [];
        for (const m of mbItems) { const k = m.title.toLowerCase().trim(); if (!seen.has(k)) { seen.add(k); combined.push(m); } }
        for (const t of tmdbItems) { const k = t.title.toLowerCase().trim(); if (!seen.has(k)) { seen.add(k); combined.push(t); } }
        return new Response(JSON.stringify({ movies: combined }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      if (url.pathname.startsWith('/api/home/categories')) {
        targetUrl = 'https://moviebox-api-steel.vercel.app/home/categories';
      } else if (url.pathname.startsWith('/api/home')) {
        targetUrl = 'https://moviebox-api-steel.vercel.app/home';
      } else if (url.pathname.startsWith('/api/recent-movies')) {
        targetUrl = 'https://moviebox-api-steel.vercel.app/movies?page=1';
      } else if (url.pathname.startsWith('/api/detail')) {
        const slug = url.searchParams.get('slug') || '';
        targetUrl = `https://moviebox-api-steel.vercel.app/detail/${encodeURIComponent(slug)}`;
      } else if (url.pathname.startsWith('/api/stream/')) {
        targetUrl = `https://moviebox-api-steel.vercel.app${url.pathname}${url.search}`;
      } else if (url.pathname.startsWith('/api/stream')) {
        const subjectId = url.searchParams.get('subject_id') || '';
        const slug = url.searchParams.get('slug') || '';
        const se = url.searchParams.get('se') || '0';
        const ep = url.searchParams.get('ep') || '0';
        targetUrl = `https://moviebox-api-steel.vercel.app/api/stream/${subjectId}?detail_path=${encodeURIComponent(slug)}&se=${se}&ep=${ep}`;
      } else if (url.pathname.startsWith('/api/proxy')) {
        const proxyUrl = url.searchParams.get('url');
        if (proxyUrl) targetUrl = proxyUrl;
      } else {
        targetUrl = `https://moviebox-api-steel.vercel.app${url.pathname.replace('/api', '')}${url.search}`;
      }

      if (!targetUrl) return new Response('Missing target URL', { status: 400 });

      try {
        const proxyHeaders = new Headers({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://moviebox.ph',
          'Referer': 'https://moviebox.ph/'
        });

        if (request.headers.get('range')) {
          proxyHeaders.set('Range', request.headers.get('range'));
        }

        const response = await fetch(targetUrl, {
          headers: proxyHeaders,
          redirect: 'follow'
        });

        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', '*');

        if (url.pathname.startsWith('/api/proxy') && url.searchParams.get('download') === '1') {
          const rawTitle = url.searchParams.get('title') || 'video';
          const asciiTitle = rawTitle.replace(/[^\x20-\x7E]/g, '').trim() || 'video';
          newHeaders.set('Content-Type', 'application/octet-stream');
          newHeaders.set('Content-Disposition', `attachment; filename="${asciiTitle}.mp4"; filename*=UTF-8''${encodeURIComponent(rawTitle)}.mp4`);
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy fetch failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Default: Serve static assets
    return env.ASSETS.fetch(request);
  }
};
