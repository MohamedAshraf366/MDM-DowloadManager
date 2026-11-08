import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, type SecretBox } from '../src/main/database';
import { SettingsService } from '../src/main/settings';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

const directories: string[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

const failingCipher: SecretBox = {
  encrypt(value: string): string {
    return `enc:${Buffer.from(value, 'utf8').toString('base64')}`;
  },
  decrypt(value: string): string {
    if (value.startsWith('enc:')) throw new Error('decryption failed');
    return value;
  }
};

describe('settings startup recovery', () => {
  it('regenerates secrets when stored values cannot be decrypted', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-settings-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'mdm.db'), failingCipher);
    db.open();
    try {
      db.setSetting('bridge.token', 'legacy-token', true);
      db.setSetting('proxy.password', 'legacy-password', true);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const settings = new SettingsService(db, path.join(directory, 'downloads'));
      expect(() => settings.initialize()).not.toThrow();

      expect(settings.getProxyPassword()).toBe('');
      expect(settings.get().proxy.passwordSet).toBe(false);
      expect(settings.getBridgeToken()).not.toBe('legacy-token');
      expect(settings.getBridgeToken().length).toBeGreaterThan(20);
      expect(settings.get().bridgeToken).toBe(settings.getBridgeToken());
    } finally {
      db.close();
    }
  });
});

describe('Turbo settings', () => {
  const plainCipher: SecretBox = { encrypt: (value) => value, decrypt: (value) => value };

  async function service() {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-turbo-settings-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'mdm.db'), plainCipher);
    db.open();
    databases.push(db);
    const settings = new SettingsService(db, path.join(directory, 'downloads'));
    settings.initialize();
    return settings;
  }

  it('starts from the shipped defaults, with a ceiling the engine accepts', async () => {
    const settings = await service();
    expect(settings.get().turboMode).toBe(DEFAULT_SETTINGS.turboMode);
    expect(settings.get().turboMaxConnections).toBe(DEFAULT_SETTINGS.turboMaxConnections);
    expect(DEFAULT_SETTINGS.turboMaxConnections).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_SETTINGS.turboMaxConnections).toBeLessThanOrEqual(64);
  });

  it('keeps the ceiling within what the engine and servers can reasonably take', async () => {
    const settings = await service();
    settings.update({ patch: { turboMode: true, turboMaxConnections: 5000 } });
    expect(settings.get().turboMode).toBe(true);
    expect(settings.get().turboMaxConnections).toBe(64);
    settings.update({ patch: { turboMaxConnections: 0 } });
    expect(settings.get().turboMaxConnections).toBe(2);
  });

  it('treats anything other than true as off', async () => {
    const settings = await service();
    settings.update({ patch: { turboMode: 'yes' as unknown as boolean } });
    expect(settings.get().turboMode).toBe(false);
  });
});

describe('speed unit setting', () => {
  it('defaults to bytes and accepts only bytes or bits', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-unit-settings-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'mdm.db'), { encrypt: (value) => value, decrypt: (value) => value });
    db.open();
    databases.push(db);
    const settings = new SettingsService(db, path.join(directory, 'downloads'));
    settings.initialize();
    expect(settings.get().speedUnit).toBe('bytes');
    settings.update({ patch: { speedUnit: 'bits' } });
    expect(settings.get().speedUnit).toBe('bits');
    settings.update({ patch: { speedUnit: 'furlongs' as unknown as 'bits' } });
    expect(settings.get().speedUnit).toBe('bytes');
  });
});

describe('line speed setting', () => {
  it('is off by default and kept within a sane range', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-line-settings-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'mdm.db'), { encrypt: (value) => value, decrypt: (value) => value });
    db.open();
    databases.push(db);
    const settings = new SettingsService(db, path.join(directory, 'downloads'));
    settings.initialize();
    expect(settings.get().lineSpeedMbps).toBe(0);
    settings.update({ patch: { lineSpeedMbps: 32 } });
    expect(settings.get().lineSpeedMbps).toBe(32);
    settings.update({ patch: { lineSpeedMbps: -5 } });
    expect(settings.get().lineSpeedMbps).toBe(0);
    settings.update({ patch: { lineSpeedMbps: 10_000_000 } });
    expect(settings.get().lineSpeedMbps).toBe(100_000);
  });
});
