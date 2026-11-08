import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserBridge, type BrowserPairingConfirmation } from '../src/main/bridge';
import type { AppLogger } from '../src/main/logger';
import type { DownloadManager } from '../src/main/manager';
import { CHROMIUM_EXTENSION_ID, CHROMIUM_EXTENSION_ORIGIN } from '../src/shared/extension';
import type { AddDownloadResult, SiteRule } from '../src/shared/types';

const TOKEN = 'test-bridge-token';
const bridges: BrowserBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

function rule(overrides: Partial<SiteRule> = {}): SiteRule {
  return {
    id: 'rule-1',
    name: 'Fixture rule',
    pattern: '*.example.com',
    action: 'auto',
    fileTypes: [],
    destinationDir: '',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

interface Harness {
  bridge: BrowserBridge;
  addDownload: ReturnType<typeof vi.fn>;
  confirmDownload: ReturnType<typeof vi.fn>;
  confirmPairing: ReturnType<typeof vi.fn>;
  onQueued: ReturnType<typeof vi.fn>;
  logger: AppLogger;
  setRule: (next: SiteRule | null) => void;
}

async function harness(
  addDownloadImpl: () => Promise<AddDownloadResult> = async () => ({ id: 'download-1' } satisfies AddDownloadResult),
  pairApprove: (confirmation: BrowserPairingConfirmation) => Promise<boolean> = async () => true
): Promise<Harness> {
  const addDownload = vi.fn(addDownloadImpl);
  const confirmDownload = vi.fn();
  const confirmPairing = vi.fn(pairApprove);
  const onQueued = vi.fn();
  let activeRule: SiteRule | null = null;
  const manager = {
    addDownload,
    resolveSiteRule: vi.fn(() => activeRule),
    encodeQueueForBridge: () => ({
      queues: [
        { id: 'default', name: 'Default', status: 'active' },
        { id: 'work', name: 'Work', status: 'paused' }
      ]
    })
  } as unknown as DownloadManager;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as AppLogger;
  const bridge = new BrowserBridge(manager, logger, confirmDownload, onQueued, confirmPairing);
  bridges.push(bridge);
  await bridge.apply({ enabled: true, port: 0, token: TOKEN });
  expect(bridge.listening).toBe(true);
  expect(bridge.port).toBeGreaterThan(0);
  return { bridge, addDownload, confirmDownload, confirmPairing, onQueued, logger, setRule: (next) => (activeRule = next) };
}

interface BridgeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  bridge: BrowserBridge,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    contentType?: string;
    headers?: http.OutgoingHttpHeaders;
  } = {}
): Promise<BridgeResponse> {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers: http.OutgoingHttpHeaders = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port: bridge.port, path, method: options.method ?? 'GET', headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    outgoing.on('error', reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

describe('browser bridge', () => {
  it('requires the bearer token but allows CORS preflight', async () => {
    const { bridge } = await harness();
    const unauthorized = await request(bridge, '/health');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain('Bearer');

    const authorized = await request(bridge, '/health', { token: TOKEN });
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body)).toMatchObject({
      ok: true,
      data: { app: 'MDM - Mohamed Download Manager', ready: true }
    });

    const preflight = await request(bridge, '/download', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
  });

  it('rejects requests addressed to a hostname other than loopback (DNS rebinding)', async () => {
    const { bridge } = await harness();
    const rebound = await request(bridge, '/health', {
      token: TOKEN,
      headers: { Host: `attacker.example:${bridge.port}` }
    });
    expect(rebound.status).toBe(403);

    const preflight = await request(bridge, '/download', {
      method: 'OPTIONS',
      headers: { Host: `attacker.example:${bridge.port}` }
    });
    expect(preflight.status).toBe(403);

    const localhost = await request(bridge, '/health', {
      token: TOKEN,
      headers: { Host: `localhost:${bridge.port}` }
    });
    expect(localhost.status).toBe(200);
  });

  it('hands the token only to the pinned extension after confirmation', async () => {
    const { bridge, confirmPairing } = await harness();
    const denied = await request(bridge, '/pair');
    expect(denied.status).toBe(403);

    const website = await request(bridge, '/pair', { headers: { Origin: 'https://example.com' } });
    expect(website.status).toBe(403);

    const otherChromeExtension = await request(bridge, '/pair', {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }
    });
    expect(otherChromeExtension.status).toBe(403);

    // Firefox origins contain a per-profile UUID, so they cannot be pinned.
    // Firefox users paste the token shown in MDM instead of pairing silently.
    const firefox = await request(bridge, '/pair', {
      headers: { Origin: 'moz-extension://12345678-1234-1234-1234-123456789abc' }
    });
    expect(firefox.status).toBe(403);

    // Chrome extension workers omit Origin, so they identify themselves with
    // the pinned ID and the Fetch Metadata of an extension fetch.
    const worker = await request(bridge, '/pair', {
      headers: {
        'X-MDM-Extension': CHROMIUM_EXTENSION_ID,
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
      }
    });
    expect(worker.status).toBe(200);

    const unmarkedWorker = await request(bridge, '/pair', {
      headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }
    });
    expect(unmarkedWorker.status).toBe(403);

    const wrongWorker = await request(bridge, '/pair', {
      headers: {
        'X-MDM-Extension': 'abcdefghijklmnopabcdefghijklmnop',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
      }
    });
    expect(wrongWorker.status).toBe(403);

    // A page can attach the header but keeps its own Origin and cross-site
    // Fetch Metadata, so it still cannot pair.
    const pageWithHeader = await request(bridge, '/pair', {
      headers: {
        Origin: 'https://example.com',
        'X-MDM-Extension': CHROMIUM_EXTENSION_ID,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
      }
    });
    expect(pageWithHeader.status).toBe(403);

    const pinned = await request(bridge, '/pair', {
      headers: { Origin: CHROMIUM_EXTENSION_ORIGIN.toUpperCase() }
    });
    expect(pinned.status).toBe(200);
    expect(JSON.parse(pinned.body)).toMatchObject({
      ok: true,
      data: { token: TOKEN }
    });
    expect(CHROMIUM_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(confirmPairing).toHaveBeenCalledTimes(2);
    expect(confirmPairing).toHaveBeenNthCalledWith(1, { extensionId: CHROMIUM_EXTENSION_ID, origin: '' });
    expect(confirmPairing).toHaveBeenNthCalledWith(2, {
      extensionId: CHROMIUM_EXTENSION_ID,
      origin: CHROMIUM_EXTENSION_ORIGIN
    });
  });

  it('does not hand out the token when pairing is denied', async () => {
    const { bridge, confirmPairing } = await harness(undefined, async () => false);
    const denied = await request(bridge, '/pair', {
      headers: {
        'X-MDM-Extension': CHROMIUM_EXTENSION_ID,
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
      }
    });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({
      ok: false,
      error: 'Pairing was declined in MDM.',
      data: { declined: true }
    });
    expect(denied.body).not.toContain(TOKEN);
    expect(confirmPairing).toHaveBeenCalledTimes(1);
  });

  it('lets a concurrent request join the prompt already on screen, and asks again for the next pairing', async () => {
    let approveFirst!: (approved: boolean) => void;
    const { bridge, confirmPairing, logger } = await harness(
      undefined,
      () =>
        new Promise<boolean>((resolve) => {
          approveFirst = resolve;
        })
    );
    const headers = {
      'X-MDM-Extension': CHROMIUM_EXTENSION_ID,
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    };
    const first = request(bridge, '/pair', { headers });
    await vi.waitFor(() => expect(confirmPairing).toHaveBeenCalledTimes(1));

    // The background worker and the popup can ask at once: both wait on one
    // prompt and both receive the token, instead of one failing with an error.
    const concurrent = request(bridge, '/pair', { headers });
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        'bridge',
        'Browser extension pairing joined the prompt already waiting for confirmation.'
      )
    );
    expect(confirmPairing).toHaveBeenCalledTimes(1);

    approveFirst(true);
    const firstResponse = await first;
    const concurrentResponse = await concurrent;
    expect(firstResponse.status).toBe(200);
    expect(concurrentResponse.status).toBe(200);
    expect(JSON.parse(firstResponse.body)).toMatchObject({ ok: true, data: { token: TOKEN } });
    expect(JSON.parse(concurrentResponse.body)).toMatchObject({ ok: true, data: { token: TOKEN } });
    expect(confirmPairing).toHaveBeenCalledTimes(1);

    // The earlier approval is not cached: the next request needs a new prompt.
    const later = request(bridge, '/pair', { headers });
    await vi.waitFor(() => expect(confirmPairing).toHaveBeenCalledTimes(2));
    approveFirst(true);
    const laterResponse = await later;
    expect(laterResponse.status).toBe(200);
    expect(JSON.parse(laterResponse.body)).toMatchObject({ ok: true, data: { token: TOKEN } });
  });

  it('rate-limits pairing prompts separately from normal bridge traffic', async () => {
    const { bridge, confirmPairing } = await harness();
    const headers = { Origin: CHROMIUM_EXTENSION_ORIGIN };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(bridge, '/pair', { headers });
      expect(response.status).toBe(200);
    }
    const limited = await request(bridge, '/pair', { headers });
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body).error).toMatch(/too many pairing attempts/i);
    expect(confirmPairing).toHaveBeenCalledTimes(5);

    // Normal traffic is unaffected by the pairing budget.
    const health = await request(bridge, '/health', { token: TOKEN });
    expect(health.status).toBe(200);
  });

  it('lists queues for the authenticated extension', async () => {
    const { bridge } = await harness();
    const response = await request(bridge, '/queues', { token: TOKEN });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).data).toEqual([
      { id: 'default', name: 'Default', active: true },
      { id: 'work', name: 'Work', active: false }
    ]);
  });

  it('ignores captures matched by an ignore rule', async () => {
    const { bridge, addDownload, onQueued, setRule } = await harness();
    setRule(rule({ action: 'ignore' }));
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: { url: 'https://cdn.example.com/file.zip', sourcePageUrl: 'https://example.com/page' }
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      data: { ignored: true, rule: { id: 'rule-1', name: 'Fixture rule' } }
    });
    expect(addDownload).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('holds ask-rule downloads and applies the rule destination', async () => {
    const { bridge, addDownload, onQueued, setRule } = await harness();
    setRule(rule({ action: 'ask', destinationDir: 'D:\\Incoming' }));
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: {
        url: 'https://cdn.example.com/file.zip',
        sourcePageUrl: 'https://example.com/page',
        fileName: 'file.zip',
        headers: { Referer: 'https://example.com/page' },
        autoStart: true
      }
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, data: { id: 'download-1', held: true } });
    expect(addDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://cdn.example.com/file.zip',
        destinationDir: 'D:\\Incoming',
        fileName: 'file.zip',
        startNow: false
      })
    );
    expect(onQueued).toHaveBeenCalledWith({ id: 'download-1', held: true });
  });

  it('forwards browser request headers with the download', async () => {
    const { bridge, addDownload } = await harness();
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: {
        url: 'https://cdn.example.com/clip.mp4',
        sourcePageUrl: 'https://example.com/watch',
        headers
      }
    });
    expect(response.status).toBe(200);
    expect(addDownload).toHaveBeenCalledWith(expect.objectContaining({ headers }));
  });

  it('keeps browser headers when a download waits for confirmation', async () => {
    const { bridge, addDownload, confirmDownload, setRule } = await harness();
    setRule(rule({ action: 'auto', destinationDir: 'D:\\Incoming' }));
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: {
        url: 'https://fs-529368.vincdn.net/stream/fixture/token/1792761405',
        sourcePageUrl: 'https://vinovo.to/e/fixture',
        headers,
        confirmDownload: true
      }
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, data: { pending: true } });
    expect(addDownload).not.toHaveBeenCalled();
    expect(confirmDownload).toHaveBeenCalledWith({
      request: expect.objectContaining({
        url: 'https://fs-529368.vincdn.net/stream/fixture/token/1792761405',
        headers,
        confirmDownload: true
      }),
      destinationDir: 'D:\\Incoming'
    });
  });

  it('holds video downloads for confirmation without creating a record', async () => {
    const { bridge, addDownload, confirmDownload, onQueued, setRule } = await harness();
    setRule(rule({ action: 'auto', destinationDir: 'D:\\Incoming' }));
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: {
        url: 'https://www.youtube.com/watch?v=test',
        sourcePageUrl: 'https://www.youtube.com/watch?v=test',
        mediaFormatId: 'youtube:1080:137+140-1',
        mediaTitle: 'Test video',
        mediaQuality: '1080p',
        confirmDownload: true
      }
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, data: { pending: true } });
    expect(addDownload).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
    expect(confirmDownload).toHaveBeenCalledWith({
      request: expect.objectContaining({
        url: 'https://www.youtube.com/watch?v=test',
        mediaFormatId: 'youtube:1080:137+140-1',
        mediaTitle: 'Test video',
        mediaQuality: '1080p',
        confirmDownload: true
      }),
      destinationDir: 'D:\\Incoming'
    });
  });

  it('accepts normal captures without a matching rule', async () => {
    const { bridge, addDownload, onQueued } = await harness();
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: {
        url: 'https://cdn.example.com/file.zip',
        sourcePageUrl: 'https://example.com/page',
        fileName: 'file.zip',
        autoStart: true
      }
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, data: { id: 'download-1', held: false } });
    expect(addDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationDir: undefined,
        startNow: true
      })
    );
    expect(onQueued).toHaveBeenCalledWith({ id: 'download-1', held: false });
  });

  it('returns the safe engine reason when a start request is rejected', async () => {
    const { bridge, onQueued } = await harness(async () => {
      throw new Error('The download folder could not be created: Access denied.');
    });
    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: { url: 'https://cdn.example.com/file.zip', autoStart: true }
    });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: 'The download folder could not be created: Access denied.'
    });
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('coalesces concurrent bridge retries for the same download', async () => {
    let resolveAdd!: (value: AddDownloadResult) => void;
    const addDownload = vi.fn(
      () =>
        new Promise<AddDownloadResult>((resolve) => {
          resolveAdd = resolve;
        })
    );
    const { bridge, onQueued } = await harness(addDownload);
    const body = {
      url: 'https://cdn.example.com/file.zip',
      sourcePageUrl: 'https://example.com/page',
      autoStart: true
    };
    const first = request(bridge, '/download', { method: 'POST', token: TOKEN, body });
    await vi.waitFor(() => expect(addDownload).toHaveBeenCalledTimes(1));
    const second = request(bridge, '/download', { method: 'POST', token: TOKEN, body });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(addDownload).toHaveBeenCalledTimes(1);
    resolveAdd({ id: 'download-1' });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(JSON.parse(firstResponse.body)).toMatchObject({ ok: true, data: { id: 'download-1' } });
    expect(JSON.parse(secondResponse.body)).toMatchObject({
      ok: true,
      data: { id: 'download-1', duplicateOf: 'download-1' }
    });
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit yt-dlp media engine and forwards it to the manager', async () => {
    const { bridge, addDownload } = await harness();
    const rejected = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: { url: 'https://instagram.com/p/fixture', mediaEngine: 'ffmpeg' }
    });
    expect(rejected.status).toBe(400);
    expect(addDownload).not.toHaveBeenCalled();

    const response = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: {
        url: 'https://instagram.com/p/fixture',
        sourcePageUrl: 'https://instagram.com/p/fixture',
        mediaFormatId: 'youtube:1080:137+140-1',
        mediaEngine: 'yt-dlp',
        confirmDownload: true
      }
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, data: { pending: true } });
    expect(addDownload).not.toHaveBeenCalled();
  });

  it('passes yt-dlp page probes to the manager probe', async () => {
    const probeMedia = vi.fn(async () => ({
      kind: 'youtube',
      title: 'Page video',
      formats: [{ id: 'youtube:720:1', type: 'youtube' }],
      durationSeconds: 10,
      protected: false,
      error: '',
      suggestedFileName: 'Page video.mp4'
    }));
    const manager = {
      addDownload: vi.fn(),
      resolveSiteRule: vi.fn(() => null),
      encodeQueueForBridge: () => ({ queues: [] }),
      probeMedia
    } as unknown as DownloadManager;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;
    const bridge = new BrowserBridge(manager, logger, vi.fn(), vi.fn());
    bridges.push(bridge);
    await bridge.apply({ enabled: true, port: 0, token: TOKEN });
    const response = await request(bridge, '/probe', {
      method: 'POST',
      token: TOKEN,
      body: { url: 'https://instagram.com/p/fixture', sourcePageUrl: 'https://instagram.com/p/fixture', mediaEngine: 'yt-dlp' }
    });
    expect(response.status).toBe(200);
    expect(probeMedia).toHaveBeenCalledWith(
      'https://instagram.com/p/fixture',
      undefined,
      undefined,
      '',
      'yt-dlp'
    );
  });

  it('rejects malformed requests and non-JSON content types', async () => {
    const { bridge, addDownload } = await harness();
    const badUrl = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: { url: 'file:///C:/secret.txt' }
    });
    expect(badUrl.status).toBe(400);

    const wrongType = await request(bridge, '/download', {
      method: 'POST',
      token: TOKEN,
      body: { url: 'https://example.com/file.zip' },
      contentType: 'text/plain'
    });
    expect(wrongType.status).toBe(415);
    expect(addDownload).not.toHaveBeenCalled();
  });
});
