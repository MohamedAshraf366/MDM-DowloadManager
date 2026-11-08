import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/engine/http-client';
import { HttpDownloadTask } from '../src/engine/http-download';
import { HostLimiter, TokenBucket } from '../src/engine/rate-limiter';
import { LineSpeedMemory, type LineSpeedSource } from '../src/engine/line-speed';
import type { DownloadConfig, EngineCallbacks, EngineRuntime } from '../src/engine/types';
import { startLinkServer, type LinkServer } from './support/link-server';

const MB = 1024 * 1024;
const FAST_TUNING = { sampleMs: 250, settleSamples: 2, measureSamples: 3 };

let servers: LinkServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

async function download(
  url: string,
  connections: number,
  turboMax: number | null,
  speedLimitBps = 0,
  lineSpeed?: LineSpeedSource
) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-turbo-'));
  const logs: string[] = [];
  const hostLimiter = new HostLimiter(connections);
  const runtime = {
    http: new HttpClient({
      connectTimeoutMs: 5000,
      idleTimeoutMs: 20000,
      maxRedirects: 3,
      ipVersion: 'ipv4',
      userAgent: 'turbo-test',
      proxy: null,
      maxSocketsPerHost: connections
    }),
    hostLimiter,
    lineSpeed,
    globalLimiter: new TokenBucket(0),
    logger: () => undefined,
    reservedTargetPaths: new Set<string>()
  } as unknown as EngineRuntime;
  const config = {
    id: 'turbo',
    kind: 'http',
    url,
    destinationDir: dir,
    fileName: 'file.bin',
    fileNameExplicit: true,
    headers: {},
    cookies: '',
    referrer: '',
    connections,
    turbo: turboMax ? { maxConnections: turboMax, tuning: FAST_TUNING } : undefined,
    speedLimitBps,
    maxRetries: 2,
    retryBaseDelayMs: 50,
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
  const started = performance.now();
  const outcome = await new HttpDownloadTask(config, runtime, callbacks).run();
  const seconds = (performance.now() - started) / 1000;
  if (outcome.status !== 'completed') throw new Error(`download ended as ${outcome.status}`);
  const content = await fsp.readFile(outcome.result.targetPath);
  // The test server sends 0x5a only, so any hole left by a retired connection shows up as a different byte.
  const holes = content.indexOf(Buffer.from([0x00])) >= 0 || content.some((byte) => byte !== 0x5a);
  await fsp.rm(dir, { recursive: true, force: true });
  return { seconds, bytes: content.length, holes, logs, hostLimiter };
}

describe('Turbo on a simulated connection', () => {
  it('uses the spare capacity of an under-used line, and gives it back afterwards', async () => {
    const size = 72 * MB;
    // Line 12 MB/s, but the server gives each connection only 1 MB/s: 4 connections can never exceed 4 MB/s.
    const link = await startLinkServer({ lineBps: 12 * MB, perConnectionBps: 1 * MB, size });
    servers.push(link);

    const turbo = await download(link.url, 4, 16);

    expect(turbo.bytes).toBe(size);
    expect(turbo.holes).toBe(false);
    expect(link.stats.maxConcurrent).toBeGreaterThan(8);
    expect(link.stats.maxConcurrent).toBeLessThanOrEqual(16);
    // 4 connections would need 18 s for 72 MB; Turbo has to be clearly faster.
    expect(turbo.seconds).toBeLessThan((size / (4 * MB)) * 0.7);
    expect(turbo.logs.some((line) => line.startsWith('Turbo: now'))).toBe(true);
    expect(turbo.logs.some((line) => line.startsWith('Turbo: holding'))).toBe(true);

    // Back to normal: the per-host cap is the configured 4 again, not the Turbo ceiling.
    let granted = 0;
    const releases: Array<() => void> = [];
    for (let i = 0; i < 6; i += 1) {
      void turbo.hostLimiter.acquire('probe').then((release) => {
        granted += 1;
        releases.push(release);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(granted).toBe(4);
    releases.forEach((release) => release());
  }, 120_000);

  it('is not held back by a speed remembered from a slower network, and learns the new one', async () => {
    const size = 72 * MB;
    // The network before did 32 Mbit/s (4 MB/s). This one does 96 Mbit/s (12 MB/s).
    const link = await startLinkServer({ lineBps: 12 * MB, perConnectionBps: 1 * MB, size });
    servers.push(link);
    let stored: string | null = null;
    const memory = new LineSpeedMemory({ load: () => stored, save: (json) => (stored = json) }, () => 'this-network');
    memory.observe(4_000_000);

    const result = await download(link.url, 4, 16, 0, memory);

    expect(result.bytes).toBe(size);
    expect(result.holes).toBe(false);
    expect(result.logs.some((line) => /This network has delivered about 32\.0 Mbit\/s before/.test(line))).toBe(true);
    // A 32 Mbit/s ceiling would have kept it near 4 connections; it went well past that.
    expect(link.stats.maxConcurrent).toBeGreaterThan(8);
    expect(result.seconds).toBeLessThan((size / (4 * MB)) * 0.7);
    // What it measured replaces the old figure over time: it is now well above 32 Mbit/s.
    expect(memory.hint()!).toBeGreaterThan(6_000_000);
  }, 120_000);

  it('adds nothing when the starting connections already fill the line', async () => {
    const size = 12 * MB;
    // 4 connections ask for 4 MB/s on a 2 MB/s line: already full.
    const link = await startLinkServer({ lineBps: 2 * MB, perConnectionBps: 1 * MB, size });
    servers.push(link);
    const result = await download(link.url, 4, 16);
    expect(result.bytes).toBe(size);
    expect(link.stats.maxConcurrent).toBeLessThanOrEqual(8);
  }, 120_000);

  it('backs off when the server limits parallel connections, and still finishes the file', async () => {
    const size = 48 * MB;
    // The server allows 8 parallel connections and answers 429 beyond that.
    const link = await startLinkServer({ lineBps: 12 * MB, perConnectionBps: 1 * MB, size, rejectAbove: 8 });
    servers.push(link);
    const result = await download(link.url, 4, 24);
    expect(result.bytes).toBe(size);
    expect(result.holes).toBe(false);
    expect(link.stats.rejected).toBeGreaterThan(0);
    expect(link.stats.maxConcurrent).toBeLessThanOrEqual(8);
    expect(result.logs.some((line) => /pushed back on the extra connections/.test(line))).toBe(true);
  }, 120_000);

  it('is off unless asked for', async () => {
    const link = await startLinkServer({ lineBps: 6 * MB, perConnectionBps: 0.5 * MB, size: 8 * MB });
    servers.push(link);
    const result = await download(link.url, 4, null);
    expect(result.logs.some((line) => line.startsWith('Turbo'))).toBe(false);
    expect(link.stats.maxConcurrent).toBeLessThanOrEqual(5);
  }, 120_000);

  it('steps aside when a speed limit is set', async () => {
    const size = 32 * MB;
    // Two 16 MB ranges are splittable, so Turbo would grow without the limit.
    const link = await startLinkServer({ lineBps: 16 * MB, perConnectionBps: 4 * MB, size });
    servers.push(link);
    const result = await download(link.url, 2, 16, 8 * MB);
    expect(result.bytes).toBe(size);
    expect(result.logs.some((line) => line.startsWith('Turbo'))).toBe(false);
    expect(link.stats.maxConcurrent).toBeLessThanOrEqual(2);
  }, 120_000);
});
