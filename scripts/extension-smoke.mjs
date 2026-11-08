/* global chrome */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const extensionPath = path.resolve('extension');
const manifest = JSON.parse(await fsp.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
assert.equal(typeof manifest.key, 'string', 'the Chrome manifest must pin the extension ID with a key');

function extensionIdFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

const pinnedExtensionId = extensionIdFromKey(manifest.key);
assert.match(pinnedExtensionId, /^[a-p]{32}$/);
const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-extension-'));
let context = null;
let bridge = null;
let bridgePort = 0;
const bridgeToken = 'extension-smoke-token';
let downloadRequest = null;
let probeRequest = null;

async function chromiumExecutable() {
  if (process.env.MDM_CHROME_PATH) return process.env.MDM_CHROME_PATH;
  const expected = chromium.executablePath();
  try {
    await fsp.access(expected);
    return expected;
  } catch {
    // Fall back to another local Chromium build when the installed browser revision differs.
  }
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const entries = await fsp.readdir(cache).catch(() => []);
  const candidates = entries
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]));
  for (const entry of candidates) {
    const candidate = path.join(cache, entry, 'chrome-win64', 'chrome.exe');
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // Check the next installed revision.
    }
  }
  throw new Error('No Playwright Chromium build was found. Run "npx playwright install chromium".');
}

async function startBridge() {
  bridge = http.createServer((request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-MDM-Extension',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'OPTIONS') {
      send(204, {});
      return;
    }
    if (request.url === '/pair') {
      const origin = String(request.headers.origin ?? '').toLowerCase();
      const workerId = String(request.headers['x-mdm-extension'] ?? '').toLowerCase();
      const pinnedOrigin = origin === `chrome-extension://${pinnedExtensionId}`;
      const pinnedWorker =
        !origin &&
        workerId === pinnedExtensionId &&
        request.headers['sec-fetch-site'] === 'none' &&
        request.headers['sec-fetch-mode'] === 'cors' &&
        request.headers['sec-fetch-dest'] === 'empty';
      if (!pinnedOrigin && !pinnedWorker) {
        send(403, { ok: false, error: 'Extension origin required.' });
        return;
      }
      send(200, { ok: true, data: { app: 'MDM', version: '2.6', token: bridgeToken } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
      send(401, { ok: false, error: 'Unauthorized' });
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (request.url === '/health') {
        send(200, { ok: true, data: { app: 'MDM', version: '2.6' } });
        return;
      }
      if (request.url === '/probe') {
        probeRequest = body;
        const probeUrl = String(body.url ?? '');
        if (probeUrl.includes('/silent/master.m3u8')) {
          send(200, {
            ok: true,
            data: {
              kind: 'http',
              title: 'Silent manifest',
              error: '',
              protected: false,
              formats: [],
              durationSeconds: null,
              suggestedFileName: 'Silent manifest'
            }
          });
          return;
        }
        const generic = probeUrl.includes('.m3u8');
        send(200, {
          ok: true,
          data: generic
            ? {
                kind: 'hls',
                title: 'Generic clip',
                error: '',
                protected: false,
                duration: 30,
                suggestedFileName: 'Generic clip.mp4',
                formats: [
                  {
                    id: 'hls:720',
                    type: 'hls',
                    label: '720p',
                    resolution: '1280x720',
                    mimeType: 'video/mp4',
                    bandwidth: 2200,
                    sizeBytes: 12_000_000,
                    language: '',
                    codecs: 'avc1.4d401f, mp4a.40.2',
                    protected: false
                  }
                ]
              }
            : {
                kind: 'youtube',
                title: 'Smoke video',
                error: '',
                protected: false,
                duration: 60,
                suggestedFileName: 'Smoke video.mp4',
                formats: [
                  {
                    id: 'youtube:1080:137+140-1',
                    type: 'youtube',
                    label: '1080p',
                    resolution: '1920x1080',
                    mimeType: 'video/mp4',
                    bandwidth: 4500,
                    sizeBytes: 52_000_000,
                    formatSelector: '137+140-1',
                    language: 'en',
                    codecs: 'avc1.640028, mp4a.40.2',
                    protected: false
                  },
                  {
                    id: 'youtube:audio:140-1',
                    type: 'youtube',
                    label: 'Audio M4A 128 kbps',
                    resolution: '',
                    mimeType: 'audio/mp4',
                    bandwidth: 128_000,
                    sizeBytes: 2_000_000,
                    formatSelector: '140-1',
                    language: 'en',
                    codecs: 'mp4a.40.2',
                    protected: false
                  }
                ]
              }
        });
        return;
      }
      if (request.url === '/download') {
        downloadRequest = body;
        send(200, {
          ok: true,
          data: body.confirmDownload ? { pending: true } : { id: 'smoke-download', status: 'queued' }
        });
        return;
      }
      send(404, { ok: false, error: 'Not found' });
    });
  });
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(0, '127.0.0.1', resolve);
  });
  bridgePort = bridge.address().port;
}

