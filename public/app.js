const contentArea = document.getElementById('contentArea');
const loading = document.getElementById('loading');
const searchInput = document.getElementById('searchInput');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');

let currentPage = 'home';
let searchTimeout = null;
let currentDetail = null;
let currentSection = null;

// --- HEVC support detection (cached) ---
// VIP-locked qualities are only served as HEVC (h265) DASH. Browsers without
// HEVC decoding show a black screen with audio — detect support once here.
function canPlayHEVC() {
  if (window.__hevcSupport !== undefined) return window.__hevcSupport;
  let ok = false;
  const tests = [
    'video/mp4; codecs="hev1.1.6.L120.90"',
    'video/mp4; codecs="hvc1.1.6.L120.90"',
    'video/mp4; codecs="hev1"',
    'video/mp4; codecs="hvc1"',
  ];
  try {
    if (window.MediaSource && MediaSource.isTypeSupported) {
      ok = tests.some(t => MediaSource.isTypeSupported(t));
    }
    if (!ok) {
      const v = document.createElement('video');
      ok = tests.some(t => v.canPlayType(t) === 'probably' || v.canPlayType(t) === 'maybe');
      // 'maybe' from a bare codec string is unreliable; require real support
      ok = ok && tests.some(t => v.canPlayType(t) !== '');
      if (ok && !tests.some(t => v.canPlayType(t) === 'probably') && !(window.MediaSource && tests.some(t => MediaSource.isTypeSupported(t)))) {
        ok = false;
      }
    }
  } catch (e) { ok = false; }
  window.__hevcSupport = ok;
  return ok;
}

// Stop any running server-side transcode session
function stopCurrentTranscode() {
  if (window.__transcodeId) {
    try { fetch(`/api/transcode/${window.__transcodeId}/stop`); } catch (e) {}
    window.__transcodeId = null;
  }
}

// Rebuild the player with a different source, trying to keep playback position
async function switchToSource(src, type) {
  const resume = window.__artPlayer ? window.__artPlayer.currentTime : 0;
  if (!src) return;
  window.__currentStream.src = src;
  window.__currentStream.type = type;
  window.__pendingSeek = resume > 2 ? resume : 0;
  initArtPlayer();
}

// Start a server-side HEVC->H.264 transcode for a requested height and play it
async function playTranscodedQuality(height) {
  const stream = window.__currentStream;
  const art = window.__artPlayer;
  if (!stream || !stream.dashUrl) return false;
  if (art) art.notice.show = `Transcoding ${height}p (HEVC → H.264), please wait…`;
  try {
    const tc = await fetch(`/api/transcode/start?url=${encodeURIComponent(stream.dashUrl)}&height=${height}`).then(r => r.json());
    if (tc && tc.playlist) {
      stopCurrentTranscode();
      window.__transcodeId = tc.id;
      await switchToSource(tc.playlist, 'application/x-mpegURL');
      const qualityLabel = document.getElementById('qualityLabel');
      if (qualityLabel) qualityLabel.textContent = height + 'p';
      return true;
    }
    if (art) art.notice.show = (tc && tc.error) || 'Transcode unavailable on this server';
  } catch (e) {
    if (art) art.notice.show = 'Transcode failed to start';
  }
  return false;
}

// --- PWA Installation ---
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  console.log('PWA Install prompt ready');
});

