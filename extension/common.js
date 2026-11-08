(function () {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api) return;

  // Firefox gives every profile a random moz-extension:// UUID, so the desktop
  // app cannot verify which add-on is asking. Chrome and Edge report a stable
  // chrome-extension://<id> origin, which MDM pins to this extension.
  const autoPairSupported = !/^moz-extension:/i.test(api.runtime.getURL(''));

  // Pairing now opens a confirmation dialog in MDM, so the fetch must wait for
  // a person to read it instead of giving up after a few seconds.
  const PAIR_TIMEOUT_MS = 120_000;
  // A second request for the same prompt (for example the popup opening while
  // the background worker is already pairing) shares one fetch here, and when
  // another context owns the prompt it reuses the token that context stores.
  let pairingInFlight = null;
  const PAIR_JOIN_WAIT_MS = 30_000;
  const PAIR_JOIN_POLL_MS = 400;

  const PAGE_MEDIA_PATTERN = /\.(m3u8|m3u|mpd|mp4|m4v|mkv|webm|mov|flv|avi|ts|mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i;

  const DEFAULT_CONFIG = {
    port: 41731,
    token: '',
    autoCapture: true,
    notifications: true
  };

  function clampPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_CONFIG.port;
  }

  function cleanConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      port: clampPort(source.port),
      token: typeof source.token === 'string' ? source.token.trim() : '',
      autoCapture: source.autoCapture === undefined ? true : Boolean(source.autoCapture),
      notifications: source.notifications !== false
    };
  }

  async function getConfig() {
    try {
      const stored = await api.storage.local.get('config');
      return cleanConfig(stored?.config);
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async function saveConfig(patch) {
    const current = await getConfig();
    const next = cleanConfig({ ...current, ...patch });
    await api.storage.local.set({ config: next });
    return next;
  }

  async function connect(port, force) {
    const current = await getConfig();
    const target = clampPort(port ?? current.port);
    // Only join a pairing aimed at the same bridge: a startup attempt for the
    // default port must not swallow a request for a different one.
    if (pairingInFlight && pairingInFlight.port === target) return pairingInFlight.promise;
    const promise = pair(target, force).finally(() => {
      if (pairingInFlight?.promise === promise) pairingInFlight = null;
    });
    pairingInFlight = { port: target, promise };
    return promise;
  }

  async function waitForStoredToken() {
    const deadline = Date.now() + PAIR_JOIN_WAIT_MS;
    while (Date.now() < deadline) {
      const config = await getConfig();
      if (config.token) return config;
      await new Promise((resolve) => setTimeout(resolve, PAIR_JOIN_POLL_MS));
    }
    return null;
  }

  async function pair(port, force) {
    if (!autoPairSupported) {
      throw new Error(
        'Firefox cannot verify this add-on automatically. Copy the bridge token from MDM (Browser) and paste it into the token field.'
      );
    }
    const current = await getConfig();
    // The background worker or the popup may have paired while this call was queued.
    // A forced call (the stored token was rejected) still asks MDM for a new one.
    if (current.token && !force) return current;
    const target = clampPort(port ?? current.port);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${target}/pair`, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'X-MDM-Extension': api.runtime.id },
        signal: controller.signal
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'the pairing request timed out' : 'the bridge is not reachable';
      throw new Error(`Could not reach MDM on 127.0.0.1:${target} - ${reason}. Start MDM and try again.`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 409) {
      // An older MDM allows one prompt at a time. Wait for the context that owns
      // it to store the token instead of showing a failure for a prompt that is
      // already on screen.
      const paired = await waitForStoredToken();
      if (paired) return paired;
      throw new Error('A pairing prompt is waiting in MDM. Approve it there, then try again.');
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `MDM returned HTTP ${response.status}.`);
      if (payload?.data?.declined === true) error.code = 'pair-declined';
      throw error;
    }
    const token = typeof payload?.data?.token === 'string' ? payload.data.token.trim() : '';
    if (!token) throw new Error('MDM did not return a bridge token.');
    return saveConfig({ ...current, port: target, token });
  }

  async function ensureConnection() {
    const config = await getConfig();
    return config.token ? config : connect(config.port);
  }

  async function bridgeRequest(path, options, suppliedConfig, timeoutMs) {
    let config = suppliedConfig ?? (await getConfig());
    if (!config.token) config = await connect(config.port);
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 10_000);
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
          method: options?.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${config.token}`,
            ...(options?.body ? { 'Content-Type': 'application/json' } : {})
          },
          body: options?.body ? JSON.stringify(options.body) : undefined,
          cache: 'no-store',
          signal: controller.signal
        });
      } catch (error) {
        const reason = error?.name === 'AbortError' ? 'the request timed out' : 'the bridge is not reachable';
        throw new Error(`Could not reach MDM on 127.0.0.1:${config.port} - ${reason}. Start MDM and try again.`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401 && attempt === 0) {
        config = await connect(config.port, true);
        continue;
      }
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `MDM returned HTTP ${response.status}.`);
      }
      return payload?.data ?? payload;
    }
    throw new Error('MDM rejected the connection after pairing.');
  }

  async function testConnection(overrides) {
    const config = cleanConfig({ ...(await getConfig()), ...(overrides ?? {}) });
    const data = await bridgeRequest('/health', undefined, config);
    return {
      app: data?.app ?? 'MDM',
      version: data?.version ?? '',
      message: `Connected to ${data?.app ?? 'MDM'}${data?.version ? ` ${data.version}` : ''}.`
    };
  }

  async function cookiesFor(url) {
    try {
      const cookies = await api.cookies.getAll({ url });
      return cookies
        .filter((cookie) => cookie && cookie.name && cookie.value !== undefined)
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ')
        .slice(0, 16_000);
    } catch {
      return '';
    }
  }

  function fileNameFromUrl(raw) {
    try {
      const url = new URL(raw);
      const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
      const name = decodeURIComponent(segment).slice(0, 200);
      return /\.[a-z0-9]{2,10}$/i.test(name) ? name : undefined;
    } catch {
      return undefined;
    }
  }

  function pageUrl(tab, override) {
    for (const candidate of [override, tab?.url]) {
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
    }
    return '';
  }

  function browserHeaders() {
    const headers = {};
    try {
      const userAgent = String(navigator.userAgent || '').trim();
      if (userAgent) headers['User-Agent'] = userAgent.slice(0, 1024);
      const languages = Array.isArray(navigator.languages) ? navigator.languages.join(',') : navigator.language;
      if (languages) headers['Accept-Language'] = String(languages).slice(0, 512);
    } catch {
      /* Headers are optional. */
    }
    return headers;
  }

  async function notify(title, message) {
    const config = await getConfig();
    if (!config.notifications) return;
    try {
      await api.notifications.create({
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon128.png'),
        title: title.slice(0, 90),
        message: String(message ?? '').slice(0, 260)
      });
    } catch {
      /* Notifications are optional. */
    }
  }

  async function capture(url, tab, options) {
    if (typeof url !== 'string' || !/^(https?|ftp):\/\//i.test(url)) {
      throw new Error('Only HTTP, HTTPS, and FTP links can be sent to MDM.');
    }
    const config = await getConfig();
    const page = pageUrl(tab, options?.pageUrl);
    const payload = {
      url,
      fileName: options?.fileName || fileNameFromUrl(url),
      headers: browserHeaders(),
      cookies: await cookiesFor(url),
      referrer: page,
      sourcePageUrl: page,
      confirmDownload: true,
      autoStart: true
    };
    const result = await bridgeRequest('/download', { method: 'POST', body: payload }, config);
    if (result?.ignored) {
      await notify('Download ignored', `A site rule (${result?.rule?.name ?? 'MDM'}) ignored this download.`);
    } else if (result?.held) {
      await notify('Download waiting for review', 'Open MDM to review the paused download.');
    } else if (result?.pending) {
      await notify('Confirm in MDM', 'Choose the download location and start the download in MDM.');
    }
    return result;
  }

  async function probeYouTube(tab, pageOverride) {
    const page = pageUrl(tab, pageOverride);
    if (!page) throw new Error('Open a YouTube video page first.');
    if (!/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\//i.test(page)) {
      throw new Error('Open a YouTube video page first.');
    }
    const config = await getConfig();
    const result = await bridgeRequest(
      '/probe',
      {
        method: 'POST',
        body: {
          url: page,
          cookies: await cookiesFor(page),
          referrer: page,
          sourcePageUrl: page
        }
      },
      config,
      75_000
    );
    if (!result || !Array.isArray(result.formats)) throw new Error('MDM could not read this YouTube video.');
    return result;
  }

  async function downloadYouTube(tab, formatId, details, pageOverride) {
    if (typeof formatId !== 'string' || !formatId) throw new Error('Choose a YouTube quality first.');
    const page = pageUrl(tab, pageOverride);
    if (!page) throw new Error('Open a YouTube video page first.');
    const config = await getConfig();
    const result = await bridgeRequest(
      '/download',
      {
        method: 'POST',
        body: {
          url: page,
          cookies: await cookiesFor(page),
          referrer: page,
          sourcePageUrl: page,
          mediaFormatId: formatId,
          mediaTitle: details?.title || '',
          mediaQuality: details?.quality || '',
          confirmDownload: true,
          autoStart: true
        }
      },
      config,
      75_000
    );
    if (result?.ignored) {
      await notify('Download ignored', `A site rule (${result.rule?.name ?? 'MDM'}) ignored this download.`);
    } else if (result?.held) {
      await notify('Download waiting for review', 'Open MDM to review the paused download.');
    } else if (result?.pending) {
      await notify('Confirm in MDM', 'Choose the download location and start the download in MDM.');
    } else {
      await notify('Sent to MDM', 'The YouTube download was added to your queue.');
    }
    return result;
  }

  function isManifestUrl(value) {
    if (!value) return false;
    return (
      /\.(?:m3u8|m3u|mpd)(?:$|[?#])/i.test(value) ||
      /\/master\.txt(?:$|[?#])/i.test(value) ||
      /\.urlset(?:\/|$)/i.test(value)
    );
  }

  function isYouTubePage(value) {
    try {
      const url = new URL(value);
      return /(^|\.)(?:youtube\.com|youtube-nocookie\.com)$/i.test(url.hostname) || url.hostname === 'youtu.be';
    } catch {
      return false;
    }
  }

  function bestFormat(formats) {
    return (Array.isArray(formats) ? formats : []).find((format) => format && !format.protected) ?? null;
  }

  async function probeMedia(tab, url, pageOverride) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('This video source is not a downloadable HTTP media URL.');
    }
    const page = pageUrl(tab, pageOverride);
    const config = await getConfig();
    const result = await bridgeRequest(
      '/probe',
      {
        method: 'POST',
        body: {
          url,
          headers: browserHeaders(),
          cookies: await cookiesFor(url),
          referrer: page,
          sourcePageUrl: page
        }
      },
      config,
      60_000
    );
    if (!result || !Array.isArray(result.formats)) throw new Error('MDM could not inspect this video source.');
    return result;
  }

  async function downloadMedia(tab, url, formatId, details, pageOverride) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('This video source is not a downloadable HTTP media URL.');
    }
    const page = pageUrl(tab, pageOverride);
    const config = await getConfig();
    const result = await bridgeRequest(
      '/download',
      {
        method: 'POST',
        body: {
          url,
          headers: browserHeaders(),
          cookies: await cookiesFor(url),
          referrer: page,
          sourcePageUrl: page,
          mediaFormatId: formatId || undefined,
          mediaTitle: details?.title || '',
          mediaQuality: details?.quality || '',
          confirmDownload: true,
          autoStart: true
        }
      },
      config,
      75_000
    );
    if (result?.ignored) {
      await notify('Download ignored', `A site rule (${result.rule?.name ?? 'MDM'}) ignored this download.`);
    } else if (result?.held) {
      await notify('Download waiting for review', 'Open MDM to review the paused download.');
    } else if (result?.pending) {
      await notify('Confirm in MDM', 'Choose the download location and start the download in MDM.');
    } else {
      await notify('Sent to MDM', 'The video download was added to your queue.');
    }
    return result;
  }

  async function probePage(tab, pageOverride) {
    const page = pageUrl(tab, pageOverride);
    if (!page) throw new Error('Open a supported video page first.');
    const config = await getConfig();
    const result = await bridgeRequest(
      '/probe',
      {
        method: 'POST',
        body: {
          url: page,
          headers: browserHeaders(),
          cookies: await cookiesFor(page),
          referrer: page,
          sourcePageUrl: page,
          mediaEngine: 'yt-dlp'
        }
      },
      config,
      90_000
    );
    if (!result || !Array.isArray(result.formats)) throw new Error('MDM could not read this video page.');
    return result;
  }

  async function downloadPage(tab, formatId, details, pageOverride) {
    if (typeof formatId !== 'string' || !formatId) throw new Error('Choose a video quality first.');
    const page = pageUrl(tab, pageOverride);
    if (!page) throw new Error('Open a supported video page first.');
    const config = await getConfig();
    const result = await bridgeRequest(
      '/download',
      {
        method: 'POST',
        body: {
          url: page,
          headers: browserHeaders(),
          cookies: await cookiesFor(page),
          referrer: page,
          sourcePageUrl: page,
          mediaFormatId: formatId,
          mediaEngine: 'yt-dlp',
          mediaTitle: details?.title || '',
          mediaQuality: details?.quality || '',
          confirmDownload: true,
          autoStart: true
        }
      },
      config,
      90_000
    );
    if (result?.ignored) {
      await notify('Download ignored', `A site rule (${result.rule?.name ?? 'MDM'}) ignored this download.`);
    } else if (result?.held) {
      await notify('Download waiting for review', 'Open MDM to review the paused download.');
    } else if (result?.pending) {
      await notify('Confirm in MDM', 'Choose the download location and start the download in MDM.');
    } else {
      await notify('Sent to MDM', 'The video download was added to your queue.');
    }
    return result;
  }

  async function pageCandidates(tab) {
    if (!tab?.id) return [];
    try {
      const response = await api.tabs.sendMessage(tab.id, { type: 'mdm-page-candidates' });
      return Array.isArray(response?.candidates) ? response.candidates : [];
    } catch {
      return [];
    }
  }

  async function downloadBestCandidate(tab, page) {
    const candidates = await pageCandidates(tab);
    for (const candidate of candidates.filter((url) => isManifestUrl(url))) {
      try {
        const probe = await probeMedia(tab, candidate, page);
        const format = bestFormat(probe.formats);
        if (format) return downloadMedia(tab, candidate, format.id, { title: probe.title, quality: format.label }, page);
      } catch {
        /* Try the next candidate. */
      }
    }
    const direct = candidates.find((url) => !isManifestUrl(url));
    if (direct) return downloadMedia(tab, direct, '', { title: '', quality: '' }, page);
    throw new Error('No downloadable video was found on this page.');
  }

  async function downloadBestMedia(tab, url, pageOverride) {
    const page = pageUrl(tab, pageOverride);
    if (isYouTubePage(page)) {
      const probe = await probeYouTube(tab, page);
      const format = bestFormat(probe.formats);
      if (!format) throw new Error(probe.error || 'No downloadable qualities were found.');
      return downloadYouTube(tab, format.id, { title: probe.title, quality: format.label }, page);
    }
    if (!/^https?:\/\//i.test(url)) {
      try {
        const probe = await probePage(tab, page);
        const format = bestFormat(probe.formats);
        if (!format) throw new Error(probe.error || 'No downloadable qualities were found.');
        return downloadPage(tab, format.id, { title: probe.title, quality: format.label }, page);
      } catch (error) {
        // The site is not supported by yt-dlp (or extraction failed) — fall
        // back to media found on the page itself.
        try {
          return await downloadBestCandidate(tab, page);
        } catch (candidateError) {
          if (candidateError?.message === 'No downloadable video was found on this page.') throw error;
          throw candidateError;
        }
      }
    }
    let formatId = '';
    let title = '';
    let quality = '';
    if (isManifestUrl(url)) {
      const probe = await probeMedia(tab, url, page);
      const format = bestFormat(probe.formats);
      if (!format) throw new Error(probe.error || 'No downloadable qualities were found.');
      formatId = format.id;
      title = probe.title;
      quality = format.label;
    }
    return downloadMedia(tab, url, formatId, { title, quality }, page);
  }

  async function activeTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ?? null;
  }

  function collectPageMedia() {
    const results = [];
    const seen = new Set();
    const mediaPattern = PAGE_MEDIA_PATTERN;
    const add = (value, type) => {
      if (!value) return;
      try {
        const url = new URL(value, location.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        if (seen.has(url.href)) return;
        seen.add(url.href);
        const label = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
        results.push({ url: url.href, type, label: label.slice(0, 120) });
      } catch {
        /* Ignore malformed URLs. */
      }
    };
    document.querySelectorAll('video, audio').forEach((element) => {
      add(element.currentSrc || element.src, element.tagName.toLowerCase());
    });
    document.querySelectorAll('source[src]').forEach((element) => {
      add(element.src, 'media');
    });
    document.querySelectorAll('a[href]').forEach((element) => {
      if (mediaPattern.test(element.href)) add(element.href, 'link');
    });
    return results.slice(0, 40);
  }

  async function scanTab(tab) {
    if (!tab?.id) throw new Error('Open a normal web page before scanning.');
    const injected = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPageMedia
    });
    return Array.isArray(injected?.[0]?.result) ? injected[0].result : [];
  }

  globalThis.MDMExt = {
    api,
    defaults: DEFAULT_CONFIG,
    canAutoPair: autoPairSupported,
    getConfig,
    saveConfig,
    connect,
    ensureConnection,
    testConnection,
    capture,
    probeYouTube,
    downloadYouTube,
    probeMedia,
    downloadMedia,
    probePage,
    downloadPage,
    downloadBestMedia,
    notify,
    activeTab,
    scanTab,
    pageUrl
  };
})();
