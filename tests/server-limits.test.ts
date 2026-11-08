import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient, setDirectAgentMaxSockets } from '../src/engine/http-client';
import { HttpDownloadTask } from '../src/engine/http-download';
import { HostLimiter, TokenBucket } from '../src/engine/rate-limiter';
import type { DownloadConfig, EngineCallbacks, EngineRuntime } from '../src/engine/types';
import { startLinkServer, type LinkServer } from './support/link-server';

const MB = 1024 * 1024;
const servers: LinkServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A download set up like the shipped defaults: start with many connections, Turbo allowed. */
async function download(url: string, limiter: HostLimiter, connections = 32) {
  setDirectAgentMaxSockets(32);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-limits-'));
  const logs: string[] = [];
  const runtime = {
    http: new HttpClient({
      connectTimeoutMs: 5000,
      idleTimeoutMs: 30000,
      maxRedirects: 3,
      ipVersion: 'ipv4',
      userAgent: 'limits-test',
      proxy: null,
      maxSocketsPerHost: 32
    }),
    hostLimiter: limiter,
    globalLimiter: new TokenBucket(0),
    logger: () => undefined,
    reservedTargetPaths: new Set<string>()
  } as unknown as EngineRuntime;
  const config = {
    id: `limits-${Math.random()}`,
    kind: 'http',
    url,
    destinationDir: dir,
    fileName: 'file.bin',
    fileNameExplicit: true,
    headers: {},
    cookies: '',
    referrer: '',
    connections,
    turbo: { maxConnections: 32 },
    speedLimitBps: 0,
    maxRetries: 5,
    retryBaseDelayMs: 1000,
    checksum: '',
    checksumAlgorithm: '',
    conflictPolicy: 'rename',
    tlsAllowInsecure: false,
    sourcePageUrl: ''
  } as unknown as DownloadConfig;
  const callbacks = {
    onPrepared: () => undefined,
    onProgress: () => undefined,
    onCheckpoint: () => undefined,
    onLog: (_level: string, message: string) => logs.push(message)
  } as unknown as EngineCallbacks;
  const outcome = await new HttpDownloadTask(config, runtime, callbacks).run();
  let intact = false;
  if (outcome.status === 'completed') {
    const content = await fsp.readFile(outcome.result.targetPath);
    // The test server sends only 0x5a, so a hole or a repeated range would show.
    intact = content.every((byte) => byte === 0x5a) && content.length > 0;
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return { outcome, intact, logs };
}

describe('a server that allows fewer connections than we start with', () => {
  it('slows the download down instead of failing it, and remembers the limit for next time', async () => {
    const size = 24 * MB;
    const link = await startLinkServer({ lineBps: 12 * MB, perConnectionBps: 1 * MB, size, rejectAbove: 4 });
    servers.push(link);
    const limiter = new HostLimiter(32);

    const first = await download(link.url, limiter);
    expect(first.outcome.status).toBe('completed');
    expect(first.intact).toBe(true);
    expect(link.stats.rejected).toBeGreaterThan(0);
    expect(link.stats.maxConcurrent).toBeLessThanOrEqual(4);
    expect(limiter.learned('127.0.0.1')).toBe(4);

    // The next download from the same host starts where the server was happy, so it is not refused.
    const refusedBefore = link.stats.rejected;
    const second = await download(link.url, limiter);
    expect(second.outcome.status).toBe('completed');
    expect(second.intact).toBe(true);
    expect(link.stats.rejected - refusedBefore).toBeLessThanOrEqual(2);
    expect(second.logs.some((line) => /accepted about 4 connections last time/.test(line))).toBe(true);
  }, 120_000);

  it('works with a server that allows only a single connection', async () => {
    const link = await startLinkServer({ lineBps: 12 * MB, perConnectionBps: 4 * MB, size: 8 * MB, rejectAbove: 1 });
    servers.push(link);
    const result = await download(link.url, new HostLimiter(32));
    expect(result.outcome.status).toBe('completed');
    expect(result.intact).toBe(true);
    expect(link.stats.maxConcurrent).toBe(1);
  }, 120_000);
});

describe('HostLimiter memory', () => {
  it('keeps the highest accepted count it has seen and forgets it after a while', () => {
    const limiter = new HostLimiter(8);
    const t0 = 1_000_000;
    expect(limiter.learned('files.example', t0)).toBeUndefined();
    limiter.learn('files.example', 6, t0);
    limiter.learn('files.example', 9, t0 + 1000);
    limiter.learn('files.example', 5, t0 + 2000);
    expect(limiter.learned('files.example', t0 + 3000)).toBe(9);
    expect(limiter.learned('other.example', t0 + 3000)).toBeUndefined();
    expect(limiter.learned('files.example', t0 + 11 * 60 * 1000)).toBeUndefined();
  });

  it('counts connections the server accepted, not attempts that were refused', () => {
    const limiter = new HostLimiter(8);
    const first = limiter.streamOpened('files.example');
    const second = limiter.streamOpened('files.example');
    expect(limiter.streamsOpen('files.example')).toBe(2);
    first();
    first(); // releasing twice must not undercount
    expect(limiter.streamsOpen('files.example')).toBe(1);
    second();
    expect(limiter.streamsOpen('files.example')).toBe(0);
  });
});
