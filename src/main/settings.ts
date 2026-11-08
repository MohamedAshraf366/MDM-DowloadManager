import crypto from 'node:crypto';
import type { AppDatabase } from './database';
import type { AppSettings, SettingsUpdate } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { normalizeTime } from '../shared/validation';

const DEFAULT_CATEGORY_FOLDERS = { ...DEFAULT_SETTINGS.categoryFolders };

export class SettingsService {
  private settings: AppSettings;
  private proxyPassword = '';
  private bridgeToken = '';
  private listeners = new Set<(settings: AppSettings) => void>();
  private readonly fallbackDownloadDir: string;

  constructor(
    private readonly db: AppDatabase,
    defaultDownloadDir: string
  ) {
    this.fallbackDownloadDir = defaultDownloadDir;
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.settings.defaultDownloadDir = defaultDownloadDir;
  }

  initialize(): void {
    const stored = this.db.loadSettings();
    this.settings = this.mergeDefaults(stored);
    this.proxyPassword = this.readSecret('proxy.password');
    this.bridgeToken = this.readSecret('bridge.token');
    if (!this.bridgeToken) {
      this.bridgeToken = crypto.randomBytes(24).toString('base64url');
    }
    this.settings.bridgeToken = this.bridgeToken;
    this.settings.proxy.passwordSet = Boolean(this.proxyPassword);
    if (!this.settings.defaultDownloadDir) this.settings.defaultDownloadDir = this.fallbackDownloadDir;
    this.normalize();
    this.save();
  }

  get(): AppSettings {
    return { ...structuredClone(this.settings), bridgeToken: this.bridgeToken };
  }

  getProxyPassword(): string {
    return this.proxyPassword;
  }

  getBridgeToken(): string {
    return this.bridgeToken;
  }

