import { once } from 'node:events';
import fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, PlainTextSecretBox } from '../src/main/database';
import { AppLogger } from '../src/main/logger';
import { DownloadManager, type ManagerHost } from '../src/main/manager';
import { SettingsService } from '../src/main/settings';

const directories: string[] = [];
const servers: Server[] = [];
let manager: DownloadManager | null = null;
let database: AppDatabase | null = null;

afterEach(async () => {
  await manager?.shutdown().catch(() => undefined);
  manager = null;
  database?.close();
  database = null;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-batch-'));
  directories.push(directory);
  database = new AppDatabase(path.join(directory, 'mdm.db'), new PlainTextSecretBox());
  database.open();
  const settings = new SettingsService(database, path.join(directory, 'downloads'));
  settings.initialize();
  const notifications: string[] = [];
  const host: ManagerHost = {
    createSystemProxy: async () => null,
    openPath: async () => '',
    revealItem: () => undefined,
    notify: (title) => notifications.push(title),
    requestShutdown: () => undefined
  };
  manager = new DownloadManager({ db: database, settings, logger: new AppLogger(database), host });
  await manager.initialize();
  const destination = path.join(directory, 'out');
  await fsp.mkdir(destination, { recursive: true });
  return { manager, destination, notifications, settings };
}

/** A file that is only served to a request carrying the login cookie. */
async function loginServer() {
  const payload = Buffer.alloc(256 * 1024, 0x41);
  const stats = { served: 0, denied: 0 };
  const server = createServer((request, response) => {
    if (!(request.headers.cookie ?? '').includes('sid=abc')) {
      stats.denied += 1;
      response.writeHead(403, { 'Content-Type': 'text/html' });
      response.end('please log in');
      return;
    }
    stats.served += 1;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    response.end(payload);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`, stats };
}

/** A small HLS stream, so repeat is exercised for a media download too. */
async function hlsServer() {
  const segments = [Buffer.alloc(48 * 1024, 0x51), Buffer.alloc(40 * 1024, 0x52)];
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    ...segments.flatMap((_segment, index) => ['#EXTINF:4.0,', `seg${index}.ts`]),
    '#EXT-X-ENDLIST',
    ''
  ].join('\n');
  const server = createServer((request, response) => {
    if (request.url === '/hls/stream.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end(playlist);
      return;
    }
    const match = /^\/hls\/seg(\d+)\.ts$/.exec(request.url ?? '');
    const segment = match ? segments[Number(match[1])] : undefined;
    if (!segment) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': segment.length });
    response.end(segment);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hls/stream.m3u8`,
    bytes: Buffer.concat(segments)
  };
}

describe('batch repeat', () => {
  it('repeats a media download with the same quality, not just plain HTTP files', async () => {
    const { manager: m, destination, notifications } = await setup();
    const stream = await hlsServer();
    await m.addDownload({ url: stream.url, destinationDir: destination, fileName: 'clip.ts', repeatCount: 2 });
    await vi.waitFor(() => expect(notifications).toContain('Batch complete'), { timeout: 30_000, interval: 100 });

    const records = [...m.downloads.values()];
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === 'completed')).toBe(true);
    expect(records.every((record) => record.kind === 'hls')).toBe(true);
    expect((await fsp.readdir(destination)).sort()).toEqual(['clip (1).ts', 'clip.ts']);
    for (const name of ['clip.ts', 'clip (1).ts']) {
      expect((await fsp.readFile(path.join(destination, name))).equals(stream.bytes)).toBe(true);
    }
  }, 45_000);

  it('keeps the login of the first copy, so every copy is accepted, and says when the batch is done', async () => {
    const { manager: m, destination, notifications } = await setup();
    const { url, stats } = await loginServer();
    await m.addDownload({ url, destinationDir: destination, fileName: 'batch.bin', cookies: 'sid=abc', repeatCount: 3 });
    await vi.waitFor(() => expect(notifications).toContain('Batch complete'), { timeout: 20_000, interval: 100 });

    expect(stats.denied).toBe(0);
    expect(stats.served).toBeGreaterThanOrEqual(3);
    expect((await fsp.readdir(destination)).sort()).toEqual(['batch (1).bin', 'batch (2).bin', 'batch.bin']);
    const records = [...m.downloads.values()];
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.status === 'completed')).toBe(true);
    // The batch size is carried through, not replaced by what is left.
    expect(records.every((record) => record.repeatTotal === 3)).toBe(true);
    expect(notifications.filter((title) => title === 'Batch complete')).toHaveLength(1);
  }, 30_000);

  it('never queues more copies than the limit, whatever is asked for', async () => {
    const { manager: m, destination } = await setup();
    const { url } = await loginServer();
    const result = await m.addDownload({ url, destinationDir: destination, fileName: 'many.bin', startNow: false, cookies: 'sid=abc', repeatCount: 1_000_000 });
    const record = m.downloads.get(result.id);
    expect(record?.repeatCount).toBe(9999);
    expect(record?.repeatTotal).toBe(9999);
  });
});

describe('auto delete', () => {
  it('leaves no copies behind after a batch, and a deleted copy is still a completed download', async () => {
    const { manager: m, destination, notifications } = await setup();
    const { url, stats } = await loginServer();
    await m.addDownload({ url, destinationDir: destination, fileName: 'speed.bin', cookies: 'sid=abc', repeatCount: 3, autoDelete: true });
    await vi.waitFor(() => expect(notifications).toContain('Batch complete'), { timeout: 20_000, interval: 100 });
    expect(stats.served).toBeGreaterThanOrEqual(3);
    expect(await fsp.readdir(destination)).toEqual([]);
    const records = [...m.downloads.values()];
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.status === 'completed')).toBe(true);
  }, 30_000);

  it('never replaces and then deletes a file the person already has, even under the Overwrite policy', async () => {
    const { manager: m, destination, settings } = await setup();
    const { url } = await loginServer();
    settings.update({ patch: { duplicatePolicy: 'overwrite' } });
    await fsp.writeFile(path.join(destination, 'keep.bin'), 'the file that must survive');
    await m.addDownload({ url, destinationDir: destination, fileName: 'keep.bin', cookies: 'sid=abc', autoDelete: true });
    await vi.waitFor(() => expect([...m.downloads.values()][0]?.status).toBe('completed'), { timeout: 20_000, interval: 100 });
    await vi.waitFor(async () => expect((await fsp.readdir(destination)).sort()).toEqual(['keep.bin']), { timeout: 5_000, interval: 100 });
    expect(await fsp.readFile(path.join(destination, 'keep.bin'), 'utf8')).toBe('the file that must survive');
  }, 30_000);
});

describe('adding a download without starting it', () => {
  it('holds it paused, and nothing is fetched until the person starts it', async () => {
    const { manager: m, destination } = await setup();
    const { url, stats } = await loginServer();
    const result = await m.addDownload({ url, destinationDir: destination, fileName: 'held.bin', cookies: 'sid=abc', startNow: false });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(m.downloads.get(result.id)?.status).toBe('paused');
    expect(stats.served + stats.denied).toBe(0);
  });
});
