(function () {
  'use strict';

  if (globalThis.__mdmYouTubeOverlay) return;
  globalThis.__mdmYouTubeOverlay = true;
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') return;

  const CACHE_TTL = 5 * 60 * 1000;
  const YOUTUBE_DISMISS_KEY = 'mdm.overlay.youtube.dismissed';
  const GENERIC_DISMISS_KEY = 'mdm.overlay.video.dismissed';

  // Dismissal lives only in this page instance. Reloading the page brings the
  // overlay back automatically, while the extension popup can restore it on
  // open tabs without a reload.
  let youtubeDismissed = false;
  let genericDismissed = false;

  function isDismissed(key) {
    return key === YOUTUBE_DISMISS_KEY ? youtubeDismissed : genericDismissed;
  }

  function dismissOverlay(key) {
    if (key === YOUTUBE_DISMISS_KEY) youtubeDismissed = true;
    else genericDismissed = true;
  }

  function clearDismissals() {
    youtubeDismissed = false;
    genericDismissed = false;
  }

  function pageForRequest() {
    try {
      if (/^https?:$/.test(location.protocol)) return location.href;
    } catch {
      /* Fall through to the referrer for restricted frames. */
    }
    try {
      return /^https?:\/\//i.test(document.referrer) ? document.referrer : '';
    } catch {
      return '';
    }
  }

  const shadowCache = { at: 0, roots: [] };

  function shadowRoots() {
    const now = Date.now();
    if (now - shadowCache.at < 2000) return shadowCache.roots;
    const roots = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        visit(element.shadowRoot);
      }
    };
    try {
      visit(document);
    } catch {
      /* Some pages throw while traversing unusual DOM trees. */
    }
    shadowCache.at = now;
    shadowCache.roots = roots;
    return roots;
  }

  function collectVideos() {
    const found = Array.from(document.querySelectorAll('video'));
    for (const root of shadowRoots()) {
      for (const video of root.querySelectorAll('video')) found.push(video);
    }
    return found;
  }

  function isManifestUrl(value) {
    if (!value) return false;
    return (
      /\.(?:m3u8|m3u|mpd)(?:$|[?#])/i.test(value) ||
      /\/master\.txt(?:$|[?#])/i.test(value) ||
      /\.urlset(?:\/|$)/i.test(value)
    );
  }

  function isProtectedMediaError(value) {
    return /drm|protected|encrypted|\blive\b/i.test(String(value || ''));
  }

  function largestMediaSource() {
    const videos = Array.from(collectVideos())
      .filter((video) => genericEligible(video))
      .sort((left, right) => {
        const area = (video) => video.videoWidth * video.videoHeight;
        const playing = (video) => (video.paused ? 0 : 1);
        return playing(right) - playing(left) || area(right) - area(left);
      });
    const video = videos[0];
    if (!video) return '';
    const sources = genericCollectSources(video);
    return sources.find((source) => isManifestUrl(source.url))?.url || sources[0]?.url || '';
  }

  const MEDIA_URL_PATTERN = /\.(m3u8|m3u|mpd|mp4|m4v|mkv|webm|mov|flv|avi|ts|mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i;

  function collectPageCandidates() {
    const found = [];
    const seen = new Set();
    const add = (raw) => {
      if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return;
      let url;
      try {
        url = new URL(raw, location.href).href;
      } catch {
        return;
      }
      if (seen.has(url) || (!MEDIA_URL_PATTERN.test(url) && !isManifestUrl(url))) return;
      seen.add(url);
      found.push(url);
    };
    for (const video of collectVideos()) {
      add(video.currentSrc || video.src);
      video.querySelectorAll('source[src]').forEach((source) => add(source.src));
    }
    document.querySelectorAll('audio[src], source[src]').forEach((element) => add(element.src));
    for (const entry of genericResourceEntries()) add(entry.name);
    document.querySelectorAll('a[href]').forEach((element) => add(element.href));
    for (const url of sniffedMedia.urls) add(url);
    return found.slice(0, 24);
  }

  function collectEmbedPages() {
    const found = [];
    const seen = new Set();
    const add = (raw) => {
      if (typeof raw !== 'string' || !raw) return;
      let url;
      try {
        url = new URL(raw, location.href).href;
      } catch {
        return;
      }
      if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
      if (url === location.href || found.includes(url)) return;
      seen.add(url);
      found.push(url);
    };
    document
      .querySelectorAll('iframe[src], iframe[data-src], frame[src], embed[src], object[data]')
      .forEach((element) => add(element.src || element.data || element.getAttribute('data-src')));
    return found.slice(0, 6);
  }

  const sniffedMedia = { at: 0, urls: [] };

  async function readSniffedMedia() {
    try {
      const result = await send({ type: 'sniffed-media' });
      const urls = Array.isArray(result?.urls)
        ? result.urls.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
        : [];
      sniffedMedia.at = Date.now();
      if (urls.some((url) => !sniffedMedia.urls.includes(url))) {
        sniffedMedia.urls = urls.slice(-40);
        scheduleGenericScan();
      }
      return sniffedMedia.urls;
    } catch {
      sniffedMedia.at = Date.now();
      return sniffedMedia.urls;
    }
  }

  function refreshSniffedMedia() {
    const now = Date.now();
    if (now - sniffedMedia.at < 10_000) return;
    sniffedMedia.at = now;
    void readSniffedMedia();
  }

  function badgeText(loading, error, count) {
    if (error) return '!';
    if (loading || !count) return '...';
    return String(count);
  }

  if (globalThis.browser && globalThis.browser.runtime?.onMessage) {
    api.runtime.onMessage.addListener((message) => {
      if (!message || typeof message.type !== 'string') return undefined;
      if (message.type === 'mdm-find-media') return Promise.resolve({ url: largestMediaSource() });
      if (message.type === 'mdm-show-overlays') {
        clearDismissals();
        if (youtubeSite) sync(true);
        else if (globalThis.__mdmGenericOverlay) genericScan();
        return Promise.resolve({ ok: true });
      }
      if (message.type === 'mdm-page-candidates') {
        return Promise.resolve({ candidates: collectPageCandidates() });
      }
      return undefined;
    });
  } else {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return undefined;
      if (message.type === 'mdm-find-media') {
        sendResponse({ url: largestMediaSource() });
        return true;
      }
      if (message.type === 'mdm-show-overlays') {
        clearDismissals();
        if (youtubeSite) sync(true);
        else if (globalThis.__mdmGenericOverlay) genericScan();
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === 'mdm-page-candidates') {
        sendResponse({ candidates: collectPageCandidates() });
        return true;
      }
      return undefined;
    });
  }

  const state = {
    host: null,
    shadow: null,
    panel: null,
    badge: null,
    list: null,
    note: null,
    pill: null,
    videoId: '',
    title: '',
    formats: [],
    loading: false,
    error: '',
    requestId: 0,
    cache: new Map()
  };

  const STYLE = `
    :host {
      all: initial;
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 2147483646;
      pointer-events: none;
      font-family: "Segoe UI", Roboto, Arial, sans-serif;
      color: #f8fafc;
    }
    * { box-sizing: border-box; }
    .panel {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      width: max-content;
      gap: 6px;
      pointer-events: none;
      font-size: 12px;
      line-height: 1.35;
    }
    .pill, .menu { pointer-events: auto; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 999px;
      background: rgba(12, 21, 19, 0.92);
      color: #ecfdf5;
      padding: 6px 10px;
      min-height: 30px;
      cursor: grab;
      touch-action: none;
      user-select: none;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(10px);
      transition: background 120ms ease, border-color 120ms ease;
      font: inherit;
    }
    .pill:hover, .pill:focus-visible {
      background: rgba(13, 148, 136, 0.96);
      border-color: rgba(45, 212, 191, 0.7);
      outline: none;
    }
    .panel.dragging .pill { cursor: grabbing; }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 650;
      font-size: 11px;
      white-space: nowrap;
    }
    .brand svg {
      width: 14px;
      height: 14px;
      flex: none;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 999px;
      background: rgba(45, 212, 191, 0.2);
      color: #99f6e4;
      font-size: 10px;
      font-weight: 700;
    }
    .close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-left: -2px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.25);
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      flex: none;
    }
    .close:hover {
      background: rgba(251, 113, 133, 0.55);
      color: #fff;
    }
    .menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      display: none;
      width: 268px;
      max-height: min(420px, 60vh);
      overflow: hidden;
      flex-direction: column;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 12px;
      background: rgba(9, 17, 15, 0.97);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(14px);
    }
    .panel.open .menu { display: flex; }
    .panel.menu-up .menu {
      top: auto;
      bottom: calc(100% + 6px);
    }
    .head {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 11px 12px 9px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.16);
    }
    .head strong { font-size: 12px; font-weight: 650; }
    .head span {
      color: #94a3b8;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list {
      padding: 6px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .format {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #e2e8f0;
      padding: 8px 9px;
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .format:hover, .format:focus-visible {
      background: rgba(20, 184, 166, 0.16);
      outline: none;
    }
    .format[disabled] { cursor: wait; opacity: 0.55; }
    .format-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .format-copy strong { font-size: 12px; font-weight: 650; }
    .format-copy span {
      color: #94a3b8;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .format-meta {
      color: #5eead4;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      flex: none;
    }
    .note {
      padding: 12px;
      color: #cbd5e1;
      font-size: 11px;
      white-space: normal;
      word-break: break-word;
    }
    .note.error { color: #fda4af; }
    .retry {
      display: inline-flex;
      margin-top: 8px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 7px;
      background: rgba(30, 41, 59, 0.8);
      color: #e2e8f0;
      padding: 5px 9px;
      cursor: pointer;
      font: inherit;
    }
    .foot {
      padding: 7px 12px;
      border-top: 1px solid rgba(148, 163, 184, 0.14);
      color: #64748b;
      font-size: 9px;
      text-align: right;
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(94, 234, 212, 0.25);
      border-top-color: #5eead4;
      border-radius: 50%;
      display: inline-block;
      animation: mdm-spin 800ms linear infinite;
    }
    @keyframes mdm-spin { to { transform: rotate(360deg); } }
  `;

  function send(message) {
    if (globalThis.browser && globalThis.browser.runtime) {
      return globalThis.browser.runtime.sendMessage(message).then(unwrap);
    }
    return new Promise((resolve, reject) => {
      try {
        api.runtime.sendMessage(message, (response) => {
          const error = api.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          try {
            resolve(unwrap(response));
          } catch (failure) {
            reject(failure);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function unwrap(response) {
    if (!response) throw new Error('MDM did not respond. Is the desktop app running?');
    if (response.ok === false) throw new Error(response.error || 'The request failed.');
    return response.data === undefined ? response : response.data;
  }

  function videoIdFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
      const watch = url.searchParams.get('v');
      if (watch) return watch;
      const match = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }

  function findPlayer() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function readPosition(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (!value || !Number.isFinite(value.xRatio) || !Number.isFinite(value.yRatio)) return null;
      return {
        xRatio: Math.min(1, Math.max(0, value.xRatio)),
        yRatio: Math.min(1, Math.max(0, value.yRatio))
      };
    } catch {
      return null;
    }
  }

  function storePosition(key, left, top, width, height) {
    if (width <= 0 || height <= 0) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          xRatio: Math.min(1, Math.max(0, left / width)),
          yRatio: Math.min(1, Math.max(0, top / height))
        })
      );
    } catch {
      /* Storage may be unavailable on restricted pages. */
    }
  }

  const POSITION_MARGIN = 8;
  const YOUTUBE_POSITION_KEY = 'mdm.overlay.youtube.position.v2';
  const GENERIC_POSITION_KEY = 'mdm.overlay.video.position.v2';

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function overlayParent(anchor) {
    const fullscreen = document.fullscreenElement;
    if (fullscreen && (fullscreen === anchor || fullscreen.contains(anchor))) return fullscreen;
    return document.body;
  }

  function overlayLimits(host) {
    return {
      left: Math.max(POSITION_MARGIN, window.innerWidth - host.offsetWidth - POSITION_MARGIN),
      top: Math.max(POSITION_MARGIN, window.innerHeight - host.offsetHeight - POSITION_MARGIN)
    };
  }

  function placeOverlay(host, key, anchorRect) {
    host.style.display = 'block';
    const width = host.offsetWidth;
    const height = host.offsetHeight;
    const maxLeft = Math.max(POSITION_MARGIN, window.innerWidth - width - POSITION_MARGIN);
    const maxTop = Math.max(POSITION_MARGIN, window.innerHeight - height - POSITION_MARGIN);
    const saved = readPosition(key);
    const defaultLeft = anchorRect ? anchorRect.right - width - POSITION_MARGIN : maxLeft;
    const defaultTop = anchorRect ? anchorRect.top + POSITION_MARGIN : POSITION_MARGIN;
    return {
      left: saved ? clamp(saved.xRatio * window.innerWidth, POSITION_MARGIN, maxLeft) : clamp(defaultLeft, POSITION_MARGIN, maxLeft),
      top: saved ? clamp(saved.yRatio * window.innerHeight, POSITION_MARGIN, maxTop) : clamp(defaultTop, POSITION_MARGIN, maxTop)
    };
  }

  function orientPanel(target) {
    const { panel } = target;
    const menu = panel.querySelector('.menu');
    if (!menu) return;
    panel.classList.remove('menu-up');
    menu.style.left = 'auto';
    menu.style.right = '0';
    if (!panel.classList.contains('open')) return;
    const host = panel.getBoundingClientRect();
    if (host.left + 268 <= window.innerWidth - POSITION_MARGIN) {
      menu.style.left = '0';
      menu.style.right = 'auto';
    }
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - POSITION_MARGIN && host.top > menuRect.height + POSITION_MARGIN) {
      panel.classList.add('menu-up');
    }
  }

  function enableDrag(target, options) {
    let drag = null;
    let suppressClick = false;
    target.pill.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      // The close control lives inside the pill. Starting a drag (and capturing
      // the pointer) there would retarget the following click to the pill, so
      // the overlay would open instead of closing.
      if (event.target instanceof Element && event.target.closest('.close')) return;
      const origin = options.origin();
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: origin.left,
        top: origin.top,
        moved: false
      };
      try {
        target.pill.setPointerCapture(event.pointerId);
      } catch {
        /* Pointer capture is best effort. */
      }
    });
    target.pill.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) {
        target.panel.classList.remove('open');
        target.pill.setAttribute('aria-expanded', 'false');
      }
      drag.moved = true;
      target.panel.classList.add('dragging');
      const limit = options.limit();
      const minimum = options.minimum ? options.minimum() : { left: 0, top: 0 };
      drag.left = Math.min(limit.left, Math.max(minimum.left, drag.left + dx));
      drag.top = Math.min(limit.top, Math.max(minimum.top, drag.top + dy));
      drag.x = event.clientX;
      drag.y = event.clientY;
      options.move(drag.left, drag.top);
    });
    const finish = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      const left = drag.left;
      const top = drag.top;
      drag = null;
      target.panel.classList.remove('dragging');
      try {
        target.pill.releasePointerCapture(event.pointerId);
      } catch {
        /* The pointer may already be released. */
      }
      if (!moved) return;
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
      options.onEnd(left, top);
    };
    target.pill.addEventListener('pointerup', finish);
    target.pill.addEventListener('pointercancel', finish);
    target.pill.addEventListener('click', (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.target instanceof Element && event.target.closest('.close')) return;
      options.toggle();
    });
  }

  function togglePanel(target) {
    target.panel.classList.toggle('open');
    target.pill.setAttribute('aria-expanded', target.panel.classList.contains('open') ? 'true' : 'false');
    orientPanel(target);
  }

  function mount() {
    const player = findPlayer();
    if (!player) {
      if (state.host) state.host.style.display = 'none';
      return false;
    }
    if (isDismissed(YOUTUBE_DISMISS_KEY)) {
      if (state.host) state.host.style.display = 'none';
      return false;
    }
    if (!state.host) build();
    if (!state.host) return false;
    requestAnimationFrame(applyYouTubePosition);
    return true;
  }

  function applyYouTubePosition() {
    const host = state.host;
    const player = findPlayer();
    if (!host || !player || state.panel?.classList.contains('dragging')) return;
    const rect = player.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    ) {
      host.style.display = 'none';
      return;
    }
    const parent = overlayParent(player);
    if (host.parentElement !== parent) parent.appendChild(host);
    const { left, top } = placeOverlay(host, YOUTUBE_POSITION_KEY, rect);
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    if (state.panel.classList.contains('open')) orientPanel(state);
  }

  function build() {
    const host = document.createElement('div');
    host.setAttribute('data-mdm-overlay', 'youtube');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<button class="pill" type="button" aria-label="Download video with MDM" aria-expanded="false">' +
      '<span class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Download video with MDM</span></span>' +
      '<span class="badge">...</span><span class="close" role="button" tabindex="0" title="Hide this overlay">×</span></button>' +
      '<div class="menu" role="dialog" aria-label="Download YouTube video with MDM">' +
      '<div class="head"><strong>Download video with MDM</strong><span class="video-title">YouTube video</span></div>' +
      '<div class="list"></div><div class="note" hidden></div><div class="foot">Powered by MDM</div></div>';
    shadow.appendChild(panel);
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.display = 'none';

    state.host = host;
    state.shadow = shadow;
    state.panel = panel;
    state.pill = panel.querySelector('.pill');
    state.badge = panel.querySelector('.badge');
    state.list = panel.querySelector('.list');
    state.note = panel.querySelector('.note');

    enableDrag(state, {
      origin: () => {
        const rect = host.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      },
      limit: () => overlayLimits(host),
      minimum: () => ({ left: POSITION_MARGIN, top: POSITION_MARGIN }),
      move: (left, top) => {
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
      },
      onEnd: (left, top) => {
        storePosition(YOUTUBE_POSITION_KEY, left, top, window.innerWidth, window.innerHeight);
      },
      toggle: () => {
        togglePanel(state);
        if (panel.classList.contains('open') && !state.loading && !state.formats.length && !state.error) load();
        requestAnimationFrame(applyYouTubePosition);
      }
    });
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        panel.classList.remove('open');
        state.pill.setAttribute('aria-expanded', 'false');
        state.pill.focus();
        requestAnimationFrame(applyYouTubePosition);
      }
    });
    const close = panel.querySelector('.close');
    if (close) {
      const hideForPage = () => {
        dismissOverlay(YOUTUBE_DISMISS_KEY);
        state.requestId++;
        state.loading = false;
        state.formats = [];
        state.error = '';
        if (state.host) state.host.style.display = 'none';
      };
      close.addEventListener('pointerdown', (event) => event.stopPropagation());
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        hideForPage();
      });
      close.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          hideForPage();
        }
      });
    }
  }

  function render() {
    if (!state.panel) return;
    const title = state.panel.querySelector('.video-title');
    if (title) title.textContent = state.title || 'YouTube video';
    state.badge.textContent = badgeText(state.loading, state.error, state.formats.length);
    state.badge.style.background = state.error ? 'rgba(251, 113, 133, 0.2)' : '';
    state.badge.style.color = state.error ? '#fecdd3' : '';

    while (state.list.firstChild) state.list.removeChild(state.list.firstChild);
    if (state.loading) {
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = '<span class="spinner"></span> Reading available qualities...';
      state.list.appendChild(note);
    } else if (state.error) {
      const note = document.createElement('div');
      note.className = 'note error';
      note.textContent = state.error;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', (event) => {
        event.stopPropagation();
        load(true);
      });
      note.appendChild(document.createElement('br'));
      note.appendChild(retry);
      state.list.appendChild(note);
    } else if (!state.formats.length) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'No downloadable qualities were found.';
      state.list.appendChild(note);
    } else {
      for (const format of state.formats) state.list.appendChild(formatButton(format));
    }

    const hasContent = state.loading || Boolean(state.error) || state.formats.length > 0;
    state.note.hidden = true;
    if (!hasContent) state.list.hidden = true;
    else state.list.hidden = false;
    if (state.panel.classList.contains('open')) orientPanel(state);
  }

  function formatButton(format) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'format';
    button.setAttribute('role', 'menuitem');
    const copy = document.createElement('span');
    copy.className = 'format-copy';
    const label = document.createElement('strong');
    label.textContent = format.label || 'Video';
    const detail = document.createElement('span');
    detail.textContent = formatDetail(format);
    copy.appendChild(label);
    copy.appendChild(detail);
    const meta = document.createElement('span');
    meta.className = 'format-meta';
    meta.textContent = format.mimeType?.startsWith('audio/')
      ? 'AUDIO'
      : format.mimeType?.includes('webm')
        ? 'WEBM'
        : 'MP4';
    button.appendChild(copy);
    button.appendChild(meta);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void download(format, button);
    });
    return button;
  }

  function formatDetail(format) {
    const parts = [];
    if (format.sizeBytes) parts.push(formatBytes(format.sizeBytes));
    if (format.language) parts.push(format.language);
    if (!parts.length && format.codecs) parts.push(format.codecs.split(',')[0]);
    return parts.join(' · ') || 'Video and audio';
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
  }

  function readStoredProbe(videoId) {
    try {
      const value = JSON.parse(localStorage.getItem(`mdm.probe.youtube.${videoId}`) || 'null');
      if (!value || Date.now() - value.at > 30 * 60_000 || !Array.isArray(value.formats) || !value.formats.length) return null;
      return value;
    } catch {
      return null;
    }
  }

  function storeProbe(videoId, formats, title) {
    try {
      localStorage.setItem(
        `mdm.probe.youtube.${videoId}`,
        JSON.stringify({ at: Date.now(), formats, title })
      );
    } catch {
      /* Storage may be unavailable on restricted pages. */
    }
  }

  async function load(force) {
    const videoId = state.videoId;
    if (!videoId) return;
    const cached = state.cache.get(videoId);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
      state.formats = cached.formats;
      state.title = cached.title;
      state.error = '';
      state.loading = false;
      render();
      return;
    }
    const stored = force ? null : readStoredProbe(videoId);
    if (stored) {
      state.formats = stored.formats.filter((format) => format && !format.protected);
      state.title = stored.title || 'YouTube video';
      state.error = state.formats.length ? '' : 'No downloadable qualities were found.';
      state.loading = false;
      state.cache.set(videoId, { at: Date.now(), formats: state.formats, title: state.title });
      render();
      return;
    }
    const requestId = ++state.requestId;
    state.loading = true;
    state.error = '';
    state.formats = [];
    state.title = '';
    render();
    try {
      const probe = await send({ type: 'youtube-probe', pageUrl: pageForRequest() });
      if (requestId !== state.requestId) return;
      if (!probe || probe.kind !== 'youtube') throw new Error('MDM could not read this YouTube video.');
      const formats = Array.isArray(probe.formats)
        ? probe.formats.filter((format) => format && !format.protected)
        : [];
      state.title = probe.title || 'YouTube video';
      state.formats = formats;
      state.error = formats.length ? '' : probe.error || 'No downloadable qualities were found.';
      if (formats.length) {
        state.cache.set(videoId, { at: Date.now(), formats, title: state.title });
        storeProbe(videoId, formats, state.title);
      }
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.error = error && error.message ? error.message : 'Could not read this YouTube video.';
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        render();
      }
    }
  }

  async function download(format, button) {
    if (!format || !format.id) return;
    const original = button.querySelector('.format-copy span');
    const previous = original ? original.textContent : '';
    button.disabled = true;
    if (original) original.textContent = 'Sending to MDM...';
    try {
      const result = await send({
        type: 'youtube-download',
        formatId: format.id,
        pageUrl: pageForRequest(),
        mediaTitle: state.title,
        mediaQuality: format.label
      });
      if (original) original.textContent = result?.pending ? 'Review in MDM' : 'Queued in MDM';
      setTimeout(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        if (original) original.textContent = previous;
      }, 2200);
    } catch (error) {
      button.disabled = false;
      if (original) original.textContent = previous;
      state.error = error && error.message ? error.message : 'MDM could not add this download.';
      render();
    }
  }

  function sync(force) {
    const videoId = videoIdFromLocation();
    if (!videoId) {
      state.videoId = '';
      state.requestId++;
      state.loading = false;
      state.formats = [];
      state.error = '';
      if (state.host) state.host.style.display = 'none';
      return;
    }
    if (!mount()) return;
    if (videoId !== state.videoId) {
      state.videoId = videoId;
      state.title = '';
      state.formats = [];
      state.error = '';
      state.loading = false;
      state.requestId++;
      render();
      load();
      return;
    }
    if (!state.formats.length && !state.loading && !state.error && !state.cache.has(videoId)) {
      load();
      return;
    }
    if (force) load(true);
  }

  const generic = {
    instances: new Map(),
    scanTimer: 0,
    cache: new Map(),
    resourceCache: { at: 0, entries: [] }
  };

  function genericMediaResource(entry) {
    const name = entry.name;
    if (/\.(?:ts|m4s|aac|vtt|jpg|jpeg|png|gif|webp|css|js|svg)(?:$|[?#])/i.test(name)) return false;
    // Allow all file-type downloads through MDM, not only video/audio.
    if (/\.(?:bin|zip|tar|gz|rar|7z|bz2|xz|exe|msi|dmg|apk|iso|img|deb|rpm|pkg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json|xml|log)(?:$|[?#])/i.test(name)) return true;
    if (/\.(?:m3u8|mpd|mp4|webm|m4v|mov|mkv|flv|avi|mp3|m4a|ogg|opus|wav|flac)(?:$|[?#])/i.test(name)) return true;
    if (entry.initiatorType === 'video' || entry.initiatorType === 'audio') return true;
    if (entry.initiatorType === 'xmlhttprequest' || entry.initiatorType === 'fetch') {
      // Manifest and media responses fetched by players over XHR/fetch.
      return /(?:\.m3u8|\.mpd|\.mp4|\.webm|master|manifest|playlist|index)(?:$|[?#/])/i.test(name);
    }
    return /(?:manifest|playlist|master)(?:\.(?:m3u8|mpd|json|txt))?(?:$|[?#])/i.test(name);
  }

  function genericResourceEntries() {
    const now = Date.now();
    if (now - generic.resourceCache.at < 1500) return generic.resourceCache.entries;
    const entries = performance
      .getEntriesByType('resource')
      .filter((entry) => genericMediaResource(entry))
      .slice(-120)
      .map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType }));
    generic.resourceCache = { at: now, entries };
    return entries;
  }

  function genericEligible(video) {
    if (!(video instanceof HTMLVideoElement) || video.closest('[data-mdm-ignore]')) return false;
    if (video.closest('[data-ad], .video-ads, .ytp-ad-module, #ad-container')) return false;
    const rect = video.getBoundingClientRect();
    // Tiny players inside sub-frames are mostly ads; top-level pages keep the
    // original small-player threshold so mobile-sized and embedded videos still work.
    const inSubFrame = window !== window.top;
    if (rect.width < (inSubFrame ? 300 : 100) || rect.height < (inSubFrame ? 200 : 60)) return false;
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number.isFinite(video.duration) && video.duration > 0 && video.duration < 2) return false;
    return true;
  }

  function genericTitle(video) {
    const meta = document.querySelector('meta[property="og:title"]');
    const candidate = video.getAttribute('title') || video.getAttribute('aria-label') || meta?.content || document.title;
    return String(candidate || 'Video on this page').trim().slice(0, 140);
  }

  function genericCollectSources(video) {
    const found = [];
    const seen = new Set();
    const add = (raw, label = '', mime = '') => {
      try {
        const url = new URL(raw, location.href);
        if (!/^https?:/i.test(url.href) || seen.has(url.href)) return;
        seen.add(url.href);
        found.push({ url: url.href, label: String(label || '').slice(0, 80), mime: String(mime || '') });
      } catch {
        /* Ignore malformed sources. */
      }
    };
    const direct = video.currentSrc || video.src;
    if (direct) add(direct);
    video.querySelectorAll('source[src]').forEach((source) => {
      add(
        source.src,
        source.getAttribute('data-res') || source.getAttribute('label') || source.getAttribute('title') || '',
        source.type || ''
      );
    });
    if (!found.length || (direct && direct.startsWith('blob:'))) {
      for (const entry of genericResourceEntries()) {
        add(entry.name, entry.initiatorType === 'video' ? 'Media stream' : 'Page media');
      }
      for (const url of sniffedMedia.urls) add(url, 'Network media');
      const meta = document.querySelector(
        'meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"]'
      );
      if (meta?.content) add(meta.content, 'Page video');
    }
    const rank = (item) => {
      if (isManifestUrl(item.url)) {
        return /\.(?:m3u8|m3u)(?:$|[?#])/i.test(item.url) ? 0 : 1;
      }
      return /\.(?:mp4|webm|m4v|mov|mkv|flv|avi)(?:$|[?#])/i.test(item.url) ? 2 : 3;
    };
    return found.sort((left, right) => rank(left) - rank(right)).slice(0, 10);
  }

  function genericDirectFormats(video, sources) {
    return sources
      .filter((source) => !isManifestUrl(source.url))
      .map((source, index) => {
        const extension = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(source.url)?.[1]?.toLowerCase() ?? '';
        const audioMime = {
          mp3: 'audio/mpeg',
          m4a: 'audio/mp4',
          aac: 'audio/aac',
          flac: 'audio/flac',
          wav: 'audio/wav',
          ogg: 'audio/ogg',
          opus: 'audio/opus'
        }[extension];
        const mime =
          source.mime || audioMime || (extension === 'webm' ? 'video/webm' : extension === 'mp4' ? 'video/mp4' : '');
        const isCurrent = source.url === video.currentSrc || (!video.currentSrc && index === 0);
        const resolution =
          isCurrent && video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : '';
        return {
          id: '',
          type: 'http',
          label: source.label || (index === 0 && video.videoHeight ? `${video.videoHeight}p` : extension ? extension.toUpperCase() : 'Video'),
          resolution,
          mimeType: mime,
          sizeBytes: 0,
          codecs: '',
          language: '',
          protected: false,
          directUrl: source.url
        };
      });
  }

  function genericFormatDetail(format) {
    const parts = [];
    if (format.sizeBytes) parts.push(formatBytes(format.sizeBytes));
    if (format.resolution) parts.push(format.resolution);
    if (format.language) parts.push(format.language);
    if (!parts.length && format.codecs) parts.push(format.codecs.split(',')[0]);
    return parts.join(' · ') || 'Direct video file';
  }

  function genericFormatMeta(format) {
    if (format.mimeType?.startsWith('audio/')) return 'AUDIO';
    if (format.type === 'youtube') return 'AUTO';
    if (format.type === 'hls') return 'HLS';
    if (format.type === 'dash') return 'DASH';
    if (format.mimeType?.includes('webm')) return 'WEBM';
    if (format.mimeType?.includes('mp4')) return 'MP4';
    return 'VIDEO';
  }

  function genericBuild(video) {
    const host = document.createElement('div');
    host.setAttribute('data-mdm-overlay', 'video');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<button class="pill" type="button" aria-label="Download video with MDM" aria-expanded="false">' +
      '<span class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Download video with MDM</span></span>' +
      '<span class="badge">...</span><span class="close" role="button" tabindex="0" title="Hide this overlay">×</span></button>' +
      '<div class="menu" role="dialog" aria-label="Download video with MDM">' +
      '<div class="head"><strong>Download video with MDM</strong><span class="video-title">Video on this page</span></div>' +
      '<div class="list"></div><div class="note" hidden></div><div class="foot">Powered by MDM</div></div>';
    shadow.appendChild(panel);
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.display = 'none';

    const instance = {
      video,
      host,
      shadow,
      panel,
      pill: panel.querySelector('.pill'),
      badge: panel.querySelector('.badge'),
      title: panel.querySelector('.video-title'),
      list: panel.querySelector('.list'),
      note: panel.querySelector('.note'),
      sources: [],
      sourceKey: '',
      height: 0,
      formats: [],
      loading: false,
      error: '',
      requestId: 0,
      pageOverride: '',
      titleText: genericTitle(video),
      lastCheck: 0
    };
    document.body.appendChild(host);
    instance.title.textContent = instance.titleText;
    enableDrag(instance, {
      origin: () => {
        const rect = host.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      },
      limit: () => overlayLimits(host),
      minimum: () => ({ left: POSITION_MARGIN, top: POSITION_MARGIN }),
      move: (left, top) => {
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
      },
      onEnd: (left, top) => {
        storePosition(GENERIC_POSITION_KEY, left, top, window.innerWidth, window.innerHeight);
      },
      toggle: () => {
        togglePanel(instance);
        if (instance.panel.classList.contains('open')) {
          if (!instance.formats.length && !instance.loading && !instance.error) void genericLoad(instance);
        }
        requestAnimationFrame(() => genericPosition(instance));
      }
    });
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        instance.panel.classList.remove('open');
        instance.pill.setAttribute('aria-expanded', 'false');
        instance.pill.focus();
        requestAnimationFrame(() => genericPosition(instance));
      }
    });
    const close = panel.querySelector('.close');
    if (close) {
      const hideForPage = () => {
        dismissOverlay(GENERIC_DISMISS_KEY);
        genericScan();
      };
      close.addEventListener('pointerdown', (event) => event.stopPropagation());
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        hideForPage();
      });
      close.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          hideForPage();
        }
      });
    }
    generic.instances.set(video, instance);
    genericUpdate(instance, true);
    genericRender(instance);
    genericPosition(instance);
    return instance;
  }

  function genericRender(instance) {
    instance.badge.textContent = badgeText(instance.loading, instance.error, instance.formats.length);
    instance.badge.style.background = instance.error ? 'rgba(251, 113, 133, 0.2)' : '';
    instance.badge.style.color = instance.error ? '#fecdd3' : '';
    instance.title.textContent = instance.titleText || 'Video on this page';

    while (instance.list.firstChild) instance.list.removeChild(instance.list.firstChild);
    if (instance.loading) {
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = '<span class="spinner"></span> Reading available qualities...';
      instance.list.appendChild(note);
    } else if (instance.error) {
      const note = document.createElement('div');
      note.className = 'note error';
      note.textContent = instance.error;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', (event) => {
        event.stopPropagation();
        void genericLoad(instance, true);
      });
      note.appendChild(document.createElement('br'));
      note.appendChild(retry);
      instance.list.appendChild(note);
    } else if (!instance.formats.length) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'This player does not expose a downloadable video source.';
      instance.list.appendChild(note);
    } else {
      for (const format of instance.formats) instance.list.appendChild(genericFormatButton(instance, format));
    }

    instance.note.hidden = true;
    instance.list.hidden = false;
    if (instance.panel.classList.contains('open')) orientPanel(instance);
  }

  function genericFormatButton(instance, format) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'format';
    button.setAttribute('role', 'menuitem');
    const copy = document.createElement('span');
    copy.className = 'format-copy';
    const label = document.createElement('strong');
    label.textContent = format.label || 'Video';
    const detail = document.createElement('span');
    detail.textContent = genericFormatDetail(format);
    copy.appendChild(label);
    copy.appendChild(detail);
    const meta = document.createElement('span');
    meta.className = 'format-meta';
    meta.textContent = genericFormatMeta(format);
    button.appendChild(copy);
    button.appendChild(meta);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void genericDownload(instance, format, button);
    });
    return button;
  }

  async function genericDownload(instance, format, button) {
    const pageFormat = format.type === 'youtube';
    const page = instance.pageOverride || pageForRequest();
    let source = null;
    if (!pageFormat) {
      source = format.directUrl
        ? instance.sources.find((item) => item.url === format.directUrl)
        : instance.sources.find((item) => isManifestUrl(item.url)) ?? instance.sources[0];
      if (!source) {
        instance.error = 'This player does not expose a downloadable video source.';
        genericRender(instance);
        return;
      }
    }
    const original = button.querySelector('.format-copy span');
    const previous = original ? original.textContent : '';
    button.disabled = true;
    if (original) original.textContent = 'Sending to MDM...';
    try {
      const result = pageFormat
        ? await send({
            type: 'page-download',
            formatId: format.id,
            pageUrl: page,
            mediaTitle: instance.titleText,
            mediaQuality: format.label
          })
        : await send({
            type: 'download-media',
            url: source.url,
            formatId: format.id || '',
            pageUrl: page,
            mediaTitle: instance.titleText,
            mediaQuality: format.label
          });
      if (original) original.textContent = result?.pending ? 'Review in MDM' : 'Queued in MDM';
      setTimeout(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        if (original) original.textContent = previous;
      }, 2200);
    } catch (error) {
      button.disabled = false;
      if (original) original.textContent = previous;
      instance.error = error && error.message ? error.message : 'MDM could not add this download.';
      genericRender(instance);
    }
  }

  async function genericLoad(instance, force) {
    if (instance.loading) return;
    refreshSniffedMedia();
    const manifests = instance.sources.filter((source) => isManifestUrl(source.url));
    if (!manifests.length) {
      await genericPageProbe(instance, force);
      return;
    }
    const requestId = ++instance.requestId;
    instance.loading = true;
    instance.error = '';
    genericRender(instance);
    const page = pageForRequest();
    // Probe every manifest at once. Players often expose several mirrors and
    // waiting for each dead one in turn makes the panel feel stuck.
    const outcomes = await Promise.all(
      manifests.map(async (manifest) => {
        const cached = generic.cache.get(manifest.url);
        if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
          return { manifest, formats: cached.formats, title: cached.title, rawCount: cached.formats.length };
        }
        try {
          const probe = await send({ type: 'probe-media', url: manifest.url, pageUrl: page });
          const returned = Array.isArray(probe?.formats) ? probe.formats : [];
          return {
            manifest,
            formats: returned.filter((format) => format && !format.protected),
            rawCount: returned.length,
            title: probe?.title || '',
            error: probe?.error || ''
          };
        } catch (error) {
          return {
            manifest,
            formats: [],
            rawCount: 0,
            title: '',
            error: error && error.message ? error.message : 'MDM could not inspect this video.'
          };
        }
      })
    );
    if (requestId !== instance.requestId) return;
    let lastError = '';
    let returnedAnyFormats = false;
    for (const outcome of outcomes) {
      if (outcome.formats.length) {
        instance.formats = outcome.formats;
        instance.titleText = outcome.title || instance.titleText;
        generic.cache.set(outcome.manifest.url, {
          at: Date.now(),
          formats: outcome.formats,
          title: instance.titleText
        });
        instance.loading = false;
        genericRender(instance);
        return;
      }
      if (outcome.rawCount > 0) {
        returnedAnyFormats = true;
        lastError = 'This video is protected and cannot be downloaded.';
      } else if (outcome.error) {
        lastError = outcome.error;
      }
    }
    instance.loading = false;
    if (!returnedAnyFormats && (!lastError || !isProtectedMediaError(lastError))) {
      await genericPageProbe(instance, force, lastError);
      return;
    }
    instance.error = lastError || 'No downloadable qualities were found.';
    genericRender(instance);
  }

  async function genericPageScanFallback(instance, requestId, fallbackError = '') {
    // yt-dlp could not read the page (unsupported site, sign-in wall, etc.).
    // Scan the page itself and the network-sniffed URLs before giving up.
    await readSniffedMedia();
    if (requestId !== instance.requestId) return false;
    const candidates = collectPageCandidates();
    const manifests = candidates.filter((url) => isManifestUrl(url));
    for (const manifest of manifests) {
      if (requestId !== instance.requestId) return true;
      try {
        const probe = await send({ type: 'probe-media', url: manifest, pageUrl: pageForRequest() });
        if (requestId !== instance.requestId) return true;
        const formats = (Array.isArray(probe?.formats) ? probe.formats : []).filter((format) => format && !format.protected);
        if (!formats.length) continue;
        instance.formats = formats;
        instance.sources = [{ url: manifest, label: '' }];
        instance.sourceKey = manifest;
        instance.titleText = probe.title || instance.titleText;
        generic.cache.set(manifest, { at: Date.now(), formats, title: instance.titleText });
        return true;
      } catch {
        /* Try the next candidate. */
      }
    }
    const directs = candidates.filter((url) => !isManifestUrl(url));
    if (directs.length) {
      if (requestId !== instance.requestId) return true;
      instance.sources = directs.map((url) => ({ url, label: '' }));
      instance.sourceKey = instance.sources.map((source) => source.url).join('|');
      instance.formats = genericDirectFormats(instance.video, instance.sources);
      if (instance.formats.length) return true;
      instance.sources = [];
      instance.sourceKey = '';
    }
    return false;
  }

  async function probeEmbeddedPages(instance, requestId) {
    for (const embed of collectEmbedPages()) {
      if (requestId !== instance.requestId) return false;
      try {
        const probe = await send({ type: 'page-probe', pageUrl: embed });
        if (requestId !== instance.requestId) return false;
        const returned = Array.isArray(probe?.formats) ? probe.formats : [];
        const formats = returned.filter((format) => format && !format.protected);
        if (!formats.length) continue;
        instance.formats = formats;
        instance.titleText = probe.title || instance.titleText;
        instance.pageOverride = embed;
        generic.cache.set(`page:${embed}`, { at: Date.now(), formats, title: instance.titleText });
        return true;
      } catch {
        /* Try the next embedded player. */
      }
    }
    return false;
  }

  async function genericPageProbe(instance, force, fallbackError = '') {
    const page = pageForRequest();
    if (!page) {
      instance.error = 'This player does not expose a downloadable video source.';
      genericRender(instance);
      return;
    }
    const cacheKey = `page:${page}`;
    const cached = generic.cache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
      instance.formats = cached.formats;
      instance.titleText = cached.title || instance.titleText;
      instance.pageOverride = page;
      instance.error = '';
      genericRender(instance);
      return;
    }
    const requestId = ++instance.requestId;
    instance.loading = true;
    instance.error = '';
    genericRender(instance);
    let reportedError = fallbackError;
    try {
      const probe = await send({ type: 'page-probe', pageUrl: page });
      if (requestId !== instance.requestId) return;
      const returned = Array.isArray(probe?.formats) ? probe.formats : [];
      const formats = returned.filter((format) => format && !format.protected);
      if (formats.length) {
        instance.formats = formats;
        instance.titleText = probe.title || instance.titleText;
        instance.pageOverride = page;
        generic.cache.set(cacheKey, { at: Date.now(), formats, title: instance.titleText });
        return;
      }
      reportedError = returned.length
        ? 'This video is protected and cannot be downloaded.'
        : probe?.error || fallbackError;
      const handled = await genericPageScanFallback(instance, requestId, reportedError);
      if (handled) return;
      if (await probeEmbeddedPages(instance, requestId)) return;
    } catch (error) {
      if (requestId !== instance.requestId) return;
      reportedError = error && error.message ? error.message : 'MDM could not inspect this page.';
      const handled = await genericPageScanFallback(instance, requestId, reportedError);
      if (handled) return;
      if (await probeEmbeddedPages(instance, requestId)) return;
    } finally {
      if (requestId === instance.requestId) {
        instance.loading = false;
        if (!instance.formats.length) instance.error = reportedError || 'No downloadable qualities were found.';
        genericRender(instance);
      }
    }
  }

  function genericUpdate(instance, force) {
    const video = instance.video;
    const now = Date.now();
    if (!force && now - instance.lastCheck < 1500) return;
    instance.lastCheck = now;
    instance.titleText = genericTitle(video);
    const sources = genericCollectSources(video);
    const key = sources.map((source) => source.url).join('|');
    if (key !== instance.sourceKey) {
      instance.sourceKey = key;
      instance.sources = sources;
      instance.height = video.videoHeight || 0;
      instance.formats = [];
      instance.error = '';
      instance.loading = false;
      instance.pageOverride = '';
      instance.pageProbeAttempted = false;
      instance.requestId++;
      if (sources.length && sources.every((source) => !isManifestUrl(source.url))) {
        instance.formats = genericDirectFormats(video, sources);
      }
      genericRender(instance);
      if (sources.some((source) => isManifestUrl(source.url))) genericMaybeProbe(instance);
      else if (!instance.formats.length) genericMaybePageProbe(instance);
    } else if (!instance.formats.length && !instance.error && !instance.loading) {
      if (sources.some((source) => isManifestUrl(source.url))) genericMaybeProbe(instance);
      else genericMaybePageProbe(instance);
    } else if (key === instance.sourceKey && instance.formats.length && instance.height !== (video.videoHeight || 0)) {
      instance.height = video.videoHeight || 0;
      if (sources.every((source) => !isManifestUrl(source.url))) {
        instance.formats = genericDirectFormats(video, sources);
        genericRender(instance);
      }
    }
  }

  function genericMaybeProbe(instance) {
    // Prefetch even while the panel is closed: the quality list is ready the
    // moment the user opens it.
    refreshSniffedMedia();
    if (instance.probeTimer) return;
    instance.probeTimer = setTimeout(() => {
      instance.probeTimer = 0;
      if (!instance.formats.length && !instance.loading && !instance.error) void genericLoad(instance);
    }, instance.video.paused ? 400 : 150);
  }

  function genericMaybePageProbe(instance) {
    // Run the yt-dlp page fallback automatically (no panel needed), once per
    // player, shortly after the video is detected.
    if (instance.pageProbeAttempted || instance.probeTimer) return;
    refreshSniffedMedia();
    instance.pageProbeAttempted = true;
    instance.probeTimer = setTimeout(() => {
      instance.probeTimer = 0;
      if (!instance.formats.length && !instance.loading && !instance.error) void genericLoad(instance);
    }, 900);
  }

  function genericPosition(instance) {
    const { video, host } = instance;
    if (!video.isConnected || !genericEligible(video) || instance.panel.classList.contains('dragging')) {
      host.style.display = 'none';
      return;
    }
    const rect = video.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
      host.style.display = 'none';
      return;
    }
    const parent = overlayParent(video);
    if (host.parentElement !== parent) parent.appendChild(host);
    const { left, top } = placeOverlay(host, GENERIC_POSITION_KEY, rect);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    if (instance.panel.classList.contains('open')) orientPanel(instance);
  }

  function genericDestroy(instance) {
    if (instance.probeTimer) clearTimeout(instance.probeTimer);
    instance.requestId++;
    instance.host.remove();
    generic.instances.delete(instance.video);
  }

  function scheduleGenericScan() {
    if (generic.scanTimer) return;
    generic.scanTimer = setTimeout(() => {
      generic.scanTimer = 0;
      genericScan();
    }, 300);
  }

  function genericScan() {
    if (isDismissed(GENERIC_DISMISS_KEY)) {
      for (const instance of Array.from(generic.instances.values())) genericDestroy(instance);
      return;
    }
    const seen = new Set();
    for (const video of collectVideos()) {
      if (!(video instanceof HTMLVideoElement)) continue;
      seen.add(video);
      const instance = generic.instances.get(video);
      if (!genericEligible(video)) {
        if (instance) genericDestroy(instance);
        continue;
      }
      if (!instance) genericBuild(video);
      else {
        genericUpdate(instance);
        genericPosition(instance);
      }
    }
    for (const [video, instance] of generic.instances) {
      if (!seen.has(video) || !video.isConnected) genericDestroy(instance);
    }
  }

  function initGeneric() {
    if (globalThis.__mdmGenericOverlay) return;
    globalThis.__mdmGenericOverlay = true;
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME' ||
                  el.querySelector?.('video, iframe, source[src]')) {
                shouldScan = true;
                break;
              }
            }
          }
        } else if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
          const target = mutation.target;
          if (target instanceof HTMLVideoElement || target instanceof HTMLSourceElement ||
              target instanceof HTMLIFrameElement) {
            shouldScan = true;
            break;
          }
        }
        if (shouldScan) break;
      }
      if (shouldScan) scheduleGenericScan();
    });
    let positionFrame = 0;
    let ticks = 0;
    let idleTicks = 0;
    const positionAll = () => {
      if (positionFrame) return;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = 0;
        for (const instance of generic.instances.values()) genericPosition(instance);
      });
    };
    const start = () => {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      genericScan();
    };
    document.addEventListener('play', (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const instance = generic.instances.get(video);
      if (instance) {
        genericUpdate(instance, true);
        genericPosition(instance);
      } else {
        scheduleGenericScan();
      }
    }, true);
    document.addEventListener('loadedmetadata', (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const instance = generic.instances.get(video);
      if (instance) genericUpdate(instance, true);
      else scheduleGenericScan();
    }, true);
    window.addEventListener('scroll', positionAll, { capture: true, passive: true });
    window.addEventListener('resize', () => genericScan(), { passive: true });
    document.addEventListener('fullscreenchange', positionAll);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) genericScan();
    });
    setInterval(() => {
      if (document.hidden) return;
      // With nothing on screen, poll slowly for new players. Videos inside
      // shadow roots raise no light-DOM mutation and their media events do not
      // reach document listeners, so this poll is the only way to find them.
      if (generic.instances.size === 0) {
        if (++idleTicks % 4 === 0) genericScan();
        return;
      }
      for (const instance of generic.instances.values()) {
        genericUpdate(instance);
        genericPosition(instance);
      }
      if (++ticks % 3 === 0) genericScan();
    }, 1500);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  const youtubeSite = /(^|\.)(?:youtube\.com|youtube-nocookie\.com)$/i.test(location.hostname) || location.hostname === 'youtu.be';
  if (youtubeSite) {
    document.addEventListener('yt-navigate-finish', () => sync(false), true);
    document.addEventListener('yt-page-data-updated', () => sync(false), true);
    window.addEventListener('popstate', () => sync(false), true);
    window.addEventListener('resize', () => mount(), { passive: true });
    window.addEventListener('scroll', () => requestAnimationFrame(applyYouTubePosition), { passive: true, capture: true });
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(applyYouTubePosition));
    // Fallback poll at 5s; yt-navigate-finish and yt-page-data-updated handle navigation
    setInterval(() => {
      if (!document.hidden) sync(false);
    }, 5000);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => sync(false), { once: true });
    } else {
      sync(false);
    }
  } else {
    initGeneric();
  }
})();