async function triggerInstall() {
  if (!deferredPrompt) {
    alert('Installation is currently handled by your browser menu (Add to Home Screen) or Nexmovies is already installed.');
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User response to the install prompt: ${outcome}`);
  deferredPrompt = null;
}

document.querySelectorAll('#installAppBtn, #topInstallBtn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    triggerInstall();
  });
});

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('SW Registered', reg))
      .catch(err => console.log('SW Registration Failed', err));
  });
}

// --- Sidebar ---
sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 768 && !sidebar.contains(e.target) && e.target !== sidebarToggle) {
    sidebar.classList.remove('open');
  }
});

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    currentPage = item.dataset.page;
    currentSection = null;
    sidebar.classList.remove('open');
    loadPage();
  });
});

// --- Nexmovies logo click → back to home page ---
(function bindLogoHome() {
  const logo = document.querySelector('.sidebar-logo');
  if (!logo) return;
  logo.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const homeItem = document.querySelector('.nav-item[data-page="home"]');
    if (homeItem) homeItem.classList.add('active');
    currentPage = 'home';
    currentSection = null;
    sidebar.classList.remove('open');
    stopCurrentTranscode();
    destroyPlayers();
    window.scrollTo({ top: 0 });
    loadPage();
  });
})();

// --- "Not available right now" toast for faded/disabled items ---
function showSoonToast() {
  let t = document.getElementById('soonToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'soonToast';
    t.className = 'soon-toast';
    t.textContent = 'Not available right now';
    document.body.appendChild(t);
  }
  t.classList.add('show');
  clearTimeout(t.__hideTimer);
  t.__hideTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

document.querySelectorAll('.nav-disabled, .soon-faded').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showSoonToast();
  });
});

// --- Detail page back navigation ---
// Snapshot the browse state before opening a detail page so "Back" returns
// the user exactly where they were (home / section / search results).
function destroyPlayers() {
  if (window.__artPlayer) { try { window.__artPlayer.destroy(); } catch (e) {} window.__artPlayer = null; }
  if (window.__dashPlayer) { try { window.__dashPlayer.reset(); } catch (e) {} window.__dashPlayer = null; }
  if (window.__hlsPlayer) { try { window.__hlsPlayer.destroy(); } catch (e) {} window.__hlsPlayer = null; }
}

function captureBrowseState() {
  // Only capture when NOT already inside a detail page
  if (document.querySelector('.detail-page')) return;
  const q = searchInput ? searchInput.value.trim() : '';
  window.__browseState = {
    page: currentPage,
    section: currentSection,
    query: q,
    scrollY: window.scrollY || 0,
  };
}

function detailBack() {
  stopCurrentTranscode();
  destroyPlayers();
  const st = window.__browseState || { page: 'home', section: null, query: '' };
  currentPage = st.page || 'home';
  currentSection = st.section || null;
  if (st.query) {
    if (searchInput) searchInput.value = st.query;
    searchMovies(st.query);
  } else {
    loadPage();
  }
  setTimeout(() => window.scrollTo({ top: st.scrollY || 0 }), 50);
}

// Handle Back Button
window.onpopstate = (event) => {
  if (document.querySelector('.detail-page')) {
    detailBack();
  }
};

// --- Search + Autocomplete ---
let suggestTimeout = null;
let activeSuggestIndex = -1;

// Create suggestions dropdown
const suggestDropdown = document.createElement('div');
suggestDropdown.className = 'search-suggest';
suggestDropdown.id = 'searchSuggest';
searchInput.parentNode.style.position = 'relative';
searchInput.parentNode.appendChild(suggestDropdown);

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  clearTimeout(suggestTimeout);
  const q = searchInput.value.trim();
  activeSuggestIndex = -1;

  if (q.length === 0) {
    suggestDropdown.classList.remove('show');
    suggestDropdown.innerHTML = '';
    currentSection = null;
    loadPage();
    return;
  }

  // Fetch suggestions after 200ms delay
  suggestTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const suggestions = data.suggestions || [];
      if (suggestions.length > 0 && document.activeElement === searchInput) {
        suggestDropdown.innerHTML = suggestions.map((s, i) =>
          `<div class="suggest-item" data-word="${esc(s.word)}" data-index="${i}">${esc(s.word)}</div>`
        ).join('');
        suggestDropdown.classList.add('show');
        // Bind click on suggestions
        suggestDropdown.querySelectorAll('.suggest-item').forEach(item => {
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            searchInput.value = item.dataset.word;
            suggestDropdown.classList.remove('show');
            searchMovies(item.dataset.word);
          });
        });
      } else {
        suggestDropdown.classList.remove('show');
      }
    } catch (err) { /* ignore */ }
  }, 200);

  // Also do full search after 400ms
  searchTimeout = setTimeout(() => {
    if (q.length >= 2) searchMovies(q);
  }, 400);
});

searchInput.addEventListener('keydown', (e) => {
  const items = suggestDropdown.querySelectorAll('.suggest-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSuggestIndex = Math.min(activeSuggestIndex + 1, items.length - 1);
    items.forEach((it, i) => it.classList.toggle('active', i === activeSuggestIndex));
    if (items[activeSuggestIndex]) searchInput.value = items[activeSuggestIndex].dataset.word;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestIndex = Math.max(activeSuggestIndex - 1, 0);
    items.forEach((it, i) => it.classList.toggle('active', i === activeSuggestIndex));
    if (items[activeSuggestIndex]) searchInput.value = items[activeSuggestIndex].dataset.word;
  } else if (e.key === 'Enter') {
    clearTimeout(searchTimeout);
    clearTimeout(suggestTimeout);
    suggestDropdown.classList.remove('show');
    const q = searchInput.value.trim();
    if (q) searchMovies(q);
  } else if (e.key === 'Escape') {
    suggestDropdown.classList.remove('show');
  }
});

// Close suggestions on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) {
    suggestDropdown.classList.remove('show');
  }
});

// --- Fetch ---
async function apiFetch(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
    console.error('API error:', url, e);
    return { movies: [] };
  }
}

// --- Extract language from title (legacy) ---
function extractLanguage(title) {
  if (!title) return null;
  const langPatterns = {
    'Hindi': /\[?hindi\]?/i,
    'Tamil': /\[?tamil\]?/i,
    'Telugu': /\[?telugu\]?/i,
    'Malayalam': /\[?malayalam\]?/i,
    'Kannada': /\[?kannada\]?/i,
    'Bengali': /\[?bengali\]?/i,
    'Punjabi': /\[?punjabi\]?/i,
    'Marathi': /\[?marathi\]?/i,
    'Gujarati': /\[?gujarati\]?/i,
    'Korean': /\[?korean\]?|k-drama/i,
    'Japanese': /\[?japanese\]?|anime/i,
    'Chinese': /\[?chinese\]?/i,
    'Thai': /\[?thai\]?/i,
    'Spanish': /\[?spanish\]?/i,
    'French': /\[?french\]?/i,
    'Portuguese': /\[?portuguese\]?/i,
    'Turkish': /\[?turkish\]?/i,
  };

  for (const [lang, pattern] of Object.entries(langPatterns)) {
    if (pattern.test(title)) return lang;
  }
  return null;
}

// Map a language code or a title/badge into a display label.
function mapLanguage(value) {
  if (!value) return null;
  // If it's already a 2-letter code, map commonly used ones
  const code = ('' + value).trim().toLowerCase();
  const codeMap = {
    en: 'English',
    hi: 'Hindi',
    ta: 'Tamil',
    te: 'Telugu',
    ml: 'Malayalam',
    kn: 'Kannada',
    bn: 'Bengali',
    pa: 'Punjabi',
    mr: 'Marathi',
    gu: 'Gujarati',
    ko: 'Korean',
    ja: 'Japanese',
    zh: 'Chinese',
    th: 'Thai',
    es: 'Spanish',
    fr: 'French',
    pt: 'Portuguese',
    tr: 'Turkish',
  };
  if (code.length === 2 && codeMap[code]) return codeMap[code];

  // If it's a full name already (e.g. 'Japanese'), normalize capitalization
  const normalized = value.trim();
  for (const v of Object.values(codeMap)) {
    if (v.toLowerCase() === normalized.toLowerCase()) return v;
  }

  // Fall back to extracting from the title string (legacy bracketed markers or 'anime')
  return extractLanguage(normalized);
}

// --- Extract quality from badge ---
function extractQuality(badge) {
  if (!badge) return null;
  const match = badge.match(/(\d+p)/i);
  return match ? match[1] : null;
}

// --- Load page ---
async function loadPage() {
  // Clear global scroll handlers from previous pages
  if (window.__mtScrollHandler) { window.removeEventListener('scroll', window.__mtScrollHandler); window.__mtScrollHandler = null; }
  if (window.__sectionScrollHandler) { window.removeEventListener('scroll', window.__sectionScrollHandler); window.__sectionScrollHandler = null; }
  if (window.__mwScrollHandler) { window.removeEventListener('scroll', window.__mwScrollHandler); window.__mwScrollHandler = null; }
  if (window.__imdbScrollHandler) { window.removeEventListener('scroll', window.__imdbScrollHandler); window.__imdbScrollHandler = null; }
  if (window.__hindiScrollHandler) { window.removeEventListener('scroll', window.__hindiScrollHandler); window.__hindiScrollHandler = null; }
  if (window.__genreScrollHandler) { window.removeEventListener('scroll', window.__genreScrollHandler); window.__genreScrollHandler = null; }
  stopCurrentTranscode();
  destroyPlayers();

  showLoading();
  contentArea.innerHTML = '';
  if (currentSection) {
    await loadSectionPage(currentSection);
  } else if (currentPage === 'home') {
    await loadHomePage();
  } else if (currentPage === 'tv') {
    await loadCategoryPage('tv', 'TV Shows', '/api/tv-series');
  } else if (currentPage === 'movie') {
    await loadCategoryPage('movie', 'Movies', '/api/movies');
  } else if (currentPage === 'animation') {
    await loadCategoryPage('animation', 'Animation', '/api/animation');
  } else if (currentPage === 'trending') {
    await loadMostWatchedPage();
  } else if (currentPage === 'top-imdb') {
    await loadTopImdbPage();
  } else if (currentPage === 'hindi') {
    await loadHindiPage();
  } else if (currentPage === 'categories') {
    await loadCategoriesPage();
  } else {
    await loadHomePage();
  }
  hideLoading();
}

// --- Home page with sectioned layout ---
async function loadHomePage() {
  // Show light skeletons while we fetch data to avoid blank content
  contentArea.innerHTML = `<div class="hero-banner skeleton-hero" style="height:400px;margin-bottom:32px;border-radius:12px;background:linear-gradient(90deg,#0d0d0d,#111)"></div><div id="skeletonRows"></div>`;

  const data = await apiFetch('/api/home');
  const sections = data.sections || [];

  if (!sections.length) {
    contentArea.innerHTML = '<div class="no-results"><p>No content found</p></div>';
    return;
  }

  // Hero carousel — pull ONLY from the "Recently Released Movies" collection
  // (movie-only feed with proper backdrops, year, genre and rating).
  let heroSlides = [];
  try {
    const rec = await apiFetch('/api/recent-movies');
    heroSlides = (rec.items || []).filter(it => it.type === 'movie' && it.backdrop);
  } catch (e) { heroSlides = []; }

  // Fallback only if the recent-movies feed is unavailable: use the Banner
  // section so the hero never renders empty.
  let heroRowTitle = null; // home section hidden from the rows because it's in the hero
  if (!heroSlides.length) {
    const banner = sections.find(s => /banner/i.test(s.title));
    if (banner && banner.items.length) {
      heroRowTitle = banner.title;
      banner.items.forEach(it => {
        const img = it.backdrop || it.poster || '';
        if (img) heroSlides.push(it);
      });
    }
  }
  const hero = heroSlides.length > 0 ? heroSlides[0] : null;

  let html = '';

  // Hero banner — auto-sliding carousel with arrows + dots
  if (heroSlides.length > 0) {
    const slidesHtml = heroSlides.map((it, i) => {
      const img = it.backdrop || it.poster || '';
      const year = it.year || '';
      const genre = it.genre || '';
      return `
        <div class="hero-slide${i === 0 ? ' active' : ''}" data-source="${it.source || 'tmdb'}" data-type="${it.type || 'movie'}" data-id="${it.id || ''}" data-slug="${it.slug || ''}">
          <img src="${img}" alt="${esc(it.title)}" class="hero-backdrop" loading="${i === 0 ? 'eager' : 'lazy'}">
          <div class="hero-overlay"></div>
          <div class="hero-content">
            <h2 class="hero-title">${esc(it.title)}</h2>
            <div class="hero-meta">
              ${year ? `<span class="hero-year">${year}</span>` : ''}
              ${genre ? `<span class="hero-genre">${esc(genre)}</span>` : ''}
              ${it.rating ? `<span class="hero-rating">⭐ ${it.rating}</span>` : ''}
            </div>
            <button class="hero-play-btn" data-action="play">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              Play Now
            </button>
          </div>
        </div>`;
    }).join('');

    const dotsHtml = heroSlides.map((_, i) =>
      `<button class="hero-dot${i === 0 ? ' active' : ''}" data-index="${i}" aria-label="Go to slide ${i + 1}"></button>`
    ).join('');

    html += `
      <div class="hero-banner" id="heroBanner">
        <div class="hero-slides">${slidesHtml}</div>
        ${heroSlides.length > 1 ? `
        <button class="hero-arrow hero-prev" aria-label="Previous slide">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <button class="hero-arrow hero-next" aria-label="Next slide">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
        </button>
        <div class="hero-dots">${dotsHtml}</div>` : ''}
      </div>`;
  }

  // Render each real section as a horizontal row with overlay carousel arrows
  for (const section of sections) {
    const items = section.items || [];
    if (!items.length) continue;

    // Skip the section that the hero fallback is showing (avoid duplicate row)
    if (heroRowTitle && section.title === heroRowTitle && hero) continue;

    const sectionKey = section.title.replace(/^[^\w+]+|[^\w+]+$/g, '').toLowerCase();
    html += `<div class="movie-row" data-section="${esc(sectionKey)}" data-section-title="${esc(section.title)}" data-page="1">
      <div class="row-header">
        <h2 class="row-title">${esc(section.title)}</h2>
        <div class="row-header-right">
          <a href="#" class="row-more" data-section="${esc(sectionKey)}" data-section-title="${esc(section.title)}">More
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
          </a>
        </div>
      </div>
      <div class="row-wrap">
        <div class="row-scroll">${items.map(renderCard).join('')}</div>
        <button class="row-arrow row-arrow-left" aria-label="Previous items">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <button class="row-arrow row-arrow-right" aria-label="Next items">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
        </button>
      </div>
    </div>`;
  }

  // Most Trending — infinite-scroll grid at the bottom
  html += `<div class="movie-row most-trending">
    <div class="row-header"><h2 class="row-title">🔥 Most Trending</h2></div>
    <div class="mt-grid" id="mtGrid"></div>
    <div class="mt-loading" id="mtLoading">Loading more...</div>
  </div>`;

  // Top IMDB Rated — horizontal row
  try {
    const imdbData = await apiFetch('/api/top-imdb?page=1');
    const imdbItems = (imdbData.items || []).slice(0, 20).map(it => ({
      id: it.subject_id, title: it.name || 'Untitled', poster: it.poster_url || '',
      slug: it.slug, badge: it.badge || '', rating: it.rating || null,
      source: 'moviebox', type: 'moviebox',
    }));
    if (imdbItems.length) {
      html += `<div class="movie-row" data-feed="top-imdb" data-page="1">
        <div class="row-header">
          <h2 class="row-title">🏆 Top IMDB Rated</h2>
          <div class="row-header-right">
            <a href="#" class="row-more" data-page="top-imdb">More
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
            </a>
          </div>
        </div>
        <div class="row-wrap">
          <div class="row-scroll">${imdbItems.map(renderCard).join('')}</div>
          <button class="row-arrow row-arrow-left" aria-label="Previous items">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <button class="row-arrow row-arrow-right" aria-label="Next items">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
          </button>
        </div>
      </div>`;
    }
  } catch (e) { /* skip if unavailable */ }

  contentArea.innerHTML = html;
  attachCardListeners();
  bindCarouselArrows();
  bindSectionLinks();
  initHeroBanner();
  initMostTrending();
}

// --- Hero banner auto-rotation + controls ---
let heroState = { timer: null, index: 0, slides: [], dots: [], paused: false };

function initHeroBanner() {
  const banner = document.getElementById('heroBanner');
  if (!banner) return;
  const slides = Array.from(banner.querySelectorAll('.hero-slide'));
  const dots = Array.from(banner.querySelectorAll('.hero-dot'));
  if (slides.length <= 1) return;

  // Respect user motion preference
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (heroState.timer) clearInterval(heroState.timer);
  heroState = { timer: null, index: 0, slides, dots, paused: false };

  const show = (idx) => {
    heroState.index = (idx + slides.length) % slides.length;
    slides.forEach((s, i) => s.classList.toggle('active', i === heroState.index));
    dots.forEach((d, i) => d.classList.toggle('active', i === heroState.index));

    // staggered overlay reveal (simple CSS-friendly toggle)
    slides.forEach((s, i) => {
      const content = s.querySelector('.hero-content');
      if (!content) return;
      if (i === heroState.index) {
        content.style.opacity = '0';
        content.style.transform = 'translateY(8px)';
        // allow the crossfade to settle then animate content in
        requestAnimationFrame(() => setTimeout(() => {
          content.style.transition = 'opacity 360ms ease, transform 360ms ease';
          content.style.opacity = '1';
          content.style.transform = 'none';
        }, 80));
      } else {
        content.style.transition = ''; content.style.opacity = '0'; content.style.transform = 'translateY(8px)';
      }
    });

    // Preload the next slide's image for smoother transitions
    const nextIndex = (heroState.index + 1) % slides.length;
    const nextImg = slides[nextIndex].querySelector('.hero-backdrop');
    if (nextImg && nextImg.dataset && nextImg.dataset.preloaded !== '1') {
      const pre = new Image();
      pre.src = nextImg.src;
      nextImg.dataset.preloaded = '1';
    }
  };

  const next = () => show(heroState.index + 1);
  const prev = () => show(heroState.index - 1);

  const start = () => {
    stop();
    // Always auto-advance — the CSS reduced-motion media query already strips
    // the animated transitions for users who prefer reduced motion.
    heroState.timer = setInterval(() => {
      if (!heroState.paused) next();
    }, 6000);
  };
  const stop = () => { if (heroState.timer) { clearInterval(heroState.timer); heroState.timer = null; } };

  // Controls
  const prevBtn = banner.querySelector('.hero-prev');
  const nextBtn = banner.querySelector('.hero-next');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); prev(); start(); });
  if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); next(); start(); });

  dots.forEach((d, i) => d.addEventListener('click', (e) => { e.stopPropagation(); show(i); start(); }));

  // Pause on hover and on focus-within
  banner.setAttribute('tabindex', '0');
  banner.addEventListener('mouseenter', () => { heroState.paused = true; });
  banner.addEventListener('mouseleave', () => { heroState.paused = false; });
  banner.addEventListener('focusin', () => { heroState.paused = true; });
  banner.addEventListener('focusout', () => { heroState.paused = false; });

  // Keyboard navigation when focused
  banner.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); start(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); start(); }
  });

  // Touch / swipe support (simple thresholded swipe)
  let touchStartX = 0, touchMoveX = 0;
  banner.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches[0]) touchStartX = e.touches[0].clientX;
  }, { passive: true });
  banner.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches[0]) touchMoveX = e.touches[0].clientX;
  }, { passive: true });
  banner.addEventListener('touchend', (e) => {
    const delta = touchMoveX - touchStartX;
    if (Math.abs(delta) > 40) {
      if (delta < 0) next(); else prev();
      start();
    }
    touchStartX = touchMoveX = 0;
  });

  // Click on active slide opens detail
  slides.forEach((s) => {
    s.addEventListener('click', (e) => {
      if (e.target.closest('.hero-arrow') || e.target.closest('.hero-dot') || e.target.closest('[data-action="play"]')) return;
      openDetail(s.dataset.source, s.dataset.type, s.dataset.id, s.dataset.slug);
    });
  });

  // Play button opens detail
  banner.querySelectorAll('[data-action="play"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slide = btn.closest('.hero-slide');
      openDetail(slide.dataset.source, slide.dataset.type, slide.dataset.id, slide.dataset.slug);
    });
  });

  // Initialize content opacity for slides
  slides.forEach((s, i) => {
    const content = s.querySelector('.hero-content');
    if (content) { content.style.opacity = i === 0 ? '1' : '0'; content.style.transform = i === 0 ? 'none' : 'translateY(8px)'; }
  });

  start();
}

// --- Carousel arrow navigation (item-by-item, seamless row loading) ---
function bindCarouselArrows() {
  document.querySelectorAll('.movie-row[data-section], .movie-row[data-feed]').forEach(row => {
    if (row.dataset.carouselInit) return;
    row.dataset.carouselInit = '1';

    const scroll = row.querySelector('.row-scroll');
    if (!scroll) return;
    const left = row.querySelector('.row-arrow-left');
    const right = row.querySelector('.row-arrow-right');
    if (!left || !right) return;

    const state = {
      page: parseInt(row.dataset.page) || 1,
      loading: false,
      done: false,
      seen: new Set(),
    };
    scroll.querySelectorAll('.movie-card').forEach(c => { if (c.dataset.id) state.seen.add(c.dataset.id); });

    const canLoadMore = () => !!row.dataset.sectionTitle || !!row.dataset.feed;

    // Slide one item at a time (card width + gap)
    const itemStep = () => {
      const card = scroll.querySelector('.movie-card');
      if (!card) return Math.round(scroll.clientWidth * 0.8);
      const styles = getComputedStyle(scroll);
      const gap = parseFloat(styles.gap || styles.columnGap) || 16;
      return card.offsetWidth + gap;
    };

    const updateArrows = () => {
      const maxScroll = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      // Left arrow: visible only after the first slide right
      left.classList.toggle('hidden', scroll.scrollLeft <= 2);
      // Right arrow: hidden only when truly nothing more to show
      const atEnd = scroll.scrollLeft >= maxScroll - 2;
      const noOverflow = scroll.scrollWidth <= scroll.clientWidth + 2;
      right.classList.toggle('hidden', (atEnd && state.done) || (noOverflow && !canLoadMore()) || (noOverflow && state.done));
    };

    // Fetch and append the next page of items for this row (seamless)
    async function loadMoreRow() {
      if (state.loading || state.done || !canLoadMore()) return;
      state.loading = true;
      right.classList.add('loading');
      try {
        const nextPage = state.page + 1;
        const url = row.dataset.feed === 'top-imdb'
          ? `/api/top-imdb?page=${nextPage}`
          : `/api/section?name=${encodeURIComponent(row.dataset.sectionTitle)}&page=${nextPage}&row=1`;
        const data = await apiFetch(url);
        const items = (data.items || []).map(it => ({
          id: it.subject_id || it.id,
          title: it.name || it.title || 'Untitled',
          poster: it.poster_url || it.poster || '',
          slug: it.slug,
          badge: it.badge || '',
          rating: it.rating || null,
          source: 'moviebox',
          type: 'moviebox',
        }));
        const fresh = items.filter(it => it.id && !state.seen.has(it.id));
        fresh.forEach(it => state.seen.add(it.id));
        if (fresh.length) {
          scroll.insertAdjacentHTML('beforeend', fresh.map(renderCard).join(''));
          attachCardListeners();
          state.page = nextPage;
          if (data.hasMore === false || !items.length) state.done = true;
        } else {
          state.done = true;
        }
      } catch (e) {
        console.error('Row load-more failed:', e);
      }
      state.loading = false;
      right.classList.remove('loading');
      updateArrows();
    }

    right.addEventListener('click', async () => {
      // Seamless: prefetch the next page when we're about to reach the end
      const nearEnd = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - itemStep() * 1.5;
      if (nearEnd) await loadMoreRow();
      scroll.scrollBy({ left: itemStep(), behavior: 'smooth' });
      setTimeout(updateArrows, 450);
    });

    left.addEventListener('click', () => {
      scroll.scrollBy({ left: -itemStep(), behavior: 'smooth' });
      setTimeout(updateArrows, 450);
    });

    // rAF-throttled scroll/resize observer: updates arrows + seamless prefetch
    let rafId = null;
    const rafHandler = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        updateArrows();
        const nearEnd = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - itemStep() * 2;
        if (nearEnd) loadMoreRow();
        rafId = null;
      });
    };
    scroll.addEventListener('scroll', rafHandler, { passive: true });
    window.addEventListener('resize', rafHandler);

    updateArrows();
  });
}

// --- Section "See More" links ---
function bindSectionLinks() {
  document.querySelectorAll('.row-more').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      // If the link targets a page (e.g. Top IMDB), switch to that page
      if (link.dataset.page) {
        currentPage = link.dataset.page;
        currentSection = null;
        // Update sidebar active state
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navItem = document.querySelector(`.nav-item[data-page="${link.dataset.page}"]`);
        if (navItem) navItem.classList.add('active');
        window.scrollTo({ top: 0 });
        loadPage();
        return;
      }
      // Otherwise open the section "See More" page
      currentSection = link.dataset.section;
      window.scrollTo({ top: 0 });
      loadPage();
    });
  });

  // "See More" cards at the end of each row
  document.querySelectorAll('.see-more-card').forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // If the card targets a page (e.g. Top IMDB), switch to that page
      if (card.dataset.page) {
        currentPage = card.dataset.page;
        currentSection = null;
        // Update sidebar active state
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navItem = document.querySelector(`.nav-item[data-page="${card.dataset.page}"]`);
        if (navItem) navItem.classList.add('active');
        window.scrollTo({ top: 0 });
        loadPage();
        return;
      }
      // Otherwise open the section "See More" page
      currentSection = card.dataset.section;
      window.scrollTo({ top: 0 });
      loadPage();
    });
  });
}

// --- Most Trending infinite scroll ---
let mtState = { page: 1, loading: false, done: false, seen: new Set() };

async function initMostTrending() {
  mtState = { page: 1, loading: false, done: false, seen: new Set() };
  const grid = document.getElementById('mtGrid');
  if (grid) grid.innerHTML = '';
  await loadMoreTrending();

  // Infinite scroll on window
  window.__mtScrollHandler = async () => {
    const loading = document.getElementById('mtLoading');
    if (!loading) return;
    const rect = loading.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) {
      await loadMoreTrending();
    }
  };
  window.addEventListener('scroll', window.__mtScrollHandler, { passive: true });
}

async function fetchTrendingPage(page) {
  const cats = ['movie', 'tv', 'animation'];
  const idx = (page - 1) % cats.length;
  const cat = cats[idx];
  const endpoint = cat === 'movie' ? '/api/movies'
    : cat === 'tv' ? '/api/tv-series' : '/api/animation';
  const data = await apiFetch(`${endpoint}?page=${page}`);
  const items = (data.items || []).map(it => ({
    id: it.subject_id,
    title: it.name || 'Untitled',
    poster: it.poster_url || '',
    slug: it.slug,
    badge: it.badge || '',
    source: 'moviebox',
    type: 'moviebox',
  }));
  return items;
}

async function loadMoreTrending() {
  if (mtState.loading || mtState.done) return;
  mtState.loading = true;

  const grid = document.getElementById('mtGrid');
  const loading = document.getElementById('mtLoading');
  if (loading) loading.textContent = 'Loading more...';

  try {
    const items = await fetchTrendingPage(mtState.page);
    if (!items.length) {
      mtState.done = true;
      if (loading) {
        loading.textContent = mtState.seen.size ? 'You have reached the end.' : 'No content found.';
        loading.classList.add('mt-end');
      }
      mtState.loading = false;
      return;
    }

    const fresh = items.filter(it => it.id && !mtState.seen.has(it.id));
    fresh.forEach(it => mtState.seen.add(it.id));

    if (grid && fresh.length) {
      grid.insertAdjacentHTML('beforeend', fresh.map(renderCard).join(''));
      attachCardListeners();
    }

    mtState.page += 1;
    if (mtState.page > 30) {
      mtState.done = true;
      if (loading) { loading.textContent = 'You have reached the end.'; loading.classList.add('mt-end'); }
    }
  } catch (e) {
    console.error('Most Trending load error:', e);
    mtState.done = true;
    if (loading) { loading.textContent = 'Failed to load more.'; loading.classList.add('mt-end'); }
  }
  mtState.loading = false;
}

// --- Section "See More" page ---
let sectionState = { page: 1, loading: false, done: false, title: '' };

async function loadSectionPage(sectionKey) {
  // show a lightweight skeleton page while first page loads
  contentArea.innerHTML = `<div class="section-page">
    <div class="section-head">
      <button class="back-btn" onclick="goHome()">‹ Back</button>
      <h1 class="section-title">${esc(sectionKey)}</h1>
    </div>
    <div class="movie-grid section-grid" id="sectionGrid">
      ${new Array(12).fill(0).map(()=> `<div class="movie-card skeleton-card"><div class="card-poster" style="background:linear-gradient(90deg,#111,#0f0f0f);height:230px;border-radius:10px"></div><div style="height:12px;margin-top:8px;background:#111;border-radius:4px"></div></div>`).join('')}
    </div>
    <div class="mt-loading" id="sectionLoading"></div>
  </div>`;

  const data = await apiFetch(`/api/section?name=${encodeURIComponent(sectionKey)}&page=1`);
  const items = data.items || [];
  sectionState = { page: 1, loading: false, done: !data.hasMore, title: data.title || sectionKey };

  if (!items.length) {
    contentArea.innerHTML = `<div class="section-page">
      <button class="back-btn" onclick="goHome()">‹ Back</button>
      <div class="no-results"><p>No content found</p></div>
    </div>`;
    hideLoading();
    return;
  }

  contentArea.innerHTML = `<div class="section-page">
    <div class="section-head">
      <button class="back-btn" onclick="goHome()">‹ Back</button>
      <h1 class="section-title">${esc(sectionState.title)}</h1>
    </div>
    <div class="movie-grid section-grid" id="sectionGrid">${items.map(renderCard).join('')}</div>
    <div class="mt-loading" id="sectionLoading"></div>
  </div>`;
  attachCardListeners();
  initSectionMore();
}

function goHome() {
  currentSection = null;
  loadPage();
}

function initSectionMore() {
  const sentinel = document.getElementById('sectionLoading');
  if (!sentinel) return;
  let autoPulls = 0;
  const maybeLoad = async () => {
    if (sectionState.loading || sectionState.done) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 400) {
      await loadMoreSection();
      // If the page still doesn't overflow, keep pulling (up to 4 pages) so
      // short first pages fill the screen without requiring a scroll gesture.
      if (!sectionState.done && autoPulls < 4) {
        autoPulls++;
        const r2 = document.getElementById('sectionLoading')?.getBoundingClientRect();
        if (r2 && r2.top < window.innerHeight + 400) setTimeout(maybeLoad, 250);
      }
    }
  };
  window.__sectionScrollHandler = maybeLoad;
  window.addEventListener('scroll', window.__sectionScrollHandler, { passive: true });
  // Kick off immediately in case the grid is already shorter than the viewport
  setTimeout(maybeLoad, 250);
}

async function loadMoreSection() {
  if (sectionState.loading || sectionState.done) return;
  sectionState.loading = true;
  const grid = document.getElementById('sectionGrid');
  const loading = document.getElementById('sectionLoading');
  if (loading) loading.textContent = 'Loading more...';
  try {
    const data = await apiFetch(`/api/section?name=${encodeURIComponent(sectionState.title)}&page=${sectionState.page + 1}`);
    const items = data.items || [];
    sectionState.page += 1;
    if (!items.length) {
      sectionState.done = true;
      if (loading) { loading.textContent = 'You have reached the end.'; loading.classList.add('mt-end'); }
    } else {
      if (grid) { grid.insertAdjacentHTML('beforeend', items.map(renderCard).join('')); attachCardListeners(); }
      if (!data.hasMore) {
        sectionState.done = true;
        if (loading) { loading.textContent = 'You have reached the end.'; loading.classList.add('mt-end'); }
      }
    }
  } catch (e) {
    sectionState.done = true;
    if (loading) { loading.textContent = 'Failed to load more.'; loading.classList.add('mt-end'); }
  }
  sectionState.loading = false;
}

// --- Category pages (using home sections data) ---
async function loadCategoryPage(category, title, endpoint) {
  const data = await apiFetch('/api/home/categories');
  const sections = data[category] || [];

  if (!sections.length) {
    contentArea.innerHTML = `<div class="no-results"><p>No ${title} content found</p></div>`;
    return;
  }

  let html = '';
  for (const section of sections) {
    if (!section.items || !section.items.length) continue;
    const sectionKey = section.title.replace(/^[^\w+]+|[^\w+]+$/g, '').toLowerCase();
    html += `<div class="movie-row" data-section="${esc(sectionKey)}" data-section-title="${esc(section.title)}" data-page="1">
      <div class="row-header">
        <h2 class="row-title">${esc(section.title)}</h2>
        <div class="row-header-right">
          <a href="#" class="row-more" data-section="${esc(sectionKey)}" data-section-title="${esc(section.title)}">More
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
          </a>
        </div>
      </div>
      <div class="row-wrap">
        <div class="row-scroll">${section.items.map(renderCard).join('')}</div>
        <button class="row-arrow row-arrow-left" aria-label="Previous items">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <button class="row-arrow row-arrow-right" aria-label="Next items">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
        </button>
      </div>
    </div>`;
  }

  contentArea.innerHTML = html;
  attachCardListeners();
  bindCarouselArrows();
  bindSectionLinks();
}

// --- Most Watched page ---
let mwState = { page: 1, loading: false, done: false };

async function loadMostWatchedPage() {
  mwState = { page: 1, loading: false, done: false };

  contentArea.innerHTML = `<div class="movie-row">
    <div class="row-header"><h2 class="row-title">📈 Most Watched</h2></div>
    <div class="movie-grid" id="mwGrid"></div>
    <div class="mt-loading" id="mwLoading">Loading...</div>
  </div>`;

  await loadMoreMostWatched();

  window.__mwScrollHandler = async () => {
    const el = document.getElementById('mwLoading');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) await loadMoreMostWatched();
  };
  window.addEventListener('scroll', window.__mwScrollHandler, { passive: true });
}

async function loadMoreMostWatched() {
  if (mwState.loading || mwState.done) return;
  mwState.loading = true;

  const grid = document.getElementById('mwGrid');
  const loadEl = document.getElementById('mwLoading');
  if (loadEl) loadEl.textContent = 'Loading more...';

  try {
    const data = await apiFetch(`/api/ranking?page=${mwState.page}`);
    const items = (data.items || []).map(it => ({
      id: it.subject_id, title: it.name || 'Untitled', poster: it.poster_url || '',
      slug: it.slug, badge: it.badge || '', rating: it.rating || null,
      source: 'moviebox', type: 'moviebox',
    }));

    if (!items.length) {
      mwState.done = true;
      if (loadEl) { loadEl.textContent = mwState.page === 1 ? 'No content found.' : 'You have reached the end.'; loadEl.classList.add('mt-end'); }
      mwState.loading = false;
      return;
    }

    if (grid) { grid.insertAdjacentHTML('beforeend', items.map(renderCard).join('')); attachCardListeners(); }
    mwState.page += 1;
    if (mwState.page > 30) {
      mwState.done = true;
      if (loadEl) { loadEl.textContent = 'You have reached the end.'; loadEl.classList.add('mt-end'); }
    }
  } catch (e) {
    mwState.done = true;
    if (loadEl) { loadEl.textContent = 'Failed to load more.'; loadEl.classList.add('mt-end'); }
  }
  mwState.loading = false;
}

// --- Top IMDB Rated page ---
let imdbState = { page: 1, loading: false, done: false };

async function loadTopImdbPage() {
  imdbState = { page: 1, loading: false, done: false };

  contentArea.innerHTML = `<div class="movie-row">
    <div class="row-header"><h2 class="row-title">🏆 Top IMDB Rated</h2></div>
    <div class="movie-grid" id="imdbGrid"></div>
    <div class="mt-loading" id="imdbLoading">Loading...</div>
  </div>`;

  await loadMoreTopImdb();

  window.__imdbScrollHandler = async () => {
    const el = document.getElementById('imdbLoading');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) await loadMoreTopImdb();
  };
  window.addEventListener('scroll', window.__imdbScrollHandler, { passive: true });
}

async function loadMoreTopImdb() {
  if (imdbState.loading || imdbState.done) return;
  imdbState.loading = true;

  const grid = document.getElementById('imdbGrid');
  const loadEl = document.getElementById('imdbLoading');
  if (loadEl) loadEl.textContent = 'Loading more...';

  try {
    const data = await apiFetch(`/api/top-imdb?page=${imdbState.page}`);
    const items = (data.items || []).map(it => ({
      id: it.subject_id, title: it.name || 'Untitled', poster: it.poster_url || '',
      slug: it.slug, badge: it.badge || '', rating: it.rating || null,
      source: 'moviebox', type: 'moviebox',
    }));

    if (!items.length) {
      imdbState.done = true;
      if (loadEl) { loadEl.textContent = imdbState.page === 1 ? 'No content found.' : 'You have reached the end.'; loadEl.classList.add('mt-end'); }
      imdbState.loading = false;
      return;
    }

    if (grid) { grid.insertAdjacentHTML('beforeend', items.map(renderCard).join('')); attachCardListeners(); }
    imdbState.page += 1;
    if (imdbState.page > 30) {
      imdbState.done = true;
      if (loadEl) { loadEl.textContent = 'You have reached the end.'; loadEl.classList.add('mt-end'); }
    }
  } catch (e) {
    imdbState.done = true;
    if (loadEl) { loadEl.textContent = 'Failed to load more.'; loadEl.classList.add('mt-end'); }
  }
  imdbState.loading = false;
}

// --- Hindi Dubbed page (dual-audio discovery) ---
let hindiState = { page: 1, loading: false, done: false };

async function loadHindiPage() {
  hindiState = { page: 1, loading: false, done: false };

  contentArea.innerHTML = `<div class="movie-row">
    <div class="row-header"><h2 class="row-title">🇮🇳 Hindi Dubbed</h2></div>
    <p class="row-subtitle">Movies & TV shows with a Hindi audio track</p>
    <div class="movie-grid" id="hindiGrid"></div>
    <div class="mt-loading" id="hindiLoading">Loading...</div>
  </div>`;

  await loadMoreHindi();

  window.__hindiScrollHandler = async () => {
    const el = document.getElementById('hindiLoading');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) await loadMoreHindi();
  };
  window.addEventListener('scroll', window.__hindiScrollHandler, { passive: true });
}

async function loadMoreHindi() {
  if (hindiState.loading || hindiState.done) return;
  hindiState.loading = true;

  const grid = document.getElementById('hindiGrid');
  const loadEl = document.getElementById('hindiLoading');
  if (loadEl) loadEl.textContent = 'Loading more...';

  try {
    const data = await apiFetch(`/api/dubbed?language=Hindi&page=${hindiState.page}`);
    const items = (data.items || []).map(it => ({
      id: it.subject_id, title: it.name || 'Untitled', poster: it.poster_url || '',
      slug: it.slug, badge: it.badge || '', rating: it.rating || null,
      source: 'moviebox', type: 'moviebox',
    }));

    if (!items.length) {
      hindiState.done = true;
      if (loadEl) { loadEl.textContent = hindiState.page === 1 ? 'No Hindi dubbed content found.' : 'You have reached the end.'; loadEl.classList.add('mt-end'); }
      hindiState.loading = false;
      return;
    }

    if (grid) { grid.insertAdjacentHTML('beforeend', items.map(renderCard).join('')); attachCardListeners(); }
    hindiState.page += 1;
    if (hindiState.page > 30) {
      hindiState.done = true;
      if (loadEl) { loadEl.textContent = 'You have reached the end.'; loadEl.classList.add('mt-end'); }
    }
  } catch (e) {
    hindiState.done = true;
    if (loadEl) { loadEl.textContent = 'Failed to load more.'; loadEl.classList.add('mt-end'); }
  }
  hindiState.loading = false;
}

// --- Categories page (genre browser) ---
const CATEGORY_GENRES = {
  movie: ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Music', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'],
  tv: ['Action', 'Adventure', 'Animation', 'Anime', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Mystery', 'Reality', 'Romance', 'Sci-Fi', 'Talk', 'Thriller', 'War'],
  animation: ['Action', 'Adventure', 'Anime', 'Comedy', 'Drama', 'Family', 'Fantasy', 'Horror', 'Kids', 'Romance', 'Sci-Fi', 'Thriller'],
};
const CATEGORY_ICONS = {
  'Action': '💥', 'Adventure': '🗺️', 'Animation': '🎨', 'Anime': '⛩️', 'Comedy': '😂',
  'Crime': '🔫', 'Documentary': '📽️', 'Drama': '🎭', 'Family': '👨‍👩‍👧', 'Fantasy': '🐉',
  'History': '🏛️', 'Horror': '👻', 'Kids': '🧸', 'Music': '🎵', 'Mystery': '🔍',
  'Reality': '📺', 'Romance': '💕', 'Sci-Fi': '🚀', 'Sport': '⚽', 'Talk': '🎤',
  'Thriller': '😱', 'TV Movie': '🎬', 'War': '⚔️', 'Western': '🤠',
};

async function loadCategoriesPage() {
  const groups = [
    { key: 'movie', title: '🎬 Movie Genres', type: 'movie' },
    { key: 'tv', title: '📺 TV Show Genres', type: 'tv' },
    { key: 'animation', title: '🎨 Animation Genres', type: 'animation' },
  ];

  let html = '<div class="categories-page"><h1 class="page-heading">🗂️ Categories</h1>';
  for (const g of groups) {
    const chips = (CATEGORY_GENRES[g.key] || []).map(name =>
      `<button class="genre-chip" data-genre="${esc(name)}" data-type="${g.type}">
        <span class="genre-chip-icon">${CATEGORY_ICONS[name] || '🎞️'}</span>
        <span class="genre-chip-name">${esc(name)}</span>
      </button>`
    ).join('');
    html += `<div class="genre-group">
      <h2 class="genre-group-title">${g.title}</h2>
      <div class="genre-chip-grid">${chips}</div>
    </div>`;
  }
  html += '</div>';
  contentArea.innerHTML = html;

  document.querySelectorAll('.genre-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      loadGenrePage(chip.dataset.genre, chip.dataset.type);
    });
  });
}

// --- Genre results page ---
let genreState = { genre: '', type: 'movie', page: 1, loading: false, done: false };

async function loadGenrePage(genre, type) {
  genreState = { genre, type, page: 1, loading: false, done: false };
  const icon = CATEGORY_ICONS[genre] || '🎞️';
  const typeLabel = type === 'tv' ? 'TV Shows' : type === 'animation' ? 'Animation' : 'Movies';

  contentArea.innerHTML = `<div class="movie-row">
    <div class="detail-nav-row">
      <button class="back-btn detail-back-btn" id="genreBackBtn">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        All Categories
      </button>
    </div>
    <div class="row-header"><h2 class="row-title">${icon} ${esc(genre)} ${typeLabel}</h2></div>
    <div class="movie-grid" id="genreGrid"></div>
    <div class="mt-loading" id="genreLoading">Loading...</div>
  </div>`;

  const backBtn = document.getElementById('genreBackBtn');
  if (backBtn) backBtn.addEventListener('click', () => loadCategoriesPage());

  await loadMoreGenre();

  window.__genreScrollHandler = async () => {
    const el = document.getElementById('genreLoading');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) await loadMoreGenre();
  };
  window.addEventListener('scroll', window.__genreScrollHandler, { passive: true });
}

async function loadMoreGenre() {
  if (genreState.loading || genreState.done) return;
  genreState.loading = true;

  const grid = document.getElementById('genreGrid');
  const loadEl = document.getElementById('genreLoading');
  if (loadEl) loadEl.textContent = 'Loading more...';

  try {
    const data = await apiFetch(`/api/genre/${encodeURIComponent(genreState.genre)}?type=${genreState.type}&page=${genreState.page}`);
    const items = (data.items || []).map(it => ({
      id: it.subject_id, title: it.name || 'Untitled', poster: it.poster_url || '',
      slug: it.slug, badge: it.badge || '', rating: it.rating || null,
      source: 'moviebox', type: 'moviebox',
    }));

    if (!items.length) {
      genreState.done = true;
      if (loadEl) { loadEl.textContent = genreState.page === 1 ? `No ${genreState.genre} content found.` : 'You have reached the end.'; loadEl.classList.add('mt-end'); }
      genreState.loading = false;
      return;
    }

    if (grid) { grid.insertAdjacentHTML('beforeend', items.map(renderCard).join('')); attachCardListeners(); }
    genreState.page += 1;
    if (!data.has_more || genreState.page > 15) {
      genreState.done = true;
      if (loadEl) { loadEl.textContent = 'You have reached the end.'; loadEl.classList.add('mt-end'); }
    }
  } catch (e) {
    genreState.done = true;
    if (loadEl) { loadEl.textContent = 'Failed to load more.'; loadEl.classList.add('mt-end'); }
  }
  genreState.loading = false;
}

async function searchMovies(query) {
  showLoading();
  const data = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
  const movies = data.movies || [];
  if (!movies.length) {
    contentArea.innerHTML = `<div class="no-results"><p>No results for "${esc(query)}"</p></div>`;
  } else {
    contentArea.innerHTML = `<div class="movie-row"><div class="row-header"><h2 class="row-title">🔍 "${esc(query)}" — ${movies.length} results</h2></div><div class="movie-grid">${movies.map(renderCard).join('')}</div></div>`;
    attachCardListeners();
  }
  hideLoading();
}

// --- Card ---
function renderCard(movie) {
  const poster = movie.poster
    ? `<img src="${movie.poster}" alt="${esc(movie.title)}" loading="lazy">`
    : `<div class="no-poster"><svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg></div>`;

  // Determine language (prefer explicit movie.language) and quality
  const lang = mapLanguage(movie.language || movie.badge || movie.title || '');
  const badge = movie.badge || '';
  const quality = extractQuality(badge) || extractQuality(movie.title);
  const rating = movie.rating || '';

  // Keep full title with [Hindi] etc. — do NOT strip language tags
  const displayTitle = (movie.title || '').trim();

  // Build badge HTML — show language badge from API (corner) or extracted language
  let badgeHtml = '';
  if (badge) {
    badgeHtml = `<span class="card-lang">${esc(badge)}</span>`;
  } else if (lang) {
    badgeHtml = `<span class="card-lang">${lang}</span>`;
  }

  return `
    <div class="movie-card" data-source="${movie.source || 'tmdb'}" data-type="${movie.type || 'movie'}" data-id="${movie.id || ''}" data-slug="${movie.slug || ''}">
      <div class="card-poster">
        ${poster}
        ${badgeHtml}
        ${quality ? `<span class="card-quality">${quality}</span>` : ''}
        ${rating ? `<span class="card-rating">⭐ ${esc(rating)}</span>` : ''}
        <div class="card-play-overlay">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </div>
        <button class="card-download-btn" data-action="download" title="Download">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
      </div>
      <div class="card-info">
        <div class="card-title" title="${esc(displayTitle)}">${esc(displayTitle)}</div>
        <div class="card-meta">${movie.year || ''}${rating ? ' · ⭐ ' + rating : ''}</div>
      </div>
    </div>`;
}

function attachCardListeners() {
  document.querySelectorAll('.movie-card').forEach(card => {
    card.onclick = (e) => {
      // Don't open detail if download button was clicked
      if (e.target.closest('[data-action="download"]')) return;
      openDetail(card.dataset.source, card.dataset.type, card.dataset.id, card.dataset.slug);
    };
  });

  // Download buttons on cards
  document.querySelectorAll('.card-download-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest('.movie-card');
      if (!card) return;
      const source = card.dataset.source;
      const id = card.dataset.id;
      const slug = card.dataset.slug;
      if (source !== 'moviebox' || !id || !slug) {
        alert('Download available for Nexmovies content only.');
        return;
      }
      await triggerCardDownload(id, slug, btn);
    });
  });
}

// --- Card download handler ---
async function triggerCardDownload(subjectId, slug, btn) {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" class="spin"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`;
  btn.disabled = true;

  try {
    // Determine if TV show from card data
    const card = document.querySelector(`.movie-card[data-id="${subjectId}"]`);
    const type = card ? card.dataset.type : 'moviebox';
    const isTv = type === 'tv';
    const se = isTv ? 1 : 0;
    const ep = isTv ? 1 : 0;

    const res = await fetch(`/api/stream?subject_id=${subjectId}&slug=${encodeURIComponent(slug)}&se=${se}&ep=${ep}`);
    const data = await res.json();

    // Collect downloadable MP4 sources (DASH needs special handling, prefer MP4)
    const mp4Sources = (data.sources || [])
      .filter(s => s.url && s.url.length > 0)
      .map(s => ({
        url: s.url,
        label: s.resolution || s.resolutions || '?p',
        type: 'mp4',
        size: s.size || '',
        height: parseInt(s.resolutions) || parseInt(s.resolution) || 0,
      }));

    if (mp4Sources.length === 0) {
      // No MP4 with URL — try DASH as fallback
      const dashSources = (data.dash || []).filter(d => d.url && d.url.length > 0);
      if (dashSources.length > 0) {
        // Open DASH URL in new tab
        window.open(dashSources[0].url, '_blank');
        alert('DASH stream opened in new tab.');
      } else {
        alert('No downloadable source found for this content.');
      }
      return;
    }

    // Pick the best MP4 quality
    mp4Sources.sort((a, b) => b.height - a.height);
    const best = mp4Sources[0];
    const title = (card ? card.querySelector('.card-title') : null)?.textContent || 'download';
    const proxyUrl = best.url.includes('/api/proxy') ? best.url : `/api/proxy?url=${encodeURIComponent(best.url)}`;

    // Use hidden anchor to trigger download
    const a = document.createElement('a');
    a.href = proxyUrl + `&title=${encodeURIComponent(title)}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error('Download failed:', err);
    alert('Download failed. Please try again.');
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

// --- Embed sources ---
function getEmbedServers(type, id, se, ep) {
  const s = se || 1, e = ep || 1;
  if (type === 'tv') {
    return [
      { name: 'Server 1', url: `https://yapgrid.com/embed/tv/${id}/${s}/${e}` },
      { name: 'Server 2', url: `https://vidcore.org/embed/tv/${id}/${s}/${e}` },
      { name: 'Server 3', url: `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
      { name: 'Server 4', url: `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` },
    ];
  }
  return [
    { name: 'Server 1', url: `https://yapgrid.com/embed/movie/${id}` },
    { name: 'Server 2', url: `https://vidcore.org/embed/movie/${id}` },
    { name: 'Server 3', url: `https://multiembed.mov/?video_id=${id}&tmdb=1` },
    { name: 'Server 4', url: `https://www.2embed.cc/embed/${id}` },
  ];
}

// --- Detail page ---
async function openDetail(source, type, id, slug) {
  showLoading();
  stopCurrentTranscode();
  captureBrowseState();

  // Push to history for back button support
  if (!document.querySelector('.detail-page')) {
    history.pushState({ detail: id }, "");
  }

  contentArea.innerHTML = '';

  try {
    const detail = await fetch(`/api/detail?type=${type}&id=${id}&source=${source}&slug=${slug || ''}`).then(r => r.json());
    currentDetail = detail;

    // Get cast
    let cast = [];
    try {
      const castRes = await fetch(`/api/cast?type=${type === 'tv' ? 'tv' : 'movie'}&id=${id}`);
      if (castRes.ok) {
        const castData = await castRes.json();
        cast = castData.cast || [];
      }
    } catch (e) {}

    // Get stream
    let streamData = null;
    let captionData = null;
    if (source === 'moviebox' && slug && id) {
      const isMovie = detail.type === 'movie';
      const se = isMovie ? 0 : 1;
      const ep = isMovie ? 0 : 1;
      try {
        streamData = await fetch(`/api/stream?subject_id=${id}&slug=${encodeURIComponent(slug)}&se=${se}&ep=${ep}`).then(r => r.json());
      } catch (e) {}
      try {
        captionData = await fetch(`/api/stream/${id}/captions?detail_path=${encodeURIComponent(slug)}&se=${se}&ep=${ep}`).then(r => r.json());
      } catch (e) {}
    }

    // Filter valid sources
    const validSources = (streamData && streamData.sources || []).filter(s => s.url && s.url.length > 0);
    const validDASH = (streamData && streamData.dash || []).filter(d => d.url && d.url.length > 0);
    const validHLS = (streamData && streamData.hls || []).filter(h => h.url && h.url.length > 0);

    // VIP-locked MP4 resolutions come back with empty URLs, but the DASH
    // stream still carries every resolution. Detect the DASH codec (HEVC vs
    // H.264) and the browser's HEVC support to decide how to unlock them.
    const dashEntry = validDASH[0] || null;
    let dashCodec = String(dashEntry ? (dashEntry.codecName || dashEntry.codec || dashEntry.format || '') : '').toLowerCase();
    const hevcOK = canPlayHEVC();

    let dashRes = [];
    if (dashEntry) {
      try {
        const manifestData = await fetch(`/api/dash-manifest?url=${encodeURIComponent(dashEntry.url)}`).then(r => r.json());
        window.__dashManifest = manifestData;
        if (manifestData.resolutions && manifestData.resolutions.length > 0) dashRes = manifestData.resolutions;
        if (!dashCodec && manifestData.codec) dashCodec = String(manifestData.codec).toLowerCase();
      } catch (e) {}
      if (dashRes.length === 0 && dashEntry.resolutions) {
        dashRes = String(dashEntry.resolutions).split(',')
          .map(h => parseInt(h)).filter(h => h > 0)
          .map(h => ({ height: h, label: h + 'p' }));
      }
      dashRes.sort((a, b) => b.height - a.height);
    }
    const dashIsHevc = /hevc|h265|hev1|hvc1/.test(dashCodec);
    const dashPlayable = !!(dashEntry && (!dashIsHevc || hevcOK));

    // MP4 (H.264) qualities that are actually free (non-empty URL)
    const mp4Qualities = validSources.map(s => {
      const h = parseInt(s.resolutions) || parseInt(s.resolution) || 0;
      return { height: h, label: (s.resolution || (h + 'p')), url: s.url, kind: 'mp4' };
    }).filter(q => q.height > 0).sort((a, b) => b.height - a.height);

    let playerSrc = '';
    let playerType = '';
    let formatLabel = 'Loading...';
    let isEmbed = false;
    let resolutions = [];
    let qualityPlan = [];

    if (dashPlayable) {
      // Browser can decode this DASH — play it directly, ALL resolutions unlocked
      playerSrc = dashEntry.url;
      playerType = 'application/dash+xml';
      formatLabel = dashIsHevc ? 'High efficiency (DASH/H.265)' : 'DASH Streaming';
      resolutions = dashRes;
      qualityPlan = dashRes.map(r => ({ height: r.height, label: r.label || r.height + 'p', kind: 'dash', url: '' }));
    } else if (mp4Qualities.length > 0) {
      // HEVC DASH not decodable here — default to best free H.264 MP4 so the
      // screen is never black; locked qualities still offered via transcode
      playerSrc = mp4Qualities[0].url;
      playerType = 'video/mp4';
      formatLabel = 'MP4 (H.264)';
      resolutions = mp4Qualities.map(q => ({ height: q.height, label: q.label, url: q.url }));
      qualityPlan = mp4Qualities.map(q => ({ ...q }));
    } else if (validHLS.length > 0 && !dashEntry) {
      playerSrc = validHLS[0].url;
      playerType = 'application/x-mpegURL';
      formatLabel = 'HLS Streaming';
    } else if (!dashEntry) {
      isEmbed = true;
      formatLabel = 'External Source';
      let tmdbId = null;
      try {
        const year = detail.year || '';
        const tmdbResult = await fetch(`/api/tmdb-id?title=${encodeURIComponent(detail.title)}&year=${year}&type=${type === 'tv' ? 'tv' : 'movie'}`).then(r => r.json());
        tmdbId = tmdbResult.tmdb_id;
      } catch (e) {}

      if (tmdbId) {
        const servers = getEmbedServers(type === 'tv' ? 'tv' : 'movie', tmdbId);
        playerSrc = servers[0].url;
        resolutions = servers;
      } else {
        playerSrc = `https://www.2embed.cc/embed/${id}`;
        resolutions = [{ label: 'Server 1', url: playerSrc }];
      }
    }

    // Merge qualities that only exist in the DASH (the VIP-locked ones) into
    // the plan — everything becomes selectable, no VIP lock in the UI.
    if (dashEntry && dashRes.length) {
      for (const r of dashRes) {
        const h = parseInt(r.height) || 0;
        if (!h) continue;
        if (!qualityPlan.some(q => q.height === h)) {
          qualityPlan.push({
            height: h,
            label: r.label || h + 'p',
            kind: dashPlayable ? 'dash' : 'hls',
            url: '',
          });
        }
      }
    }
    // Merge free MP4-only qualities (e.g. 360p) that the DASH doesn't carry
    if (dashPlayable) {
      for (const q of mp4Qualities) {
        if (!qualityPlan.some(p => p.height === q.height)) qualityPlan.push({ ...q });
      }
    }
    qualityPlan.sort((a, b) => b.height - a.height);

    // If neither DASH nor MP4 is directly playable but a DASH exists,
    // transcode the top quality via FFmpeg (HEVC → H.264 HLS)
    if (!playerSrc && !isEmbed && dashEntry && qualityPlan.length) {
      const top = qualityPlan[0];
      formatLabel = 'Transcoding (HEVC → H.264)';
      try {
        const tc = await fetch(`/api/transcode/start?url=${encodeURIComponent(dashEntry.url)}&height=${top.height}`).then(r => r.json());
        if (tc && tc.playlist) {
          stopCurrentTranscode();
          window.__transcodeId = tc.id;
          top.kind = 'hls';
          top.sessionId = tc.id;
          playerSrc = tc.playlist;
          playerType = 'application/x-mpegURL';
        }
      } catch (e) {}
    }

    window.__currentStream = {
      src: playerSrc,
      type: playerType,
      mp4Sources: validSources,
      dashUrl: dashEntry ? dashEntry.url : '',
      hlsUrl: validHLS.length > 0 ? validHLS[0].url : '',
      captionData: captionData,
      resolutions: resolutions,
      qualityPlan: qualityPlan,
      dashCodec: dashCodec,
      dashIsHevc: dashIsHevc,
      hevcOK: hevcOK,
      isEmbed: isEmbed,
    };

    // Resources panel (season/episode)
    // Audio track (dub) selector — upstream exposes dual-audio / Hindi-dubbed
    // variants of a title as separate subjects in `detail.dubs`.
    let dubSelectorHtml = '';
    const dubList = (detail.dubs || []).filter(d => d && d.detailPath && d.subjectId && d.type !== 1);
    const seenDubKeys = new Set();
    const uniqueDubs = dubList.filter(d => {
      const key = `${d.lanCode || ''}|${d.type}`;
      if (seenDubKeys.has(key)) return false;
      seenDubKeys.add(key);
      return true;
    });
    if (uniqueDubs.length > 1) {
      const currentSubjectId = String(detail.id || id || '');
      const btns = uniqueDubs.map(d => {
        const active = String(d.subjectId) === currentSubjectId || (!currentSubjectId && d.original);
        return `<button class="season-tab dub-tab${active ? ' active' : ''}" data-dub-id="${esc(d.subjectId)}" data-dub-slug="${esc(d.detailPath)}">${esc(d.lanName || d.lanCode || 'Audio')}</button>`;
      }).join('');
      dubSelectorHtml = `
        <div class="format-section">
          <span class="format-title">Audio Track</span>
        </div>
        <div class="season-tabs dub-tabs" id="dubTabs">${btns}</div>`;
    }

    let resourcesHtml = '';
    if (detail.type === 'tv') {
      const resource = detail.resource || {};
      const seasonsData = resource.seasons || [];
      const sourceName = resource.source || 'Nexmovies';

      const seasonMap = {};
      for (const s of seasonsData) {
        seasonMap[s.se] = s.maxEp || 1;
      }

      const seasonNums = Object.keys(seasonMap).map(Number).sort((a, b) => a - b);
      const hasSeasons = seasonNums.length > 0;

      window.__seasonMap = seasonMap;
      window.__resourceSource = sourceName;

      let seasonTabs = '';
      if (hasSeasons) {
        for (const se of seasonNums) {
          seasonTabs += `<button class="season-tab${se === seasonNums[0] ? ' active' : ''}" data-season="${se}">S${String(se).padStart(2, '0')}</button>`;
        }
      } else {
        seasonTabs = `<button class="season-tab active" data-season="1">S01</button>`;
      }

      const firstSeason = hasSeasons ? seasonNums[0] : 1;
      const firstMaxEp = seasonMap[firstSeason] || 1;
      let episodeGrid = '';
      for (let i = 1; i <= firstMaxEp; i++) {
        episodeGrid += `<button class="ep-btn" data-ep="${i}">${String(i).padStart(2, '0')}</button>`;
      }

      resourcesHtml = `
        <div class="detail-resources">
          ${dubSelectorHtml}
          <div class="format-section">
            <span class="format-title">Format</span>
            <span class="format-info">${esc(formatLabel)}</span>
          </div>
          <div class="resources-title">Resources</div>
          <div class="resources-source">Source: ${esc(sourceName)} | By ${esc(resource.uploadBy || 'N/A')}</div>
          <div class="season-tabs" id="seasonTabs">${seasonTabs}</div>
          <div class="episode-grid" id="episodeGrid">${episodeGrid}</div>
        </div>`;
    } else {
      const resource = detail.resource || {};
      const sourceName = resource.source || 'Nexmovies';
      resourcesHtml = `
        <div class="detail-resources">
          ${dubSelectorHtml}
          <div class="format-section">
            <span class="format-title">Format</span>
            <span class="format-info">${esc(formatLabel)}</span>
          </div>
          <div class="resources-title">Resources</div>
          <div class="resources-source">Source: ${esc(sourceName)} | By ${esc(resource.uploadBy || 'N/A')}</div>
          <div class="ep-btn playing" style="text-align:left;padding:8px 12px;white-space:normal;font-size:12px;">
            <span class="equalizer"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>
            ${esc(detail.title)}
          </div>
        </div>`;
    }

    // Cast HTML
    let castHtml = '';
    if (cast.length > 0) {
      const castCards = cast.slice(0, 15).map(c => `
        <div class="cast-card">
          <div class="cast-img">
            ${c.profile_path ? `<img src="https://image.tmdb.org/t/p/w200${c.profile_path}" alt="${esc(c.name)}" loading="lazy">` : ''}
          </div>
          <div class="cast-name">${esc(c.name)}</div>
          <div class="cast-role">${esc(c.character || '')}</div>
        </div>`).join('');
      castHtml = `<div class="cast-section"><h3>Top Cast</h3><div class="cast-scroll">${castCards}</div></div>`;
    }

    // Render
    const genres = (detail.genres || []).map(g => `<span>${esc(g)}</span>`).join(' / ');
    const cornerHtml = detail.corner ? `<span class="detail-badge">${detail.corner}</span>` : '';

    // Build download resolution options from MP4 sources only (DASH can't be directly downloaded)
    const mp4Sources = (streamData && streamData.sources || []).filter(s => s.url && s.url.length > 0);

    const downloadOptions = mp4Sources.map(s => {
      const res = s.resolution || s.resolutions || '?';
      const label = res.includes('p') ? res : res + 'p';
      return { label, url: s.url, size: s.size || '', type: 'mp4', height: parseInt(res) || 0 };
    }).sort((a, b) => b.height - a.height);

    // If no MP4 available but DASH exists, add a DASH fallback option
    if (downloadOptions.length === 0) {
      const dashSources = (streamData && streamData.dash || []).filter(d => d.url && d.url.length > 0);
      if (dashSources.length > 0) {
        const highestRes = (dashSources[0].resolutions || '1080').split(',')[0];
        downloadOptions.push({
          label: highestRes + 'p (DASH)',
          url: dashSources[0].url,
          size: dashSources[0].size || '',
          type: 'dash',
          height: parseInt(highestRes) || 1080,
        });
      }
    }

    let downloadHtml = '';
    if (downloadOptions.length > 0 && source === 'moviebox') {
      const dlItems = downloadOptions.map((opt, i) => {
        const sizeStr = opt.size ? ` (${opt.size})` : '';
        return `<button class="dl-option" data-url="${esc(opt.url)}" data-title="${esc(detail.title || '')}">${opt.label}${sizeStr}</button>`;
      }).join('');
      downloadHtml = `
        <div class="download-section">
          <button class="download-btn-detail" id="downloadBtn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            Download
          </button>
          <div class="download-dropdown" id="downloadDropdown">${dlItems}</div>
        </div>`;
    }

    contentArea.innerHTML = `
      <div class="detail-page">
        <div class="detail-nav-row">
          <button class="back-btn detail-back-btn" onclick="history.back()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            Back
          </button>
        </div>
        <div class="detail-top">
          <div class="detail-player-wrap">
            <div class="player-wrap">
              <div class="player-frame" id="playerFrame">
                <div id="artplayer-app"></div>
              </div>
            </div>
          </div>
          ${resourcesHtml}
        </div>
        <div class="detail-info">
          <div class="detail-title-row">
            <h1>${esc(detail.title || 'Untitled')}</h1>
            ${downloadHtml}
          </div>
          <div class="detail-meta">
            ${cornerHtml}
            ${detail.year ? `<span>${detail.year}</span>` : ''}
            ${detail.country ? `<span>${detail.country}</span>` : ''}
            <span>${genres}</span>
          </div>
          ${detail.rating ? `<div style="margin-bottom:12px;"><span class="detail-rating">⭐ ${detail.rating}</span><span class="detail-rating-count">${(detail.ratingCount || 0).toLocaleString()} people rated</span></div>` : ''}
          ${detail.overview ? `<div class="detail-overview"><p>${esc(detail.overview)}</p></div>` : ''}
        </div>
        ${castHtml}
        <div class="playback-issue">
          <span>Having playback issues? Please contact us.</span>
          <button class="report-btn">⚠ Report</button>
        </div>
      </div>`;

    // Initialize player
    if (isEmbed) {
      initEmbedPlayer(playerSrc, resolutions);
    } else {
      initArtPlayer();
    }

    // Bind season/episode buttons
    bindSeasonEpisodeButtons(source, type, id);

    // Bind audio (dub) switcher — each dub is its own subject upstream,
    // so switching reloads the detail page with the dub's subject/slug.
    document.querySelectorAll('#dubTabs .dub-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const dubId = btn.dataset.dubId;
        const dubSlug = btn.dataset.dubSlug;
        if (!dubId || !dubSlug || String(dubId) === String(id)) return;
        stopCurrentTranscode();
        const navType = (currentDetail && currentDetail.type === 'tv') ? 'tv' : 'movie';
        openDetail('moviebox', navType, dubId, dubSlug);
      });
    });
    if (detail.type === 'tv') {
      setPlayingEpisode(1);
    }

    // Bind download button + dropdown
    const dlBtn = document.getElementById('downloadBtn');
    const dlDropdown = document.getElementById('downloadDropdown');
    if (dlBtn && dlDropdown) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dlDropdown.classList.toggle('show');
      });
      dlDropdown.querySelectorAll('.dl-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const url = opt.dataset.url;
          const title = opt.dataset.title || 'download';
          if (!url) return;
          const proxyUrl = url.includes('/api/proxy') ? url : `/api/proxy?url=${encodeURIComponent(url)}`;
          const a = document.createElement('a');
          a.href = proxyUrl + `&title=${encodeURIComponent(title)}`;
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          dlDropdown.classList.remove('show');
        });
      });
      // Close dropdown when clicking outside
      document.addEventListener('click', () => dlDropdown.classList.remove('show'));
    }

    hideLoading();
  } catch (e) {
    console.error('Detail error:', e);
    contentArea.innerHTML = '<div class="no-results"><p>Failed to load</p></div>';
    hideLoading();
  }
}

