import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DownloadManager } from './manager';
import type { AppLogger } from './logger';
import type {
  AddDownloadResult,
  BrowserBridgeRequest,
  BrowserDownloadConfirmation,
  IpcResult,
  MediaProbeResult
} from '../shared/types';
import { APP_NAME, APP_VERSION } from '../shared/defaults';
import { CHROMIUM_EXTENSION_ID, CHROMIUM_EXTENSION_ORIGIN } from '../shared/extension';
import { isReasonableUrlLength } from '../shared/validation';

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
// Pairing opens a modal prompt, so it gets a much smaller budget than normal
// bridge traffic. The limit is per bridge instance and per loopback peer.
const PAIR_RATE_LIMIT_WINDOW_MS = 60_000;
const PAIR_RATE_LIMIT_MAX = 5;

interface BridgeSettings {
  enabled: boolean;
  port: number;
  token: string;
}

interface RateEntry {
  startedAt: number;
  count: number;
}

export interface BrowserPairingConfirmation {
  extensionId: string;
  origin: string;
}

export type BrowserPairingHandler = (confirmation: BrowserPairingConfirmation) => Promise<boolean>;

export class BrowserBridge {
  private server: http.Server | null = null;
  private settings: BridgeSettings = { enabled: false, port: 0, token: '' };
  private readonly rates = new Map<string, RateEntry>();
  private readonly pairRates = new Map<string, RateEntry>();
  private readonly pendingDownloads = new Map<string, Promise<AddDownloadResult>>();
  private operation: Promise<void> = Promise.resolve();
  /**
   * The pairing decision currently on screen, if any. A second request from the
   * same extension joins it instead of failing: the background worker and the
   * popup often ask at the same moment, and both need the token from one prompt.
   * Approvals are still never cached — once this settles, the next request asks
   * again.
   */
  private pairingPrompt: Promise<boolean> | null = null;
  private lastError = '';

  constructor(
    private readonly manager: DownloadManager,
    private readonly logger: AppLogger,
    private readonly confirmDownload?: (confirmation: BrowserDownloadConfirmation) => void,
    private readonly onQueued?: (result: { id: string; held: boolean }) => void,
    private readonly confirmPairing?: BrowserPairingHandler
  ) {}

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  get error(): string {
    return this.lastError;
  }

  get port(): number {
    return this.listeningPort();
  }

  apply(settings: BridgeSettings): Promise<void> {
    this.operation = this.operation.then(() => this.applyNow(settings)).catch((error) => {
      this.lastError = (error as Error).message;
      this.logger.error('bridge', `Browser bridge error: ${this.lastError}`);
    });
    return this.operation;
  }

  async close(): Promise<void> {
    await this.stop();
  }

  testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.listening) {
      return Promise.resolve({
        ok: false,
        message: this.lastError || 'The browser bridge is not listening.'
      });
    }
    const port = this.listeningPort();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; message: string }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/health',
          headers: { Authorization: `Bearer ${this.settings.token}` },
          timeout: 3000
        },
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            finish({ ok: true, message: `Bridge responded on 127.0.0.1:${port}.` });
          } else {
            finish({ ok: false, message: `Bridge returned HTTP ${response.statusCode ?? 'unknown'}.` });
          }
        }
      );
      request.on('timeout', () => {
        request.destroy();
        finish({ ok: false, message: 'The bridge did not respond in time.' });
      });
      request.on('error', (error) => finish({ ok: false, message: error.message }));
    });
  }

  private async applyNow(settings: BridgeSettings): Promise<void> {
    const unchanged =
      this.server?.listening &&
      this.settings.enabled === settings.enabled &&
      this.settings.port === settings.port &&
      this.settings.token === settings.token;
    this.settings = { ...settings };
    if (unchanged) return;
    await this.stop();
    if (!settings.enabled) {
      this.lastError = '';
      return;
    }
    if (!settings.token) {
      this.lastError = 'The bridge token is missing.';
      return;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        this.server = null;
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        server.on('error', (error) => {
          this.lastError = error.message;
          this.logger.error('bridge', `Browser bridge server error: ${error.message}`);
        });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.settings.port, '127.0.0.1');
    }).catch((error) => {
      this.lastError =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${this.settings.port} is already in use.`
          : (error as Error).message;
      throw error;
    });
    this.lastError = '';
    this.logger.info('bridge', `Browser bridge listening on 127.0.0.1:${this.listeningPort()}.`);
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    this.logger.info('bridge', 'Browser bridge stopped.');
  }

  private listeningPort(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? (address as AddressInfo).port : this.settings.port;
  }

  /**
   * Shows one pairing prompt and clears it when it settles, so a request that
   * arrives afterwards asks again. A failure to show the prompt counts as a denial.
   */
  private askForPairing(confirmation: BrowserPairingConfirmation): Promise<boolean> {
    const prompt = (async () => {
      try {
        return await this.confirmPairing!(confirmation);
      } catch (error) {
        this.logger.error('bridge', `Pairing confirmation failed: ${(error as Error).message}`);
        return false;
      }
    })().finally(() => {
      if (this.pairingPrompt === prompt) this.pairingPrompt = null;
    });
    return prompt;
  }

  /**
   * Only answer requests addressed to the loopback name the extension uses.
   * A DNS-rebinding page reaches this port under its own hostname, so rejecting
   * any other Host closes that route regardless of the token.
   */
  private hostAllowed(request: http.IncomingMessage): boolean {
    const host = String(request.headers.host ?? '').toLowerCase();
    const port = this.listeningPort();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.hostAllowed(request)) {
      this.json(response, 403, { ok: false, error: 'Unexpected Host header.' });
      return;
    }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    response.setHeader('Access-Control-Allow-Origin', origin || '*');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MDM-Token, X-MDM-Extension');
    response.setHeader('Access-Control-Max-Age', '600');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const remote = request.socket.remoteAddress ?? 'local';
    if (!this.allowRequest(remote)) {
      this.json(response, 429, { ok: false, error: 'Too many requests. Try again shortly.' });
      return;
    }

    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${this.listeningPort()}`);
    if (request.method === 'GET' && requestUrl.pathname === '/pair') {
      if (!isBrowserExtensionPairRequest(request, origin)) {
        this.json(response, 403, { ok: false, error: 'Only browser extensions can pair with the MDM bridge.' });
        return;
      }
      if (!this.allowPairRequest(remote)) {
        this.json(response, 429, { ok: false, error: 'Too many pairing attempts. Try again in a minute.' });
        return;
      }
      if (!this.confirmPairing) {
        this.json(response, 503, { ok: false, error: 'Pairing confirmation is unavailable.' });
        return;
      }
      // The background worker and the popup can ask at the same moment. Let the
      // second join the prompt that is already on screen instead of failing: it
      // is the same extension and the same decision, and both need the token.
      // Once the prompt settles, a later request asks again (nothing is cached).
      let pending = this.pairingPrompt;
      if (pending) {
        this.logger.info('bridge', 'Browser extension pairing joined the prompt already waiting for confirmation.');
      } else {
        const extensionId = pairingExtensionId(request, origin);
        this.logger.info('bridge', `Browser extension pairing requested (${extensionId}).`);
        pending = this.askForPairing({ extensionId, origin: origin.toLowerCase() });
        this.pairingPrompt = pending;
      }
      const approved = await pending;
      if (!approved) {
        this.logger.info('bridge', 'Browser extension pairing was declined.');
        this.json(response, 403, {
          ok: false,
          error: 'Pairing was declined in MDM.',
          data: { declined: true }
        });
        return;
      }
      this.logger.info('bridge', 'Browser extension pairing was approved.');
      this.json(response, 200, {
        ok: true,
        data: { app: APP_NAME, version: APP_VERSION, token: this.settings.token }
      });
      return;
    }

    if (!this.authorized(request)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="MDM"');
      this.json(response, 401, { ok: false, error: 'Invalid or missing bridge token.' });
      return;
    }

    try {
      const url = requestUrl;
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        this.json(response, 200, {
          ok: true,
          data: { app: APP_NAME, version: APP_VERSION, ready: true }
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/queues') {
        this.json(response, 200, {
          ok: true,
          data: this.manager.encodeQueueForBridge().queues.map((queue) => ({
            id: queue.id,
            name: queue.name,
            active: queue.status === 'active'
          }))
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/download') {
        const body = await this.readJson(request);
        const bridgeRequest = parseBridgeRequest(body);
        const rule = this.manager.resolveSiteRule(
          bridgeRequest.url,
          bridgeRequest.sourcePageUrl ?? '',
          bridgeRequest.fileName ?? ''
        );
        if (rule?.action === 'ignore') {
          this.logger.info('bridge', `Browser capture ignored by site rule "${rule.name}".`);
          this.json(response, 200, {
            ok: true,
            data: { ignored: true, rule: { id: rule.id, name: rule.name } }
          });
          return;
        }
        if (bridgeRequest.confirmDownload && rule?.action !== 'ask') {
          if (!this.confirmDownload) {
            throw new BridgeError(503, 'Download confirmation is unavailable.');
          }
          this.confirmDownload({
            request: bridgeRequest,
            destinationDir: rule?.destinationDir ?? ''
          });
          this.logger.info('bridge', `Browser request is waiting for confirmation (${bridgeRequest.url}).`);
          this.json(response, 200, { ok: true, data: { pending: true } });
          return;
        }
        const held = rule?.action === 'ask';
        const requestKey = [
          bridgeRequest.url,
          bridgeRequest.fileName ?? '',
          bridgeRequest.mediaFormatId ?? '',
          bridgeRequest.mediaEngine ?? '',
          bridgeRequest.queueId ?? ''
        ].join('\n');
        const pending = this.pendingDownloads.get(requestKey);
        if (pending) {
          const result = await pending;
          this.json(response, 200, { ok: true, data: { ...result, held, duplicateOf: result.id } });
          return;
        }
        const task = this.manager.addDownload({
          url: bridgeRequest.url,
          fileName: bridgeRequest.fileName,
          destinationDir: rule?.destinationDir || undefined,
          headers: bridgeRequest.headers,
          cookies: bridgeRequest.cookies,
          referrer: bridgeRequest.referrer,
          sourcePageUrl: bridgeRequest.sourcePageUrl,
          queueId: bridgeRequest.queueId,
          mediaFormatId: bridgeRequest.mediaFormatId,
          mediaEngine: bridgeRequest.mediaEngine,
          startNow: held ? false : bridgeRequest.autoStart !== false
        });
        this.pendingDownloads.set(requestKey, task);
        let result: AddDownloadResult;
        try {
          result = await task;
        } finally {
          this.pendingDownloads.delete(requestKey);
        }
        this.logger.info('bridge', `Browser request queued a download (${result.id}).`);
        this.onQueued?.({ id: result.id, held });
        this.json(response, 200, { ok: true, data: { ...result, held } });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/probe') {
        const body = await this.readJson(request);
        const bridgeRequest = parseBridgeRequest(body);
        const result = await this.manager.probeMedia(
          bridgeRequest.url,
          bridgeRequest.headers,
          bridgeRequest.cookies,
          bridgeRequest.referrer,
          bridgeRequest.mediaEngine
        );
        const safe: MediaProbeResult = {
          ...result,
          formats: result.formats.map((format) => ({
            ...format,
            url: format.url
          }))
        };
        this.json(response, 200, { ok: true, data: safe });
        return;
      }
      this.json(response, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'The request could not be completed.';
      if (status >= 500) this.logger.error('bridge', `Request failed: ${message}`);
      this.json(response, status, { ok: false, error: message });
    }
  }

  private authorized(request: http.IncomingMessage): boolean {
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : '';
    const alternate = request.headers['x-mdm-token'];
    const supplied = bearer || (typeof alternate === 'string' ? alternate : '');
    return constantTimeEqual(supplied, this.settings.token);
  }

  private allowRequest(remote: string): boolean {
    return this.rate(this.rates, remote, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  }

  private allowPairRequest(remote: string): boolean {
    return this.rate(this.pairRates, remote, PAIR_RATE_LIMIT_MAX, PAIR_RATE_LIMIT_WINDOW_MS);
  }

  private rate(map: Map<string, RateEntry>, remote: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = map.get(remote);
    if (!entry || now - entry.startedAt >= windowMs) {
      map.set(remote, { startedAt: now, count: 1 });
      if (map.size > 500) {
        for (const [key, value] of map) if (now - value.startedAt >= windowMs) map.delete(key);
      }
      return true;
    }
    entry.count++;
    return entry.count <= max;
  }

  private readJson(request: http.IncomingMessage): Promise<unknown> {
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      throw new BridgeError(415, 'Send the request as application/json.');
    }
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) throw new BridgeError(413, 'The request is too large.');
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      request.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
          finish(new BridgeError(413, 'The request is too large.'));
          request.destroy();
          return;
        }
        chunks.push(buffer);
      });
      request.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text.trim()) throw new BridgeError(400, 'A JSON request body is required.');
          finish(null, JSON.parse(text));
        } catch (error) {
          finish(error instanceof BridgeError ? error : new BridgeError(400, 'The request body is not valid JSON.'));
        }
      });
      request.on('error', (error) => finish(new BridgeError(400, error.message)));
      request.on('aborted', () => finish(new BridgeError(400, 'The request was aborted.')));
    });
  }

  private json(response: http.ServerResponse, status: number, payload: IpcResult<unknown>): void {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    });
    response.end(body);
  }
}

