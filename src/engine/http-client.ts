import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { DownloadError, mapNetworkError } from './errors';
import { describeTlsFailure, inspectCertificateChain } from './tls-diagnostics';
import { getTrustedCAs } from './tls-trust';
import { APP_SHORT_NAME, APP_VERSION } from '../shared/defaults';
import { redactUrl } from '../shared/validation';

export interface ResolvedProxy {
  protocol: 'http' | 'https';
  host: string;
  port: number;
  username: string;
  password: string;
  bypass: string[];
  url: string;
}

export interface HttpClientOptions {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxRedirects: number;
  ipVersion: 'any' | 'ipv4' | 'ipv6';
  userAgent: string;
  proxy: ResolvedProxy | null;
  maxSocketsPerHost: number;
  /** Opt-in per download: accept servers with invalid or incomplete TLS chains. */
  tlsAllowInsecure?: boolean;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  cookieJar?: CookieJar;
  followRedirects?: boolean;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
  close: () => void;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  expires: number | null;
}

export class CookieJar {
  private cookies: Cookie[] = [];

  setFromResponse(url: string, setCookieHeaders: string[] | undefined): void {
    if (!setCookieHeaders) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    for (const line of setCookieHeaders) {
      const parts = line.split(';');
      const first = parts.shift();
      if (!first) continue;
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      const cookie: Cookie = {
        name,
        value,
        domain: parsed.hostname.toLowerCase(),
        path: defaultCookiePath(parsed.pathname),
        hostOnly: true,
        secure: false,
        expires: null
      };
      for (const attribute of parts) {
        const [rawKey, ...rawValueParts] = attribute.split('=');
        const key = rawKey?.trim().toLowerCase() ?? '';
        const rawValue = rawValueParts.join('=').trim();
        if (key === 'domain' && rawValue) {
          const domain = rawValue.replace(/^\./, '').toLowerCase();
          if (parsed.hostname.toLowerCase().endsWith(domain) && domain.includes('.')) {
            cookie.domain = domain;
            cookie.hostOnly = false;
          }
        } else if (key === 'path' && rawValue.startsWith('/')) {
          cookie.path = rawValue;
        } else if (key === 'secure') {
          cookie.secure = true;
        } else if (key === 'httponly') {
          continue;
        } else if (key === 'max-age') {
          const seconds = Number(rawValue);
          if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000;
        } else if (key === 'expires' && cookie.expires === null) {
          const time = Date.parse(rawValue);
          if (Number.isFinite(time)) cookie.expires = time;
        }
      }
      if (cookie.expires !== null && cookie.expires <= Date.now()) {
        this.cookies = this.cookies.filter(
          (existing) => !(existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path)
        );
        continue;
      }
      this.cookies = this.cookies.filter(
        (existing) => !(existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path)
      );
      this.cookies.push(cookie);
      if (this.cookies.length > 200) this.cookies.splice(0, this.cookies.length - 200);
    }
  }

  headerFor(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return '';
    }
    const now = Date.now();
    this.cookies = this.cookies.filter((cookie) => cookie.expires === null || cookie.expires > now);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || '/';
    const secure = parsed.protocol === 'https:';
    return this.cookies
      .filter((cookie) => {
        if (cookie.secure && !secure) return false;
        if (cookie.hostOnly ? host !== cookie.domain : !host.endsWith(cookie.domain)) return false;
        if (!path.startsWith(cookie.path)) return false;
        return true;
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const trimmed = pathname.slice(0, pathname.lastIndexOf('/'));
  return trimmed || '/';
}

const SENSITIVE_HEADER_PATTERN = /authorization|cookie|proxy-authorization|x-api-key|api-key/i;

/** Copy of `headers` without anything that carries credentials. */
export function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER_PATTERN.test(name)) result[name] = value;
  }
  return result;
}

/**
 * Credentials captured for one site must not follow a redirect to another host
 * or from HTTPS down to plain HTTP.
 */
export function sharesCredentialScope(origin: string, target: string): boolean {
  try {
    const from = new URL(origin);
    const to = new URL(target);
    if (from.hostname.toLowerCase() !== to.hostname.toLowerCase()) return false;
    return !(from.protocol === 'https:' && to.protocol !== 'https:');
  } catch {
    return false;
  }
}