// --- Embed player (iframe) ---
function initEmbedPlayer(src, servers) {
  const frame = document.getElementById('playerFrame');
  if (!frame) return;

  let serverBtnsHtml = '';
  if (servers.length > 1) {
    serverBtnsHtml = `<div class="server-selector" id="serverSelector">
      ${servers.map((s, i) => `<button class="server-btn${i === 0 ? ' active' : ''}" data-url="${s.url}">${s.name || s.label}</button>`).join('')}
    </div>`;
  }

  const playerWrap = frame.closest('.player-wrap');
  if (playerWrap && serverBtnsHtml) {
    playerWrap.insertAdjacentHTML('afterbegin', serverBtnsHtml);
    bindEmbedServerButtons();
  }

  frame.innerHTML = `<iframe id="movie-iframe" src="${src}" allowfullscreen allow="autoplay; fullscreen; picture-in-picture" style="width:100%;aspect-ratio:16/9;border:none;border-radius:12px;"></iframe>`;
}

function bindEmbedServerButtons() {
  document.querySelectorAll('#serverSelector .server-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#serverSelector .server-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const url = btn.dataset.url;
      if (url) {
        const frame = document.getElementById('playerFrame');
        if (frame) {
          frame.innerHTML = `<iframe id="movie-iframe" src="${url}" allowfullscreen allow="autoplay; fullscreen; picture-in-picture" style="width:100%;aspect-ratio:16/9;border:none;border-radius:12px;"></iframe>`;
        }
      }
    });
  });
}