try {
  await startBridge();
  context = await chromium.launchPersistentContext(userData, {
    executablePath: await chromiumExecutable(),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/);
  assert.equal(extensionId, pinnedExtensionId, 'the loaded extension must keep the pinned ID');

  const config = await worker.evaluate(async () => globalThis.MDMExt.getConfig());
  assert.equal(config.port, 41731);
  assert.equal(config.autoCapture, true);

  await worker.evaluate(
    async ({ port }) => globalThis.MDMExt.saveConfig({ port, token: '' }),
    { port: bridgePort }
  );
  const paired = await worker.evaluate(async (port) => globalThis.MDMExt.connect(port), bridgePort);
  assert.equal(paired.port, bridgePort);
  assert.equal(paired.token, bridgeToken);
  const configured = await worker.evaluate(async () => globalThis.MDMExt.getConfig());
  assert.equal(configured.port, bridgePort);
  assert.equal(configured.token, bridgeToken);

  await worker.evaluate(async ({ port }) => globalThis.MDMExt.saveConfig({ port, token: '' }), { port: bridgePort });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForSelector('#settings-form');
  assert.equal(await page.locator('#port').inputValue(), String(bridgePort));
  assert.equal(await page.title(), 'MDM extension settings');
  assert.equal(await page.locator('#reveal-button').count(), 1);
  await page.waitForFunction(
    () => document.querySelector('#token')?.value?.length > 0,
    undefined,
    { timeout: 15_000 }
  );
  assert.equal(await page.locator('#token').inputValue(), bridgeToken);
  const autoPaired = await worker.evaluate(async () => globalThis.MDMExt.getConfig());
  assert.equal(autoPaired.token, bridgeToken);

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForSelector('.popup');
  await page.waitForFunction(
    () => document.querySelector('#bridge-address')?.textContent?.includes('127.0.0.1'),
    undefined,
    { timeout: 10_000 }
  );
  assert.match(await page.locator('#bridge-address').textContent(), /127\.0\.0\.1/);
  assert.equal(await page.locator('#auto-capture').isChecked(), true);
  assert.equal(await page.locator('#auto-capture-state').textContent(), 'On');
  assert.equal(await page.getByText('Media on this page').count(), 0);

  await page.locator('.capture-toggle .switch-track').click();
  await page.waitForFunction(
    () => document.querySelector('#auto-capture-state')?.textContent === 'Off',
    undefined,
    { timeout: 5000 }
  );
  let captureConfig = await worker.evaluate(async () => globalThis.MDMExt.getConfig());
  assert.equal(captureConfig.autoCapture, false);
  assert.equal(await page.locator('#auto-capture').isChecked(), false);

  await page.locator('.capture-toggle .switch-track').click();
  await page.waitForFunction(
    () => document.querySelector('#auto-capture-state')?.textContent === 'On',
    undefined,
    { timeout: 5000 }
  );
  captureConfig = await worker.evaluate(async () => globalThis.MDMExt.getConfig());
  assert.equal(captureConfig.autoCapture, true);
  assert.equal(await page.locator('#auto-capture').isChecked(), true);

  await context.route('https://www.youtube.com/watch?v=smoke', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Smoke video - YouTube</title></head><body>' +
        '<div id="movie_player" style="position:relative;width:800px;height:450px;background:#000">' +
        '<video width="800" height="450"></video></div></body></html>'
    })
  );
  await page.goto('https://www.youtube.com/watch?v=smoke');
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-mdm-overlay="youtube"]');
      return host?.shadowRoot?.querySelector('.badge')?.textContent === '2';
    },
    undefined,
    { timeout: 20_000 }
  );
  const overlay = await page.evaluate(() => {
    const host = document.querySelector('[data-mdm-overlay="youtube"]');
    const root = host?.shadowRoot;
    return {
      pill: root?.querySelector('.pill')?.textContent ?? '',
      icon: Boolean(root?.querySelector('.brand svg')),
      title: root?.querySelector('.video-title')?.textContent ?? '',
      formats: Array.from(root?.querySelectorAll('.format') ?? []).map((button) => button.textContent ?? '')
    };
  });
  assert.match(overlay.pill, /Download video with MDM/);
  assert.equal(overlay.icon, true);
  assert.equal(overlay.title, 'Smoke video');
  assert.equal(overlay.formats.length, 2);
  assert.match(overlay.formats[0], /1080p/);
  assert.match(overlay.formats[1], /Audio M4A/);
  assert.match(overlay.formats[1], /AUDIO/);

  const pill = page.locator('[data-mdm-overlay="youtube"] .pill');
  await pill.click();
  const menuDisplay = await page.evaluate(() => {
    const host = document.querySelector('[data-mdm-overlay="youtube"]');
    const menu = host?.shadowRoot?.querySelector('.menu');
    return menu ? getComputedStyle(menu).display : '';
  });
  assert.equal(menuDisplay, 'flex');

  await page.locator('[data-mdm-overlay="youtube"] .format').first().click();
  const deadline = Date.now() + 5000;
  while (!downloadRequest && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloadRequest?.mediaFormatId, 'youtube:1080:137+140-1');
  assert.equal(downloadRequest?.url, 'https://www.youtube.com/watch?v=smoke');
  assert.equal(downloadRequest?.confirmDownload, true);
  assert.equal(downloadRequest?.mediaTitle, 'Smoke video');
  assert.equal(downloadRequest?.mediaQuality, '1080p');

  downloadRequest = null;
  probeRequest = null;
  await context.route('https://media.example.test/watch', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Generic clip page</title></head><body style="margin:80px">' +
        '<video width="640" height="360" controls>' +
        '<source src="https://media.example.test/master.m3u8" type="application/vnd.apple.mpegurl">' +
        '</video></body></html>'
    })
  );
  await page.goto('https://media.example.test/watch');
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-mdm-overlay="video"]');
      return host?.shadowRoot?.querySelector('.badge')?.textContent === '1';
    },
    undefined,
    { timeout: 20_000 }
  );
  const genericOverlay = await page.evaluate(() => {
    const host = document.querySelector('[data-mdm-overlay="video"]');
    const root = host?.shadowRoot;
    return {
      title: root?.querySelector('.video-title')?.textContent ?? '',
      formats: Array.from(root?.querySelectorAll('.format') ?? []).map((button) => button.textContent ?? '')
    };
  });
  assert.equal(genericOverlay.title, 'Generic clip');
  assert.equal(genericOverlay.formats.length, 1);
  assert.match(genericOverlay.formats[0], /720p/);
  assert.match(String(probeRequest?.headers?.['User-Agent'] ?? ''), /Chrome\//);
  await page.locator('[data-mdm-overlay="video"] .pill').click();
  await page.locator('[data-mdm-overlay="video"] .format').first().click();
  const genericDeadline = Date.now() + 5000;
  while (!downloadRequest && Date.now() < genericDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloadRequest?.mediaFormatId, 'hls:720');
  assert.equal(downloadRequest?.url, 'https://media.example.test/master.m3u8');
  assert.equal(downloadRequest?.confirmDownload, true);
  assert.equal(downloadRequest?.mediaTitle, 'Generic clip');
  assert.equal(downloadRequest?.mediaQuality, '720p');

  const videoPill = page.locator('[data-mdm-overlay="video"] .pill');
  const box = await videoPill.boundingBox();
  assert.ok(box);
  const before = await page.evaluate(() => {
    const host = document.querySelector('[data-mdm-overlay="video"]');
    return { left: host?.style.left ?? '', top: host?.style.top ?? '' };
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(20, 20, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const host = document.querySelector('[data-mdm-overlay="video"]');
    return { left: host?.style.left ?? '', top: host?.style.top ?? '' };
  });
  const savedPosition = await page.evaluate(() => localStorage.getItem('mdm.overlay.video.position.v2'));
  assert.notDeepEqual(after, before);
  assert.ok(Number.parseFloat(after.left) < 80);
  assert.ok(Number.parseFloat(after.top) < 80);
  assert.ok(savedPosition);

  // A real pointer click, so pointer capture on the pill cannot retarget the
  // click and open the panel instead of closing the overlay.
  await page.locator('[data-mdm-overlay="video"] .close').click();
  await page.waitForFunction(() => !document.querySelector('[data-mdm-overlay="video"]'));
  await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url?.startsWith('https://media.example.test/watch'));
    await chrome.tabs.sendMessage(tab.id, { type: 'mdm-show-overlays' });
  });
  await page.waitForFunction(
    () => document.querySelector('[data-mdm-overlay="video"]')?.shadowRoot?.querySelector('.badge')?.textContent === '1',
    undefined,
    { timeout: 20_000 }
  );

  downloadRequest = null;
  await context.route('https://media.example.test/direct', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Direct clip page</title></head><body>' +
        '<video width="640" height="360" controls src="https://cdn.example.test/clip.mp4"></video>' +
        '</body></html>'
    })
  );
  await page.goto('https://media.example.test/direct');
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-mdm-overlay="video"]');
      return host?.shadowRoot?.querySelector('.badge')?.textContent === '1';
    },
    undefined,
    { timeout: 20_000 }
  );
  await page.locator('[data-mdm-overlay="video"] .pill').click();
  await page.locator('[data-mdm-overlay="video"] .format').first().click();
  const directDeadline = Date.now() + 5000;
  while (!downloadRequest && Date.now() < directDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloadRequest?.url, 'https://cdn.example.test/clip.mp4');
  assert.equal(downloadRequest?.mediaFormatId, undefined);
  assert.equal(downloadRequest?.confirmDownload, true);
  assert.ok(downloadRequest?.mediaQuality);
  assert.match(String(downloadRequest?.headers?.['User-Agent'] ?? ''), /Chrome\//);
  assert.ok(downloadRequest?.headers?.['Accept-Language']);

  downloadRequest = null;
  await context.route('https://player.example.test/embed', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Embedded player</title></head><body>' +
        '<video width="640" height="360" controls>' +
        '<source src="https://player.example.test/embed/master.m3u8" type="application/vnd.apple.mpegurl">' +
        '</video></body></html>'
    })
  );
  await context.route('https://media.example.test/iframe', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Iframe page</title></head><body>' +
        '<iframe src="https://player.example.test/embed" width="640" height="360" style="border:0"></iframe>' +
        '</body></html>'
    })
  );
  await page.goto('https://media.example.test/iframe');
  let embedFrame = null;
  const frameDeadline = Date.now() + 10_000;
  while (!embedFrame && Date.now() < frameDeadline) {
    embedFrame = page.frames().find((item) => item.url().startsWith('https://player.example.test/'));
    if (!embedFrame) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(embedFrame, 'cross-origin embed frame should load');
  await embedFrame.waitForFunction(
    () => document.querySelector('[data-mdm-overlay="video"]')?.shadowRoot?.querySelector('.badge')?.textContent === '1',
    undefined,
    { timeout: 20_000 }
  );
  await embedFrame.locator('[data-mdm-overlay="video"] .pill').click();
  await embedFrame.locator('[data-mdm-overlay="video"] .format').first().click();
  const iframeDeadline = Date.now() + 5000;
  while (!downloadRequest && Date.now() < iframeDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloadRequest?.url, 'https://player.example.test/embed/master.m3u8');
  assert.equal(downloadRequest?.mediaFormatId, 'hls:720');

  downloadRequest = null;
  await context.route('https://social.example.test/post', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Social post</title></head><body>' +
        '<video width="640" height="360" controls src="blob:https://social.example.test/00000000-0000-0000-0000-000000000000"></video>' +
        '</body></html>'
    })
  );
  await page.goto('https://social.example.test/post');
  await page.waitForFunction(
    () => document.querySelector('[data-mdm-overlay="video"]')?.shadowRoot?.querySelector('.badge')?.textContent === '...',
    undefined,
    { timeout: 20_000 }
  );
  await page.locator('[data-mdm-overlay="video"] .pill').click();
  await page.waitForFunction(
    () => document.querySelector('[data-mdm-overlay="video"]')?.shadowRoot?.querySelector('.badge')?.textContent === '2',
    undefined,
    { timeout: 20_000 }
  );
  await page.locator('[data-mdm-overlay="video"] .format').first().click();
  const pageDeadline = Date.now() + 5000;
  while (!downloadRequest && Date.now() < pageDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloadRequest?.url, 'https://social.example.test/post');
  assert.equal(downloadRequest?.mediaEngine, 'yt-dlp');
  assert.equal(downloadRequest?.mediaFormatId, 'youtube:1080:137+140-1');

  downloadRequest = null;
  await context.route('https://social.example.test/silent', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><title>Silent manifest</title></head><body>' +
        '<video width="640" height="360" controls>' +
        '<source src="https://social.example.test/silent/master.m3u8" type="application/vnd.apple.mpegurl">' +
        '</video></body></html>'
    })
  );
  await page.goto('https://social.example.test/silent');
  await page.waitForFunction(
    () => document.querySelector('[data-mdm-overlay="video"]')?.shadowRoot?.querySelector('.badge')?.textContent === '2',
    undefined,
    { timeout: 20_000 }
  );
  await page.locator('[data-mdm-overlay="video"] .pill').click();
  await page.locator('[data-mdm-overlay="video"] .format').first().click();
  const silentDeadline = Date.now() + 5000;
  while (!downloadRequest && Date.now() < silentDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloadRequest?.url, 'https://social.example.test/silent');
  assert.equal(downloadRequest?.mediaEngine, 'yt-dlp');
  assert.equal(downloadRequest?.mediaFormatId, 'youtube:1080:137+140-1');

  await worker.evaluate(async () => globalThis.MDMExt.saveConfig({ autoCapture: true }));
  downloadRequest = null;
  const downloadPage = await context.newPage();
  await context.route('https://files.example.test/source', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><a id="download" href="/sample.bin" download="sample.bin">Download</a></body></html>'
    })
  );
  await context.route('https://files.example.test/sample.bin', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="sample.bin"'
      },
      body: Buffer.from('mdm extension smoke')
    })
  );
  await downloadPage.goto('https://files.example.test/source');
  await downloadPage.locator('#download').click();
  const captureDeadline = Date.now() + 15_000;
  while (!downloadRequest && Date.now() < captureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(downloadRequest?.url, 'https://files.example.test/sample.bin');
  assert.equal(downloadRequest?.fileName, 'sample.bin');
  assert.equal(downloadRequest?.autoStart, true);
  await worker.evaluate(async () => globalThis.MDMExt.saveConfig({ autoCapture: false }));
  await downloadPage.close();

  console.log(
    JSON.stringify(
      {
        extensionId,
        serviceWorker: worker.url().split('/').pop(),
        defaultPort: config.port,
        optionsPage: 'loaded',
        popupPage: 'loaded',
        captureToggle: 'on-off-saved',
        browserDownloadCapture: 'routed-to-mdm',
        youtubeOverlay: 'probed-and-queued',
        genericOverlay: 'probed-queued-and-moved',
        genericDirect: 'queued',
        iframeOverlay: 'probed-and-queued',
        pageFallback: 'probed-and-queued',
        silentManifestFallback: 'page-probed-and-queued',
        bridgePort
      },
      null,
      2
    )
  );
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolve) => (bridge ? bridge.close(resolve) : resolve())).catch(() => undefined);
  await fsp.rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