let baseMaxSockets: number | null = null;
const socketLeases = new Set<{ limit: number }>();

function applyDirectAgentLimit(): void {
  if (baseMaxSockets === null) return;
  let limit = baseMaxSockets;
  for (const lease of socketLeases) limit = Math.max(limit, lease.limit);
  for (const agent of [directHttpAgent, directHttpsAgent, insecureHttpsAgent]) {
    if (!agent) continue;
    agent.maxSockets = limit;
    agent.maxFreeSockets = limit;
  }
}

export function setDirectAgentMaxSockets(maxSockets: number): void {
  baseMaxSockets = maxSockets;
  applyDirectAgentLimit();
}

/** Temporarily raises the shared agents' socket cap; call the result to restore it. */
export function boostDirectAgentSockets(limit: number): () => void {
  const lease = { limit: Math.max(1, Math.floor(limit)) };
  socketLeases.add(lease);
  applyDirectAgentLimit();
  return () => {
    if (!socketLeases.delete(lease)) return;
    applyDirectAgentLimit();
  };
}

let directHttpAgent: http.Agent | null = null;
let directHttpsAgent: https.Agent | null = null;
let insecureHttpsAgent: https.Agent | null = null;

function makeLookup(ipVersion: HttpClientOptions['ipVersion']): LookupFunction | undefined {
  if (ipVersion === 'any') return undefined;
  const family = ipVersion === 'ipv4' ? 4 : 6;
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, family }, callback as never);
  };
}

function bypassMatches(hostname: string, entries: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry === '<local>' && !host.includes('.')) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (entry.startsWith('.')) {
      if (host.endsWith(entry) || host === entry.slice(1)) return true;
      continue;
    }
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

export class HttpClient {
  private readonly options: HttpClientOptions;
  private readonly proxyHttpAgent: http.Agent | null;
  private readonly proxyHttpsAgent: https.Agent | null;

  constructor(options: HttpClientOptions) {
    this.options = {
      ...options,
      connectTimeoutMs: Math.max(1000, options.connectTimeoutMs),
      idleTimeoutMs: Math.max(1000, options.idleTimeoutMs),
      maxRedirects: Math.max(0, options.maxRedirects),
      maxSocketsPerHost: Math.max(1, options.maxSocketsPerHost)
    };
    if (options.proxy) {
      this.proxyHttpAgent = new HttpProxyAgent(options.proxy.url, {
        keepAlive: true,
        maxSockets: this.options.maxSocketsPerHost
      } as http.AgentOptions);
      this.proxyHttpsAgent = new HttpsProxyAgent(options.proxy.url, {
        keepAlive: true,
        maxSockets: this.options.maxSocketsPerHost,
        ca: getTrustedCAs()
      } as https.AgentOptions);
    } else {
      this.proxyHttpAgent = null;
      this.proxyHttpsAgent = null;
    }
  }

  private readonly proxyLeases = new Set<{ limit: number }>();

  private applyProxyLimit(): void {
    let limit = this.options.maxSocketsPerHost;
    for (const lease of this.proxyLeases) limit = Math.max(limit, lease.limit);
    for (const agent of [this.proxyHttpAgent, this.proxyHttpsAgent]) {
      if (!agent) continue;
      agent.maxSockets = limit;
      agent.maxFreeSockets = limit;
    }
  }

  /**
   * Temporarily raises the socket cap per host for Turbo downloads. Without
   * this the agent would queue extra connections no matter how many workers run.
   * Call the returned function to restore the configured cap.
   */
  boostSockets(limit: number): () => void {
    const releaseDirect = boostDirectAgentSockets(limit);
    const lease = { limit: Math.max(1, Math.floor(limit)) };
    this.proxyLeases.add(lease);
    this.applyProxyLimit();
    return () => {
      releaseDirect();
      if (!this.proxyLeases.delete(lease)) return;
      this.applyProxyLimit();
    };
  }

  get defaultUserAgent(): string {
    return this.options.userAgent || `${APP_SHORT_NAME}/${APP_VERSION}`;
  }

  async request(rawUrl: string, requestOptions: HttpRequestOptions = {}): Promise<HttpResponse> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new DownloadError('The download URL is not valid.', 'INVALID_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new DownloadError(`Unsupported protocol: ${url.protocol}`, 'UNSUPPORTED_PROTOCOL');
    }