// --- ArtPlayer initialization ---
function initArtPlayer() {
  const stream = window.__currentStream;
  if (!stream || !stream.src) return;

  if (window.__artPlayer) {
    window.__artPlayer.destroy();
    window.__artPlayer = null;
  }
  if (window.__dashPlayer) {
    try { window.__dashPlayer.reset(); } catch (e) {}
    window.__dashPlayer = null;
  }
  if (window.__hlsPlayer) {
    try { window.__hlsPlayer.destroy(); } catch (e) {}
    window.__hlsPlayer = null;
  }

  const container = document.getElementById('artplayer-app');
  if (!container) return;

  const src = stream.src;
  const type = stream.type || 'video/mp4';
  const isDASH = type === 'application/dash+xml';
  const isHLS = type === 'application/x-mpegURL';
  const resolutions = stream.resolutions || [];

  const qualityList = resolutions.map(r => ({
    default: r.height === 1080 || (resolutions.indexOf(r) === 0),
    html: r.label || `${r.height}p`,
    url: isDASH ? null : (r.url || src),
    height: r.height,
  }));

  const artOptions = {
    container: container,
    url: src,
    type: isDASH ? 'mpd' : (type === 'application/x-mpegURL' ? 'm3u8' : 'mp4'),
    autoplay: true,
    pip: true,
    autoSize: false,
    autoMini: true,
    fullscreen: true,
    fullscreenLock: true,
    mutex: true,
    backdrop: false,
    playsInline: true,
    autoPlayback: true,
    airplay: true,
    theme: '#1db954',
    volume: 0.7,
    lock: true,
    fastForward: true,
    autoOrientation: true,
    screenshot: false,
    setting: true,
    flip: true,
    playbackRate: true,
    aspectRatio: true,
    hotkey: true,
    subtitleOffset: true,
    miniProgressBar: false,
    useSSR: false,
    lock: false,
    settings: [],
    controls: [],
  };

  // HLS playback through hls.js (native HLS fallback for Safari)
  if (isHLS && typeof Hls !== 'undefined' && Hls.isSupported()) {
    artOptions.customType = {
      m3u8: function(video, url, art) {
        if (window.__hlsPlayer) { try { window.__hlsPlayer.destroy(); } catch (e) {} }
        const hls = new Hls({ maxBufferLength: 30, enableWorker: true });
        hls.loadSource(url);
        hls.attachMedia(video);
        window.__hlsPlayer = hls;
        art.hls = hls;
      },
    };
  }

  if (stream.captionData && stream.captionData.captions && stream.captionData.captions.length > 0) {
    const firstCap = stream.captionData.captions[0];
    const subUrl = `/api/proxy?url=${encodeURIComponent(firstCap.url)}`;
    artOptions.subtitle = {
      url: subUrl,
      type: 'srt',
      style: {
        color: '#fff',
        fontSize: '16px',
        fontFamily: 'sans-serif',
      },
      encoding: 'utf-8',
    };
  }

  const art = new Artplayer(artOptions);
  window.__artPlayer = art;

  addPlayerControls(art, stream);

  if (isDASH && typeof dashjs !== 'undefined') {
    try {
      const dashPlayer = dashjs.MediaPlayer().create();
      window.__dashPlayer = dashPlayer;

      dashPlayer.updateSettings({
        streaming: {
          abr: {
            autoSwitchBitrate: { video: true, audio: true },
          },
          bufferTimeAtTopQuality: 30,
          bufferTimeAtTopQualityLongForm: 60,
        },
      });

      dashPlayer.initialize(art.video, src, true);
      art.dash = dashPlayer;
      window.__dashReady = true;

      dashPlayer.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        const bitrateList = dashPlayer.getBitrateInfoListFor('video');
        if (bitrateList && bitrateList.length > 0) {
          window.__dashBitrates = bitrateList;
          updateQualityControl(bitrateList);
          // Apply a quality requested before the player finished initializing
          if (window.__pendingDashHeight) {
            const target = window.__pendingDashHeight;
            window.__pendingDashHeight = null;
            dashPlayer.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
            for (const b of bitrateList) {
              if (b.height === target) { dashPlayer.setQualityFor('video', b.qualityIndex); break; }
            }
          }
        }
      });

      console.log('ArtPlayer + dash.js initialized');
    } catch (e) {
      console.error('dash.js init failed:', e);
    }
  } else if (!isDASH && resolutions.length > 0 && !stream.isEmbed) {
    art.setting.add({
      name: 'Quality',
      width: 200,
      html: qualityList.map(q => `<div data-quality-url="${q.url}" data-quality-h="${q.height}" style="padding:8px 16px;cursor:pointer;">${q.html}</div>`).join(''),
      onSelect: function(item) {
        const url = item.dataset.qualityUrl;
        art.switchUrl(url);
        return item.innerHTML;
      },
    });
  }

  art.on('error', (error) => {
    console.error('ArtPlayer error:', error);
  });

  art.on('ready', () => {
    console.log('ArtPlayer ready');
    if (window.__pendingSeek && window.__pendingSeek > 0) {
      try { art.currentTime = window.__pendingSeek; } catch (e) {}
      window.__pendingSeek = 0;
    }
  });
}