  update(update: SettingsUpdate): AppSettings {
    if (!update || typeof update !== 'object' || !update.patch) {
      throw new Error('Invalid settings update.');
    }
    const allowed = this.pickAllowed(update.patch);
    if (allowed.proxy) {
      allowed.proxy = { ...this.settings.proxy, ...allowed.proxy, passwordSet: undefined as never };
      delete (allowed.proxy as unknown as Record<string, unknown>).passwordSet;
    }
    if (allowed.categoryFolders) {
      allowed.categoryFolders = { ...this.settings.categoryFolders, ...allowed.categoryFolders };
    }
    this.settings = this.mergeDefaults({ ...this.settings, ...allowed });
    this.settings.proxy = this.settings.proxy ?? structuredClone(DEFAULT_SETTINGS.proxy);
    this.settings.proxy.passwordSet = update.proxyPassword !== undefined ? Boolean(update.proxyPassword) : Boolean(this.proxyPassword);
    if (update.proxyPassword !== undefined) {
      this.proxyPassword = update.proxyPassword;
    }
    this.normalize();
    this.save();
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  regenerateBridgeToken(): string {
    this.bridgeToken = crypto.randomBytes(24).toString('base64url');
    this.settings.bridgeToken = this.bridgeToken;
    this.save();
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
    return this.bridgeToken;
  }

  reset(): AppSettings {
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.settings.defaultDownloadDir = this.fallbackDownloadDir;
    this.settings.bridgeToken = crypto.randomBytes(24).toString('base64url');
    this.proxyPassword = '';
    this.bridgeToken = this.settings.bridgeToken;
    this.normalize();
    this.save();
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  exportSettings(): string {
    const safe = this.get();
    safe.bridgeToken = '';
    safe.proxy = { ...safe.proxy, passwordSet: false };
    return JSON.stringify({ kind: 'mdm-settings', version: 1, exportedAt: new Date().toISOString(), settings: safe }, null, 2);
  }

  importSettings(json: string): AppSettings {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('The settings file is not valid JSON.');
    }
    const record = parsed as { kind?: string; settings?: Partial<AppSettings> };
    if (record.kind !== 'mdm-settings' || !record.settings) {
      throw new Error('This file is not an MDM settings export.');
    }
    const patch = this.pickAllowed(record.settings);
    this.update({ patch });
    return this.get();
  }

  onChanged(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readSecret(key: string): string {
    try {
      return this.db.getSetting(key)?.value ?? '';
    } catch (error) {
      console.warn(`Could not decrypt ${key}; the stored value will be reset. ${(error as Error).message}`);
      return '';
    }
  }

  private save(): void {
    const stored = this.get();
    stored.bridgeToken = '';
    stored.proxy = { ...stored.proxy, passwordSet: Boolean(this.proxyPassword) };
    this.db.saveSettings(stored);
    this.db.setSetting('bridge.token', this.bridgeToken, true);
    if (this.proxyPassword) this.db.setSetting('proxy.password', this.proxyPassword, true);
    else this.db.deleteSetting('proxy.password');
  }

  private mergeDefaults(stored: Partial<AppSettings> | null): AppSettings {
    const merged: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(stored ?? {}),
      proxy: { ...DEFAULT_SETTINGS.proxy, ...(stored?.proxy ?? {}) },
      categoryFolders: { ...DEFAULT_CATEGORY_FOLDERS, ...(stored?.categoryFolders ?? {}) }
    };
    merged.bridgeToken = this.bridgeToken;
    return merged;
  }

  private pickAllowed(patch: Partial<AppSettings>): Partial<AppSettings> {
    const result: Partial<AppSettings> = {};
    const keys: Array<keyof AppSettings> = [
      'theme',
      'speedUnit',
      'defaultDownloadDir',
      'categoryFolders',
      'categorizeByType',
      'defaultConnections',
      'maxConcurrentDownloads',
      'maxConnectionsPerHost',
      'turboMode',
      'turboMaxConnections',
      'lineSpeedMbps',
      'globalSpeedLimitBps',
      'defaultSpeedLimitBps',
      'connectTimeoutMs',
      'idleTimeoutMs',
      'maxRetries',
      'retryBaseDelayMs',
      'maxRedirects',
      'duplicatePolicy',
      'autoOpenCompleted',
      'autoResumeOnStartup',
      'launchAtStartup',
      'minimizeToTray',
      'closeToTray',
      'notificationsEnabled',
      'notifyOnStart',
      'notifyOnComplete',
      'notifyOnFailure',
      'nativeNotificationsWhenActive',
      'showProgressInTaskbar',
      'proxy',
      'ipVersion',
      'userAgentMode',
      'userAgent',
      'browserIntegrationEnabled',
      'bridgePort',
      'autoShutdownAfterQueue',
      'loggingLevel',
      'confirmDestructiveActions',
      'checksumAlgorithm',
      'showExtensionSetupOnStartup'
    ];
    for (const key of keys) {
      if (patch[key] !== undefined) {
        (result as Record<string, unknown>)[key] = patch[key];
      }
    }
    return result;
  }

  private normalize(): void {
    const s = this.settings;
    s.defaultConnections = clampInt(s.defaultConnections, 1, 32, 8);
    s.maxConcurrentDownloads = clampInt(s.maxConcurrentDownloads, 1, 20, 3);
    s.maxConnectionsPerHost = clampInt(s.maxConnectionsPerHost, 1, 64, 8);
    s.turboMode = s.turboMode === true;
    s.turboMaxConnections = clampInt(s.turboMaxConnections, 2, 64, 16);
    s.lineSpeedMbps = clampInt(s.lineSpeedMbps, 0, 100_000, 0);
    s.globalSpeedLimitBps = clampInt(s.globalSpeedLimitBps, 0, 10_000_000_000, 0);
    s.defaultSpeedLimitBps = clampInt(s.defaultSpeedLimitBps, 0, 10_000_000_000, 0);
    s.connectTimeoutMs = clampInt(s.connectTimeoutMs, 1000, 300_000, 20_000);
    s.idleTimeoutMs = clampInt(s.idleTimeoutMs, 1000, 300_000, 30_000);
    s.maxRetries = clampInt(s.maxRetries, 0, 20, 5);
    s.retryBaseDelayMs = clampInt(s.retryBaseDelayMs, 100, 60_000, 1000);
    s.maxRedirects = clampInt(s.maxRedirects, 0, 30, 10);
    s.bridgePort = clampInt(s.bridgePort, 1024, 65535, 41731);
    if (!['light', 'dark', 'system'].includes(s.theme)) s.theme = 'system';
    if (s.speedUnit !== 'bits') s.speedUnit = 'bytes';
    if (!['rename', 'overwrite', 'skip', 'allow'].includes(s.duplicatePolicy)) s.duplicatePolicy = 'rename';
    if (!['any', 'ipv4', 'ipv6'].includes(s.ipVersion)) s.ipVersion = 'any';
    if (!['error', 'warn', 'info', 'debug'].includes(s.loggingLevel)) s.loggingLevel = 'info';
    if (!['none', 'system', 'manual'].includes(s.proxy.mode)) s.proxy.mode = 'none';
    if (!['http', 'https'].includes(s.proxy.protocol)) s.proxy.protocol = 'http';
    s.proxy.port = clampInt(s.proxy.port, 1, 65535, 8080);
    s.proxy.host = String(s.proxy.host ?? '').trim().slice(0, 255);
    s.proxy.username = String(s.proxy.username ?? '').slice(0, 255);
    s.proxy.bypass = String(s.proxy.bypass ?? '').slice(0, 2000);
    s.proxy.passwordSet = Boolean(this.proxyPassword);
    s.userAgent = String(s.userAgent ?? '').slice(0, 500);
    s.userAgentMode = s.userAgentMode === 'custom' ? 'custom' : 'default';
    if (s.userAgentMode === 'custom' && !s.userAgent.trim()) s.userAgentMode = 'default';
    s.categoryFolders = { ...DEFAULT_CATEGORY_FOLDERS, ...(s.categoryFolders ?? {}) };
    for (const key of Object.keys(s.categoryFolders) as Array<keyof typeof s.categoryFolders>) {
      s.categoryFolders[key] = sanitizeFolderName(s.categoryFolders[key]);
    }
    if (!s.defaultDownloadDir) s.defaultDownloadDir = this.fallbackDownloadDir;
    s.bridgeToken = this.bridgeToken;
    s.notificationsEnabled = s.notificationsEnabled !== false;
    s.notifyOnStart = s.notifyOnStart !== false;
    s.notifyOnComplete = s.notifyOnComplete !== false;
    s.notifyOnFailure = s.notifyOnFailure !== false;
    s.nativeNotificationsWhenActive = s.nativeNotificationsWhenActive === true;
    s.checksumAlgorithm = ['md5', 'sha1', 'sha256'].includes(s.checksumAlgorithm) ? s.checksumAlgorithm : '';
    s.showExtensionSetupOnStartup = s.showExtensionSetupOnStartup !== false;
  }
}

function sanitizeFolderName(value: unknown): string {
  let result = '';
  for (const character of String(value ?? '')) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || '<>:"/\\|?*'.includes(character)) continue;
    result += character;
  }
  return result.trim().slice(0, 100);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function validateScheduleTimes(start: string, stop: string): boolean {
  return normalizeTime(start) !== null && (stop === '' || normalizeTime(stop) !== null);
}