    const method = requestOptions.method ?? 'GET';
    const customHeaders = { ...(requestOptions.headers ?? {}) };
    let redirects = 0;
    let currentUrl = url;
    let referer = '';
    let originalHost = url.hostname.toLowerCase();
    const cookieJar = requestOptions.cookieJar;

    for (;;) {
      let response: Awaited<ReturnType<HttpClient['singleRequest']>>;
      try {
        response = await this.singleRequest(currentUrl, method, customHeaders, referer, requestOptions.signal, cookieJar);
      } catch (error) {
        throw await this.explainTlsFailure(error, currentUrl);
      }
      if (cookieJar) cookieJar.setFromResponse(currentUrl.toString(), response.headers['set-cookie']);

      const status = response.status;
      if (
        requestOptions.followRedirects !== false &&
        [301, 302, 303, 307, 308].includes(status) &&
        response.headers.location
      ) {
        const location = response.headers.location;
        response.close();
        if (redirects >= this.options.maxRedirects) {
          throw new DownloadError(`Too many redirects (more than ${this.options.maxRedirects}).`, 'HTTP_ERROR', {
            statusCode: status
          });
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new DownloadError('The server returned an invalid redirect target.', 'HTTP_ERROR', { statusCode: status });
        }
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new DownloadError(`Redirected to an unsupported protocol: ${nextUrl.protocol}`, 'UNSUPPORTED_PROTOCOL');
        }
        redirects++;
        referer = currentUrl.toString();
        const downgraded = currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:';
        if (nextUrl.hostname.toLowerCase() !== originalHost || downgraded) {
          for (const name of Object.keys(customHeaders)) {
            if (SENSITIVE_HEADER_PATTERN.test(name)) delete customHeaders[name];
          }
          originalHost = nextUrl.hostname.toLowerCase();
        }
        currentUrl = nextUrl;
        continue;
      }
      return { ...response, url: currentUrl.toString() };
    }
  }

  /**
   * For a certificate-chain failure on a direct connection, add what the server
   * actually presented (see tls-diagnostics). Best effort: it never throws, and
   * it is skipped through a proxy, where the connection we would look at is not
   * the one that failed. Returns the error to throw.
   */
  private async explainTlsFailure(error: unknown, url: URL): Promise<unknown> {
    if (!(error instanceof DownloadError) || error.code !== 'TLS_CHAIN' || error.detail) return error;
    if (url.protocol !== 'https:' || this.shouldProxy(url)) return error;
    try {
      const inspection = await inspectCertificateChain(url.hostname, Number(url.port) || 443);
      const detail = describeTlsFailure(url.hostname, inspection);
      if (!detail) return error;
      return new DownloadError(error.message, error.code, {
        retryable: error.retryable,
        statusCode: error.statusCode,
        retryAfterMs: error.retryAfterMs,
        cause: error.cause,
        detail
      });
    } catch {
      // Diagnostics must never change the outcome of the download.
      return error;
    }
  }

  async fetchBuffer(rawUrl: string, requestOptions: HttpRequestOptions = {}, maxBytes = 16 * 1024 * 1024): Promise<{
    buffer: Buffer;
    headers: IncomingHttpHeaders;
    status: number;
    url: string;
  }> {
    const response = await this.request(rawUrl, requestOptions);
    try {
      const buffer = await readResponseBody(response.stream, maxBytes);
      return { buffer, headers: response.headers, status: response.status, url: response.url };
    } finally {
      response.close();
    }
  }

  private singleRequest(
    url: URL,
    method: 'GET' | 'HEAD',
    headers: Record<string, string>,
    referer: string,
    signal: AbortSignal | undefined,
    cookieJar: CookieJar | undefined
  ): Promise<Omit<HttpResponse, 'url'>> {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const useProxy = this.shouldProxy(url);
      const tlsAllowInsecure = this.options.tlsAllowInsecure === true;
      const agent = useProxy
        ? isHttps
          ? this.proxyHttpsAgent
          : this.proxyHttpAgent
        : isHttps
          ? this.getDirectHttpsAgent(tlsAllowInsecure)
          : this.getDirectHttpAgent();

      const finalHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) finalHeaders[key] = value;
      if (!hasHeader(finalHeaders, 'user-agent')) finalHeaders['User-Agent'] = this.defaultUserAgent;
      if (!hasHeader(finalHeaders, 'accept')) finalHeaders.Accept = '*/*';
      if (!hasHeader(finalHeaders, 'accept-encoding')) finalHeaders['Accept-Encoding'] = 'identity';
      if (referer && !hasHeader(finalHeaders, 'referer')) finalHeaders.Referer = referer;
      const jarHeader = cookieJar?.headerFor(url.toString());
      if (jarHeader) {
        // Cookies learned from the server win over the captured header, but the
        // captured cookies still apply when the jar has nothing for this URL.
        for (const key of Object.keys(finalHeaders)) {
          if (key.toLowerCase() === 'cookie') delete finalHeaders[key];
        }
        finalHeaders.Cookie = jarHeader;
      }

      const requestOptions: https.RequestOptions = {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: finalHeaders,
        agent: agent ?? undefined,
        rejectUnauthorized: !tlsAllowInsecure,
        servername: url.hostname
      };

      if (!useProxy) {
        const lookup = makeLookup(this.options.ipVersion);
        if (lookup) requestOptions.lookup = lookup;
      }
      if (useProxy && !isHttps) {
        requestOptions.path = url.toString();
      }

      const request = (isHttps ? https : http).request(requestOptions);
      let settled = false;
      let connected = false;
      const connectTimer = setTimeout(() => {
        if (!connected) {
          request.destroy(new DownloadError('Connection timed out.', 'TIMEOUT', { retryable: true }));
        }
      }, this.options.connectTimeoutMs);
      connectTimer.unref?.();

      const cleanupSignal = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        request.destroy(new DownloadError('The download was stopped.', 'ABORTED'));
      };
      if (signal?.aborted) {
        clearTimeout(connectTimer);
        reject(new DownloadError('The download was stopped.', 'ABORTED'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      request.once('socket', (socket) => {
        try {
          socket.setNoDelay(true);
          if (typeof (socket as unknown as { setRecvBufferSize?: (size: number) => void }).setRecvBufferSize === 'function') {
            (socket as unknown as { setRecvBufferSize: (size: number) => void }).setRecvBufferSize(256 * 1024);
          }
        } catch {
          /* Buffer sizing is best effort. */
        }
        if (!socket.connecting) {
          connected = true;
        } else {
          socket.once(isHttps ? 'secureConnect' : 'connect', () => {
            connected = true;
          });
        }
      });

      request.on('error', (error) => {
        clearTimeout(connectTimer);
        cleanupSignal();
        if (settled) return;
        settled = true;
        if (signal?.aborted) {
          reject(new DownloadError('The download was stopped.', 'ABORTED'));
          return;
        }
        const remoteAddress = request.socket?.remoteAddress;
        if (remoteAddress) {
          (error as NodeJS.ErrnoException & { remoteAddress?: string }).remoteAddress = remoteAddress;
        }
        reject(mapNetworkError(error, redactUrl(url.toString())));
      });

      request.once('response', (incoming) => {
        connected = true;
        clearTimeout(connectTimer);
        if (settled) {
          incoming.destroy();
          return;
        }
        if (incoming.statusCode === undefined) {
          settled = true;
          cleanupSignal();
          incoming.destroy();
          reject(new DownloadError('The server returned an empty response.', 'NETWORK', { retryable: true }));
          return;
        }
        incoming.setTimeout(this.options.idleTimeoutMs, () => {
          incoming.destroy(new DownloadError('The connection stalled and timed out.', 'TIMEOUT', { retryable: true }));
        });
        const close = () => {
          cleanupSignal();
          incoming.destroy();
        };
        incoming.once('end', cleanupSignal);
        incoming.once('close', cleanupSignal);
        settled = true;
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          stream: incoming,
          close
        });
      });

      request.end();
    });
  }

  private shouldProxy(url: URL): boolean {
    const proxy = this.options.proxy;
    if (!proxy) return false;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())) return false;
    return !bypassMatches(url.hostname, proxy.bypass);
  }

  private getDirectHttpAgent(): http.Agent {
    if (!directHttpAgent) {
      directHttpAgent = new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 30_000,
        maxSockets: this.options.maxSocketsPerHost,
        maxFreeSockets: this.options.maxSocketsPerHost,
        scheduling: 'fifo',
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300
      });
    }
    baseMaxSockets ??= this.options.maxSocketsPerHost;
    applyDirectAgentLimit();
    return directHttpAgent;
  }

  private getDirectHttpsAgent(tlsAllowInsecure: boolean): https.Agent {
    if (tlsAllowInsecure) {
      if (!insecureHttpsAgent) {
        insecureHttpsAgent = new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 30_000,
          maxSockets: this.options.maxSocketsPerHost,
          maxFreeSockets: this.options.maxSocketsPerHost,
          maxCachedSessions: 256,
          scheduling: 'fifo',
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 300,
          rejectUnauthorized: false
        });
      }
      baseMaxSockets ??= this.options.maxSocketsPerHost;
      applyDirectAgentLimit();
      return insecureHttpsAgent;
    }
    if (!directHttpsAgent) {
      directHttpsAgent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30_000,
        maxSockets: this.options.maxSocketsPerHost,
        maxFreeSockets: this.options.maxSocketsPerHost,
        maxCachedSessions: 256,
        scheduling: 'fifo',
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 300,
        rejectUnauthorized: true,
        ca: getTrustedCAs()
      });
    }
    baseMaxSockets ??= this.options.maxSocketsPerHost;
    applyDirectAgentLimit();
    return directHttpsAgent;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