// --- Custom player controls ---
function addPlayerControls(art, stream) {
  const isDASH = stream.type === 'application/dash+xml';
  const resolutions = stream.resolutions || [];
  const captions = (stream.captionData && stream.captionData.captions) || [];
  const hasCaptions = captions.length > 0;

  if (hasCaptions) {
    const langMap = {};
    captions.forEach(cap => {
      const key = cap.lan || 'en';
      if (!langMap[key]) langMap[key] = cap.lanName || cap.lan || key;
    });
    const firstLang = captions[0].lanName || captions[0].lan || 'English';

    art.controls.add({
      name: 'lang-control',
      position: 'right',
      index: 8,
      style: {},
      html: `<div class="player-text-btn" id="langBtn">
        <span class="player-text-btn-label">${esc(firstLang)}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M4 5.5L7 2.5H1L4 5.5Z" fill="white" fill-opacity="0.8"/></svg>
      </div>`,
      click: function() {
        closeAllDropdowns();
        const dd = document.getElementById('langDropdown');
        if (dd) dd.classList.toggle('show');
      },
    });
  }

  if (hasCaptions) {
    art.controls.add({
      name: 'dualsub-control',
      position: 'right',
      index: 9,
      style: {},
      html: `<div class="player-text-btn" id="dualsubBtn">
        <span class="player-text-btn-label" id="dualsubLabel">DualSub</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M4 5.5L7 2.5H1L4 5.5Z" fill="white" fill-opacity="0.8"/></svg>
      </div>`,
      click: function() {
        closeAllDropdowns();
        const dd = document.getElementById('dualsubDropdown');
        if (dd) dd.classList.toggle('show');
      },
    });
  }

  const currentQuality = resolutions.length > 0
    ? (resolutions[0].label || resolutions[0].height + 'p')
    : (isDASH ? '1080p' : 'Auto');

  art.controls.add({
    name: 'quality-control',
    position: 'right',
    index: 10,
    style: {},
    html: `<div class="player-text-btn" id="qualityBtn">
      <span class="player-text-btn-label" id="qualityLabel">${esc(currentQuality)}</span>
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M4 5.5L7 2.5H1L4 5.5Z" fill="white" fill-opacity="0.8"/></svg>
    </div>`,
    click: function() {
      closeAllDropdowns();
      const dd = document.getElementById('qualityDropdown');
      if (dd) dd.classList.toggle('show');
    },
  });

  setTimeout(() => {
    const playerEl = art.template.$player;
    if (!playerEl) return;

    const existing = playerEl.querySelector('.player-dropdowns');
    if (existing) existing.remove();

    const dropdowns = document.createElement('div');
    dropdowns.className = 'player-dropdowns';

    if (hasCaptions) {
      const langMap = {};
      captions.forEach(cap => {
        const key = cap.lan || 'en';
        if (!langMap[key]) langMap[key] = cap.lanName || cap.lan || key;
      });
      const langEntries = Object.entries(langMap);

      dropdowns.innerHTML += `
        <div class="player-dropdown" id="langDropdown">
          ${langEntries.map(([code, name], i) => `<div class="player-dropdown-item${i === 0 ? ' active' : ''}" data-lang="${esc(name)}">${esc(name)}</div>`).join('')}
        </div>`;
    }

    if (hasCaptions) {
      let subItems = '';
      subItems += `<div class="player-dropdown-item sub-off" data-sub-action="off">
        <span class="sub-icon">✕</span> Off
      </div>`;

      captions.forEach((cap, i) => {
        const label = cap.lanName || cap.lan || `Sub ${i + 1}`;
        const url = `/api/proxy?url=${encodeURIComponent(cap.url)}`;
        subItems += `<div class="player-dropdown-item" data-sub-action="load" data-sub-url="${esc(url)}" data-sub-label="${esc(label)}" data-sub-lang="${esc(cap.lan || 'en')}">
          ${esc(label)}
        </div>`;
      });

      subItems += `<div class="player-dropdown-item sub-upload" data-sub-action="upload">
        <span class="sub-icon">📁</span> Upload Subtitle (SRT/VTT)
      </div>`;

      dropdowns.innerHTML += `
        <div class="player-dropdown" id="dualsubDropdown">
          ${subItems}
        </div>`;
    }

    let qualityOptions = [];
    const plan = (window.__currentStream && window.__currentStream.qualityPlan) || [];
    if (plan.length > 0) {
      // Unified plan: mp4 (direct), dash (native decode), hls (FFmpeg transcode)
      qualityOptions = plan.map(q => ({
        label: q.label || q.height + 'p',
        height: q.height,
        url: q.url || '',
        kind: q.kind || 'mp4',
        auto: false,
        available: true,
      }));
    } else if (isDASH && window.__dashBitrates && window.__dashBitrates.length > 0) {
      qualityOptions = window.__dashBitrates.map(b => ({
        label: b.height + 'p',
        height: b.height,
        kind: 'dash',
        auto: false,
        available: true,
      }));
    } else if (resolutions.length > 0) {
      qualityOptions = resolutions.map(r => ({
        label: r.label || r.height + 'p',
        height: r.height,
        url: r.url || '',
        kind: r.url ? 'mp4' : 'hls',
        auto: false,
        available: true,
      }));
    }
    qualityOptions.push({ label: 'Auto', height: 0, auto: true, available: true, kind: 'auto' });

    // Mark the item matching the currently playing source as active
    const curType = (window.__currentStream && window.__currentStream.type) || '';
    const curKind = curType === 'application/dash+xml' ? 'dash' : curType === 'application/x-mpegURL' ? 'hls' : 'mp4';
    const curSrc = (window.__currentStream && window.__currentStream.src) || '';
    let activeIdx = qualityOptions.findIndex(q => q.kind === curKind && (curKind !== 'mp4' || q.url === curSrc));
    if (activeIdx < 0) activeIdx = qualityOptions.findIndex(q => q.kind === curKind);
    if (activeIdx < 0) activeIdx = 0;

    dropdowns.innerHTML += `
      <div class="player-dropdown" id="qualityDropdown">
        ${qualityOptions.map((q, i) => {
          const activeClass = i === activeIdx ? ' active' : '';
          return `<div class="player-dropdown-item${activeClass}" data-qheight="${q.height}" data-qauto="${q.auto}" data-qurl="${q.url || ''}" data-qkind="${q.kind || ''}" data-qavailable="true">${q.label}</div>`;
        }).join('')}
      </div>`;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.srt,.vtt,.ass,.ssa,.sub';
    fileInput.style.display = 'none';
    fileInput.id = 'customSubInput';
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target.result;
        const ext = file.name.split('.').pop().toLowerCase();
        const types = { srt: 'srt', vtt: 'vtt', ass: 'ass', ssa: 'ass', sub: 'srt' };
        const subType = types[ext] || 'srt';

        const blob = new Blob([content], { type: 'text/plain' });
        const blobUrl = URL.createObjectURL(blob);

        art.subtitle.url = blobUrl;
        art.subtitle.type = subType;
        art.subtitle.show = true;

        const dualsubLabel = document.getElementById('dualsubLabel');
        if (dualsubLabel) dualsubLabel.textContent = file.name.replace(/\.[^.]+$/, '');

        document.querySelectorAll('#dualsubDropdown .player-dropdown-item').forEach(i => i.classList.remove('active'));

        art.notice.show = `Subtitle loaded: ${file.name}`;
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
    playerEl.appendChild(fileInput);

    playerEl.appendChild(dropdowns);

    dropdowns.querySelectorAll('.player-dropdown-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const dd = item.closest('.player-dropdown');

        if (dd.id === 'dualsubDropdown') {
          const action = item.dataset.subAction;

          if (action === 'off') {
            art.subtitle.show = false;
            dd.querySelectorAll('.player-dropdown-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const dualsubLabel = document.getElementById('dualsubLabel');
            if (dualsubLabel) dualsubLabel.textContent = 'DualSub';
            const dualsubBtn = document.getElementById('dualsubBtn');
            if (dualsubBtn) dualsubBtn.classList.remove('active-control');
            art.notice.show = 'Subtitles: Off';
          } else if (action === 'load') {
            const subUrl = item.dataset.subUrl;
            const subLabel = item.dataset.subLabel;
            art.subtitle.url = subUrl;
            art.subtitle.type = 'srt';
            art.subtitle.show = true;
            dd.querySelectorAll('.player-dropdown-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const dualsubLabel = document.getElementById('dualsubLabel');
            if (dualsubLabel) dualsubLabel.textContent = subLabel;
            const dualsubBtn = document.getElementById('dualsubBtn');
            if (dualsubBtn) dualsubBtn.classList.add('active-control');
            art.notice.show = `Subtitle: ${subLabel}`;
          } else if (action === 'upload') {
            document.getElementById('customSubInput').click();
            return;
          }

          dd.classList.remove('show');
          return;
        }

        dd.querySelectorAll('.player-dropdown-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        if (dd.id === 'langDropdown') {
          const langBtn = document.querySelector('#langBtn .player-text-btn-label');
          if (langBtn) langBtn.textContent = item.dataset.lang;
        }

        if (dd.id === 'qualityDropdown') {
          const qualityLabel = document.getElementById('qualityLabel');
          const cleanText = item.textContent.replace('VIP', '').trim();
          if (qualityLabel) qualityLabel.textContent = cleanText;

          const qHeight = parseInt(item.dataset.qheight);
          const qAuto = item.dataset.qauto === 'true';
          const qUrl = item.dataset.qurl;
          const qKind = item.dataset.qkind || '';
          const curStream = window.__currentStream || {};
          const curType = curStream.type || '';

          if (qAuto) {
            if (window.__dashPlayer) {
              window.__dashPlayer.updateSettings({
                streaming: { abr: { autoSwitchBitrate: { video: true } } },
              });
              art.notice.show = 'Quality: Auto';
            } else {
              // Auto for progressive/transcoded modes = highest available quality
              const plan = curStream.qualityPlan || [];
              const top = plan[0];
              if (top) {
                if (top.kind === 'mp4' && top.url) {
                  if (curType === 'video/mp4') art.switchUrl(top.url);
                  else { stopCurrentTranscode(); await switchToSource(top.url, 'video/mp4'); }
                } else if (top.kind === 'dash') {
                  if (!window.__dashPlayer && curStream.dashUrl) {
                    await switchToSource(curStream.dashUrl, 'application/dash+xml');
                  }
                } else if (top.kind === 'hls') {
                  await playTranscodedQuality(top.height);
                }
              }
              art.notice.show = 'Quality: Auto (highest)';
            }
          } else if (qKind === 'mp4' && qUrl) {
            if (curType === 'video/mp4') {
              art.switchUrl(qUrl);
            } else {
              stopCurrentTranscode();
              await switchToSource(qUrl, 'video/mp4');
            }
            art.notice.show = `Quality: ${cleanText}`;
          } else if (qKind === 'dash') {
            if (window.__dashPlayer && curType === 'application/dash+xml') {
              window.__dashPlayer.updateSettings({
                streaming: { abr: { autoSwitchBitrate: { video: false } } },
              });
              const bitrates = window.__dashPlayer.getBitrateInfoListFor('video');
              if (bitrates) {
                for (let i = 0; i < bitrates.length; i++) {
                  if (bitrates[i].height === qHeight) {
                    window.__dashPlayer.setQualityFor('video', bitrates[i].qualityIndex);
                    break;
                  }
                }
              }
              art.notice.show = `Quality: ${qHeight}p`;
            } else if (curStream.dashUrl) {
              window.__pendingDashHeight = qHeight;
              stopCurrentTranscode();
              await switchToSource(curStream.dashUrl, 'application/dash+xml');
              art.notice.show = `Quality: ${qHeight}p`;
            }
          } else if (qKind === 'hls') {
            await playTranscodedQuality(qHeight);
          } else if (qUrl) {
            art.switchUrl(qUrl);
            art.notice.show = `Quality: ${cleanText}`;
          }
        }

        dd.classList.remove('show');
      });
    });
  }, 500);
}