class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function parseBridgeRequest(value: unknown): BrowserBridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, 'A download request object is required.');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.url !== 'string' || !isReasonableUrlLength(input.url.trim())) {
    throw new BridgeError(400, 'A valid URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw new BridgeError(400, 'The URL is not valid.');
  }
  if (!['http:', 'https:', 'ftp:'].includes(parsed.protocol)) {
    throw new BridgeError(400, 'Only HTTP, HTTPS, and FTP URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new BridgeError(400, 'Put credentials in the Authorization header instead of the URL.');
  }
  const headers = input.headers === undefined ? undefined : asStringRecord(input.headers, 'headers');
  if (input.cookies !== undefined && typeof input.cookies !== 'string') {
    throw new BridgeError(400, 'Cookies must be a string.');
  }
  if (input.fileName !== undefined && (typeof input.fileName !== 'string' || input.fileName.length > 512)) {
    throw new BridgeError(400, 'The file name is not valid.');
  }
  if (input.confirmDownload !== undefined && typeof input.confirmDownload !== 'boolean') {
    throw new BridgeError(400, 'confirmDownload must be a boolean.');
  }
  if (input.mediaEngine !== undefined && input.mediaEngine !== 'yt-dlp') {
    throw new BridgeError(400, 'mediaEngine must be "yt-dlp" when specified.');
  }
  return {
    url: parsed.toString(),
    fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
    headers,
    cookies: typeof input.cookies === 'string' ? input.cookies : undefined,
    referrer: safeText(input.referrer, 4096, 'referrer'),
    sourcePageUrl: safeText(input.sourcePageUrl, 4096, 'sourcePageUrl'),
    queueId: safeText(input.queueId, 128, 'queueId'),
    mediaFormatId: safeText(input.mediaFormatId, 256, 'mediaFormatId') || undefined,
    mediaEngine: input.mediaEngine === 'yt-dlp' ? 'yt-dlp' : undefined,
    confirmDownload: input.confirmDownload === true,
    mediaTitle: safeText(input.mediaTitle, 512, 'mediaTitle') || undefined,
    mediaQuality: safeText(input.mediaQuality, 128, 'mediaQuality') || undefined,
    autoStart: typeof input.autoStart === 'boolean' ? input.autoStart : true
  };
}

/**
 * Only the bundled extension may ask to pair, and a person must approve every
 * request in MDM.
 *
 * Chrome and Edge report `chrome-extension://<id>` as the Origin when they
 * attach one, and the browser enforces that header. Their extension service
 * workers omit Origin for loopback fetches, so those requests must instead
 * carry `X-MDM-Extension: <id>` together with the Fetch Metadata of an
 * extension-initiated CORS request. A web page cannot produce that combination:
 * its Origin is always present and its Sec-Fetch-Site is cross-site/same-origin.
 * Other extensions can copy the public ID, so the ID check alone only narrows
 * the caller; the one-time confirmation prompt is what proves intent.
 *
 * Firefox reports a random `moz-extension://<uuid>` per profile and offers no
 * way to verify the add-on in this request, so Firefox users paste the token
 * shown in MDM instead. There is no unverified fallback.
 */
function isBrowserExtensionPairRequest(request: http.IncomingMessage, origin: string): boolean {
  if (origin) return origin.toLowerCase() === CHROMIUM_EXTENSION_ORIGIN;
  return (
    String(request.headers['x-mdm-extension'] ?? '').toLowerCase() === CHROMIUM_EXTENSION_ID &&
    request.headers['sec-fetch-site'] === 'none' &&
    request.headers['sec-fetch-mode'] === 'cors' &&
    request.headers['sec-fetch-dest'] === 'empty'
  );
}

function pairingExtensionId(request: http.IncomingMessage, origin: string): string {
  if (origin) return origin.slice('chrome-extension://'.length).toLowerCase();
  return String(request.headers['x-mdm-extension'] ?? '').toLowerCase();
}

function asStringRecord(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, `${name} must be an object.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 80) throw new BridgeError(400, `Too many ${name}.`);
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== 'string' || key.length > 256 || item.length > 16_384 || /[\r\n]/.test(key)) {
      throw new BridgeError(400, `${name} contains an invalid value.`);
    }
    result[key] = item;
  }
  return result;
}

function safeText(value: unknown, max: number, name: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new BridgeError(400, `${name} is not valid.`);
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