export async function readResponseBody(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const encoding = String(stream.headers['content-encoding'] ?? '').toLowerCase();
  let source: NodeJS.ReadableStream = stream;
  if (encoding && encoding !== 'identity') {
    if (encoding === 'gzip' || encoding === 'x-gzip') source = stream.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') source = stream.pipe(zlib.createInflate());
    else if (encoding === 'br') source = stream.pipe(zlib.createBrotliDecompress());
    else throw new DownloadError(`Unsupported content encoding: ${encoding}`, 'HTTP_ERROR');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new DownloadError('The server response was larger than expected.', 'HTTP_ERROR');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseRetryAfter(headers: IncomingHttpHeaders): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export function httpStatusError(status: number, headers: IncomingHttpHeaders, url?: string): DownloadError {
  const retryAfterMs = parseRetryAfter(headers);
  const suffix = url ? ` (${redactUrl(url)})` : '';
  if (status === 401 || status === 403) {
    return new DownloadError(`Access denied (HTTP ${status}).${suffix}`, 'HTTP_403', { statusCode: status });
  }
  if (status === 404) {
    return new DownloadError(`File not found (HTTP 404).${suffix}`, 'HTTP_404', { statusCode: status });
  }
  if (status === 410) {
    return new DownloadError(`The link has expired (HTTP 410).${suffix}`, 'HTTP_410', { statusCode: status });
  }
  if (status === 416) {
    return new DownloadError('The requested byte range is not available (HTTP 416).', 'HTTP_416', { statusCode: status });
  }
  if (status === 408) {
    return new DownloadError('The server timed out the request (HTTP 408).', 'TIMEOUT', { statusCode: status, retryable: true });
  }
  if (status === 429) {
    return new DownloadError('Rate limited by the server (HTTP 429).', 'HTTP_429', {
      statusCode: status,
      retryable: true,
      retryAfterMs
    });
  }
  if (status === 407) {
    return new DownloadError('The proxy requires authentication (HTTP 407).', 'PROXY', { statusCode: status });
  }
  if (status >= 500) {
    return new DownloadError(`Server error (HTTP ${status}).`, 'SERVER_ERROR', {
      statusCode: status,
      retryable: true,
      retryAfterMs
    });
  }
  return new DownloadError(`The server returned HTTP ${status}.`, 'HTTP_ERROR', {
    statusCode: status,
    retryable: status === 408
  });
}

export function parseContentRange(value: string | undefined): { start: number | null; end: number | null; total: number | null } {
  if (!value) return { start: null, end: null, total: null };
  const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value);
  if (!match) {
    const totalOnly = /bytes\s+\*\/(\d+)/i.exec(value);
    if (totalOnly?.[1]) return { start: null, end: null, total: Number(totalOnly[1]) };
    return { start: null, end: null, total: null };
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3])
  };
}

export function contentLength(headers: IncomingHttpHeaders): number | null {
  const raw = headers['content-length'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