function closeAllDropdowns() {
  document.querySelectorAll('.player-dropdown.show').forEach(d => d.classList.remove('show'));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.player-text-btn') && !e.target.closest('.player-dropdown')) {
    closeAllDropdowns();
  }
});

function updateQualityControl(bitrates) {
  const qualityLabel = document.getElementById('qualityLabel');
  const qualityDropdown = document.getElementById('qualityDropdown');
  if (!qualityLabel || !qualityDropdown) return;

  const dashHeights = bitrates.map(b => b.height);
  const items = bitrates.map(b => `<div class="player-dropdown-item" data-qheight="${b.height}" data-qauto="false" data-qkind="dash">${b.height}p</div>`).join('');
  // Merge free MP4-only qualities (e.g. 360p) that DASH doesn't carry
  const plan = (window.__currentStream && window.__currentStream.qualityPlan) || [];
  const mp4Only = plan.filter(q => q.kind === 'mp4' && q.url && !dashHeights.includes(q.height));
  const mp4Items = mp4Only.map(q => `<div class="player-dropdown-item" data-qheight="${q.height}" data-qauto="false" data-qkind="mp4" data-qurl="${q.url}">${q.label}</div>`).join('');
  const autoItem = `<div class="player-dropdown-item active" data-qheight="0" data-qauto="true" data-qkind="dash">Auto</div>`;
  qualityDropdown.innerHTML = items + mp4Items + autoItem;

  qualityDropdown.querySelectorAll('.player-dropdown-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      qualityDropdown.querySelectorAll('.player-dropdown-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      qualityLabel.textContent = item.textContent;

      const qHeight = parseInt(item.dataset.qheight);
      const qAuto = item.dataset.qauto === 'true';
      const qKind = item.dataset.qkind || 'dash';
      const qUrl = item.dataset.qurl;

      // Switch to a direct MP4 source (leave DASH mode)
      if (qKind === 'mp4' && qUrl) {
        stopCurrentTranscode();
        await switchToSource(qUrl, 'video/mp4');
        qualityDropdown.classList.remove('show');
        return;
      }

      if (window.__dashPlayer) {
        if (qAuto) {
          window.__dashPlayer.updateSettings({
            streaming: { abr: { autoSwitchBitrate: { video: true } } },
          });
          window.__artPlayer.notice.show = 'Quality: Auto';
        } else {
          window.__dashPlayer.updateSettings({
            streaming: { abr: { autoSwitchBitrate: { video: false } } },
          });
          const list = window.__dashPlayer.getBitrateInfoListFor('video');
          if (list) {
            for (let i = 0; i < list.length; i++) {
              if (list[i].height === qHeight) {
                window.__dashPlayer.setQualityFor('video', list[i].qualityIndex);
                window.__artPlayer.notice.show = `Quality: ${qHeight}p`;
                break;
              }
            }
          }
        }
      }

      qualityDropdown.classList.remove('show');
    });
  });
}

// --- Season / Episode buttons ---
function bindSeasonEpisodeButtons(source, type, id) {
  let currentSeason = 1;
  let currentEp = 1;

  document.querySelectorAll('.season-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.season-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSeason = parseInt(tab.dataset.season);
      currentEp = 1;

      const seasonMap = window.__seasonMap || {};
      const maxEp = seasonMap[currentSeason] || 1;
      const grid = document.getElementById('episodeGrid');
      if (grid) {
        let html = '';
        for (let i = 1; i <= maxEp; i++) {
          html += `<button class="ep-btn${i === 1 ? ' active' : ''}" data-ep="${i}">${String(i).padStart(2, '0')}</button>`;
        }
        grid.innerHTML = html;
        grid.querySelectorAll('.ep-btn').forEach(btn => {
          btn.addEventListener('click', () => loadEpisode(btn, source, id, () => currentSeason, (v) => { currentEp = v; }));
        });
      }
    });
  });

  document.querySelectorAll('.ep-btn').forEach(btn => {
    btn.addEventListener('click', () => loadEpisode(btn, source, id, () => currentSeason, (v) => { currentEp = v; }));
  });
}

function loadEpisode(btn, source, id, getSeason, setEp) {
  document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const ep = parseInt(btn.dataset.ep);
  setEp(ep);

  if (source === 'moviebox' && currentDetail?.slug && id) {
    const season = getSeason();
    const slug = currentDetail.slug;
    stopCurrentTranscode();

    Promise.all([
      fetch(`/api/stream?subject_id=${id}&slug=${encodeURIComponent(slug)}&se=${season}&ep=${ep}`).then(r => r.json()),
      fetch(`/api/stream/${id}/captions?detail_path=${encodeURIComponent(slug)}&se=${season}&ep=${ep}`).then(r => r.json()).catch(() => null)
    ]).then(async ([streamData, captionData]) => {
      const validSources = (streamData.sources || []).filter(s => s.url && s.url.length > 0);
      const validDASH = (streamData.dash || []).filter(d => d.url && d.url.length > 0);
      const validHLS = (streamData.hls || []).filter(h => h.url && h.url.length > 0);

      const dashEntry = validDASH[0] || null;
      const dashCodec = String(dashEntry ? (dashEntry.codecName || dashEntry.codec || dashEntry.format || '') : '').toLowerCase();
      const dashIsHevc = /hevc|h265|hev1|hvc1/.test(dashCodec);
      const dashPlayable = !!(dashEntry && (!dashIsHevc || canPlayHEVC()));

      const mp4Qualities = validSources.map(s => {
        const h = parseInt(s.resolutions) || parseInt(s.resolution) || 0;
        return { height: h, label: (s.resolution || (h + 'p')), url: `/api/proxy?url=${encodeURIComponent(s.url)}`, kind: 'mp4' };
      }).filter(q => q.height > 0).sort((a, b) => b.height - a.height);

      let newSrc = '';
      let newType = '';
      let isDASH = false;
      let resolutions = [];
      let qualityPlan = [];

      if (dashPlayable) {
        newSrc = dashEntry.url;
        newType = 'application/dash+xml';
        isDASH = true;
        resolutions = (window.__dashManifest?.resolutions || []);
        qualityPlan = resolutions.map(r => ({ height: parseInt(r.height) || 0, label: r.label || r.height + 'p', kind: 'dash', url: '' }));
      } else if (mp4Qualities.length > 0) {
        newSrc = mp4Qualities[0].url;
        newType = 'video/mp4';
        resolutions = mp4Qualities.map(q => ({ height: q.height, label: q.label, url: q.url }));
        qualityPlan = mp4Qualities.map(q => ({ ...q }));
      } else if (validHLS.length > 0 && !dashEntry) {
        newSrc = validHLS[0].url;
        newType = 'application/x-mpegURL';
      }

      // Unlock the DASH-only (VIP-locked) qualities in the episode plan
      if (dashEntry && dashEntry.resolutions) {
        const hs = String(dashEntry.resolutions).split(',').map(h => parseInt(h)).filter(h => h > 0);
        for (const h of hs) {
          if (!qualityPlan.some(q => q.height === h)) {
            qualityPlan.push({ height: h, label: h + 'p', kind: dashPlayable ? 'dash' : 'hls', url: '' });
          }
        }
        qualityPlan.sort((a, b) => b.height - a.height);
      }

      // Nothing directly playable → transcode top quality
      if (!newSrc && dashEntry && qualityPlan.length) {
        const top = qualityPlan[0];
        try {
          const tc = await fetch(`/api/transcode/start?url=${encodeURIComponent(dashEntry.url)}&height=${top.height}`).then(r => r.json());
          if (tc && tc.playlist) {
            window.__transcodeId = tc.id;
            top.kind = 'hls';
            top.sessionId = tc.id;
            newSrc = tc.playlist;
            newType = 'application/x-mpegURL';
          }
        } catch (e) {}
      }

      if (newSrc) {
        window.__currentStream = {
          src: newSrc,
          type: newType,
          mp4Sources: validSources,
          dashUrl: dashEntry ? dashEntry.url : '',
          hlsUrl: validHLS.length > 0 ? validHLS[0].url : '',
          captionData: captionData,
          resolutions: resolutions,
          qualityPlan: qualityPlan,
          dashCodec: dashCodec,
          dashIsHevc: dashIsHevc,
          hevcOK: canPlayHEVC(),
          isEmbed: false,
        };

        initArtPlayer();
        setPlayingEpisode(ep);
      } else {
        fetch(`/api/tmdb-id?title=${encodeURIComponent(currentDetail?.title || '')}&type=tv`)
          .then(r => r.json())
          .then(tmdbResult => {
            const tmdbId = tmdbResult.tmdb_id;
            if (tmdbId) {
              const servers = getEmbedServers('tv', tmdbId, season, ep);
              window.__currentStream = {
                src: servers[0].url,
                resolutions: servers,
                isEmbed: true,
              };
              if (window.__artPlayer) {
                window.__artPlayer.destroy();
                window.__artPlayer = null;
              }
              if (window.__dashPlayer) {
                try { window.__dashPlayer.reset(); } catch (e) {}
                window.__dashPlayer = null;
              }
              initEmbedPlayer(servers[0].url, servers);
            }
          })
          .catch(() => {});
      }
    }).catch(() => {});
  }
}

function setPlayingEpisode(epNum) {
  document.querySelectorAll('.ep-btn').forEach(b => {
    b.classList.remove('playing', 'active');
    const n = parseInt(b.dataset.ep);
    if (n) b.innerHTML = String(n).padStart(2, '0');
  });
  const btn = document.querySelector(`.ep-btn[data-ep="${epNum}"]`);
  if (btn) {
    btn.classList.add('playing');
    btn.innerHTML = `<span class="equalizer"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>`;
  }
}

// --- Helpers ---
function showLoading() { loading.classList.remove('hidden'); }
function hideLoading() { loading.classList.add('hidden'); }
function esc(text) { const d = document.createElement('div'); d.textContent = text || ''; return d.innerHTML; }

// --- Init ---
loadPage();
