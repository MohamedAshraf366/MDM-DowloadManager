import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AddDownloadRequest,
  AddDownloadResult,
  AppSettings,
  CategoryRule,
  ChecksumAlgorithm,
  DownloadLifecycleEvent,
  DownloadLifecycleState,
  DownloadPriority,
  DownloadProgressEvent,
  DownloadRecord,
  DownloadStatus,
  FileCategory,
  ImportExportBundle,
  MediaFormat,
  MediaProbeResult,
  QueueInput,
  QueueRecord,
  RuleInput,
  ScheduleInput,
  ScheduleRecord,
  SiteRule,
  SiteRuleInput,
  Snapshot,
  Stats,
  UpdateDownloadOptions
} from '../shared/types';
import {
  allowedUrl,
  categoryFromFileName,
  deriveFileNameFromUrl,
  extensionFromFileName,
  extensionFromMime,
  fileTypeAllowed,
  hostnameFromUrl,
  isReasonableUrlLength,
  isYouTubeUrl,
  redactUrl,
  sanitizeCookies,
  sanitizeFileName,
  sanitizeHeaders,
  validateChecksum,
  wildcardHostMatch
} from '../shared/validation';
import { APP_SHORT_NAME, APP_VERSION, PROGRESS_INTERVAL_MS } from '../shared/defaults';
import type { AppDatabase } from './database';
import type { SettingsService } from './settings';
import type { AppLogger } from './logger';
import {
  HttpClient,
  type ResolvedProxy,
  setDirectAgentMaxSockets
} from '../engine/http-client';
import { HostLimiter, TokenBucket } from '../engine/rate-limiter';
import { DownloadError, friendlyErrorMessage, mapNetworkError } from '../engine/errors';
import { HttpDownloadTask } from '../engine/http-download';
import { FtpDownloadTask } from '../engine/ftp';
import { MediaDownloadTask, probeMedia } from '../engine/media';
import { probeYtDlpPage, probeYouTube, YtDlpDownloadTask } from '../engine/youtube';
import { hashFile } from '../engine/checksum';
import type {
  DownloadConfig,
  EngineCallbacks,
  EngineCheckpoint,
  EngineOutcome,
  EngineRuntime,
  PreparedDownload,
  ProgressState
} from '../engine/types';
import type { MediaProbeResult as ProbeResult } from '../shared/types';

interface RunningTask {
  pause: () => void;
  cancel: () => void;
  run: () => Promise<EngineOutcome>;
}

export interface ManagerHost {
  createSystemProxy(url: string): Promise<ResolvedProxy | null>;
  openPath(target: string): Promise<string>;
  revealItem(target: string): void;
  notify(title: string, body: string, downloadId?: string): void;
  requestShutdown(queue: QueueRecord): void;
}

export interface ManagerOptions {
  db: AppDatabase;
  settings: SettingsService;
  logger: AppLogger;
  host: ManagerHost;
  ytDlpPath?: string;
  ffmpegPath?: string;
  jsRuntimePath?: string;
}

interface QueueCompletionState {
  hadActivity: boolean;
}

/** Matches the limit in the Add download dialogs. */
const MAX_REPEAT_COUNT = 9999;

export class DownloadManager extends EventEmitter {
  private readonly db: AppDatabase;
  private readonly settingsService: SettingsService;
  private readonly logger: AppLogger;
  private readonly host: ManagerHost;
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly activeTasks = new Map<string, RunningTask>();
  private readonly activeIds = new Set<string>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly preparingControls = new Map<string, 'pause' | 'cancel' | 'remove' | 'restart'>();
  private readonly restartRequested = new Set<string>();
  private readonly removeRequested = new Set<string>();
  /**
   * Batch repeat: the name each copy was asked for. Copies are renamed ("name (1)")
   * when they finish, so asking for the next copy under the finished name would
   * stack suffixes: "name (1) (1) (1)...", which grows past the path limit.
   */
  private readonly repeatBaseNames = new Map<string, string>();
  private readonly pausedBySchedule = new Set<string>();
  private readonly probeCache = new Map<string, { at: number; result: MediaProbeResult }>();
  private readonly reservations = new Set<string>();
  private readonly reservedByDownload = new Map<string, string>();
  private readonly queueActivity = new Map<string, QueueCompletionState>();
  private readonly lifecycleStates = new Map<string, DownloadLifecycleState>();
  private readonly startNotifications = new Set<string>();
  private readonly ytDlpPath: string;
  private readonly ffmpegPath: string;
  private readonly jsRuntimePath: string;
  private readonly globalLimiter: TokenBucket;
  private readonly hostLimiter: HostLimiter;
  private pumpQueued = false;
  private shutdownRequested = false;
  private shuttingDown = false;
  private queueLimits = new Map<string, QueueRecord>();

  constructor(options: ManagerOptions) {
    super();
    this.db = options.db;
    this.settingsService = options.settings;
    this.logger = options.logger;
    this.host = options.host;
    this.ytDlpPath = options.ytDlpPath ?? '';
    this.ffmpegPath = options.ffmpegPath ?? '';
    this.jsRuntimePath = options.jsRuntimePath ?? '';
    const settings = this.settingsService.get();
    this.globalLimiter = new TokenBucket(settings.globalSpeedLimitBps);
    this.hostLimiter = new HostLimiter(settings.maxConnectionsPerHost);
    this.settingsService.onChanged((next) => this.handleSettingsChanged(next));
  }

  async initialize(): Promise<void> {
    const interrupted = this.db.recoverInterrupted();
    if (interrupted > 0) {
      this.logger.info('downloads', `${interrupted} download(s) were interrupted by the previous shutdown.`);
    }
    for (const record of this.db.listDownloads()) {
      this.downloads.set(record.id, record);
    }
    const settings = this.settingsService.get();
    if (settings.autoResumeOnStartup) {
      for (const record of this.downloads.values()) {
        if (record.status === 'paused' && record.errorCode === 'INTERRUPTED') {
          this.setStatus(record, 'queued');
          record.error = '';
          record.errorCode = '';
          this.persist(record);
        }
      }
    }
    this.processDueScheduled();
    this.schedulePump();
    this.emitChanged();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const task of this.activeTasks.values()) {
      try {
        task.pause();
      } catch {
        // Best effort.
      }
    }
    if (!this.activeRuns.size) return;
    const pending = Promise.allSettled(Array.from(this.activeRuns)).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn('downloads', 'Some downloads did not stop in time during shutdown.');
        resolve();
      }, 12_000);
      timer.unref?.();
    });
    await Promise.race([pending, timeout]);
    if (timer) clearTimeout(timer);
  }

  getRecords(): DownloadRecord[] {
    return Array.from(this.downloads.values()).sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
  }

  getActiveRecords(): DownloadRecord[] {
    return Array.from(this.downloads.values()).filter((record) =>
      ['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)
    );
  }

  getRecord(id: string): DownloadRecord | undefined {
    return this.downloads.get(id);
  }

  getSnapshot(): Snapshot {
    const records = this.getRecords();
    const settings = this.settingsService.get();
    return {
      downloads: records,
      queues: this.db.listQueues(),
      schedules: this.db.listSchedules(),
      rules: this.db.listRules(),
      siteRules: this.db.listSiteRules(),
      settings,
      stats: this.computeStats(records),
      version: APP_VERSION,
      bridge: { enabled: settings.browserIntegrationEnabled, port: settings.bridgePort, token: this.settingsService.getBridgeToken() }
    };
  }

  private computeStats(records: DownloadRecord[]): Stats {
    const stats: Stats = { active: 0, queued: 0, completed: 0, failed: 0, totalBytes: 0, totalDownloaded: 0, currentSpeed: 0 };
    for (const record of records) {
      if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) stats.active++;
      if (['queued', 'scheduled'].includes(record.status)) stats.queued++;
      if (record.status === 'completed') stats.completed++;
      if (record.status === 'failed') stats.failed++;
      stats.totalBytes += record.totalBytes ?? 0;
      stats.totalDownloaded += record.downloadedBytes;
      stats.currentSpeed += record.speedBps || 0;
    }
    return stats;
  }

  async addDownload(request: AddDownloadRequest): Promise<AddDownloadResult> {
    if (!request || typeof request.url !== 'string' || !isReasonableUrlLength(request.url)) {
      throw new Error('A valid URL is required.');
    }
    const settings = this.settingsService.get();
    let normalized = request.url.trim();
    if (!allowedUrl(normalized)) throw new Error('Only http, https, and ftp URLs are supported.');
    const headers = sanitizeHeaders(request.headers);
    const credentials = extractUrlCredentials(normalized);
    if (credentials) {
      normalized = credentials.url;
      if (!headers.Authorization && !headers.authorization) headers.Authorization = credentials.authorization;
    }
    // Duplicate URLs are always allowed: the same file can be queued many times
    // (batch repeat, simultaneous copies). The file-conflict policy decides
    // whether each copy gets a "name (1)", overwrites, or is skipped.

    let kind: DownloadRecord['kind'] = normalized.startsWith('ftp:') ? 'ftp' : 'http';
    let mediaFormat: MediaFormat | null = null;
    let mediaProbe: ProbeResult | null = null;
    let mediaFormatJson = '';
    let fileName = request.fileName ? sanitizeFileName(request.fileName) : '';
    let mimeType = '';
    const lowerUrl = normalized.toLowerCase().split(/[?#]/)[0] ?? '';
    const forceYtDlp = request.mediaEngine === 'yt-dlp' || Boolean(request.mediaFormatId?.startsWith('youtube:'));
    const ytDlpSource = forceYtDlp || isYouTubeUrl(normalized);
    const manifestLike =
      lowerUrl.endsWith('.m3u8') ||
      lowerUrl.endsWith('.m3u') ||
      lowerUrl.endsWith('.mpd') ||
      /\/master\.txt$/.test(lowerUrl) ||
      /\.urlset\//.test(lowerUrl);
    const manifestCandidate = manifestLike || lowerUrl.endsWith('.txt') || !/\.[a-z0-9]{1,8}(?:$|\?)/i.test(lowerUrl.split('/').pop() ?? '');
    if (request.mediaFormatId || ytDlpSource || manifestLike) {
      mediaProbe = await this.probeMediaInternal(normalized, headers, request.cookies ?? '', request.referrer ?? '', forceYtDlp, Boolean(request.tlsAllowInsecure));
      if (mediaProbe.error) throw new Error(mediaProbe.error);
      if (!mediaProbe.formats.length) throw new Error('No downloadable media formats were found.');
      mediaFormat = request.mediaFormatId
        ? mediaProbe.formats.find((format) => format.id === request.mediaFormatId) ?? null
        : pickBestFormat(mediaProbe.formats);
      if (!mediaFormat) throw new Error('The selected media format is no longer available.');
      if (mediaFormat.protected) throw new Error('This media is protected and cannot be downloaded.');
      kind = mediaFormat.type;
      mediaFormatJson = JSON.stringify(mediaFormat);
      if (!fileName) {
        const suggested = sanitizeFileName(mediaProbe.suggestedFileName || deriveFileNameFromUrl(normalized, 'media-download'));
        const ext = formatExtension(mediaFormat);
        fileName = /\.[a-z0-9]{2,10}$/i.test(suggested) ? suggested.replace(/\.[a-z0-9]{2,10}$/i, ext) : `${suggested}${ext}`;
      }
      mimeType = mediaFormat.mimeType;
    } else if (manifestCandidate) {
      // Ambiguous extension (e.g. .txt HLS masters, extensionless media):
      // probe softly and fall back to a plain download when it is not a manifest.
      try {
        mediaProbe = await this.probeMediaInternal(normalized, headers, request.cookies ?? '', request.referrer ?? '', false, Boolean(request.tlsAllowInsecure));
        if (!mediaProbe.error && mediaProbe.formats.length) {
          mediaFormat = request.mediaFormatId
            ? mediaProbe.formats.find((format) => format.id === request.mediaFormatId) ?? pickBestFormat(mediaProbe.formats)
            : pickBestFormat(mediaProbe.formats);
          if (mediaFormat && !mediaFormat.protected) {
            kind = mediaFormat.type;
            mediaFormatJson = JSON.stringify(mediaFormat);
            if (!fileName) {
              const suggested = sanitizeFileName(mediaProbe.suggestedFileName || deriveFileNameFromUrl(normalized, 'media-download'));
              const ext = formatExtension(mediaFormat);
              fileName = /\.[a-z0-9]{2,10}$/i.test(suggested) ? suggested.replace(/\.[a-z0-9]{2,10}$/i, ext) : `${suggested}${ext}`;
            }
            mimeType = mediaFormat.mimeType;
          } else {
            mediaProbe = null;
          }
        } else {
          mediaProbe = null;
        }
      } catch {
        mediaProbe = null;
      }
    }

    if (!fileName) fileName = sanitizeFileName(deriveFileNameFromUrl(normalized, 'download'));
    if (!extensionFromFileName(fileName) && mimeType) {
      const ext = extensionFromMime(mimeType);
      if (ext) fileName = `${fileName}.${ext}`;
    }
    const category = categoryFromFileName(fileName);
    let destinationDir: string;
    let destinationExplicit = false;
    if (request.destinationDir) {
      destinationDir = path.resolve(request.destinationDir);
      destinationExplicit = true;
    } else {
      destinationDir = this.categoryDirectory(fileName, mimeType, normalized).directory;
    }
    await fsp.mkdir(destinationDir, { recursive: true }).catch((error) => {
      throw new Error(`The download folder could not be created: ${(error as Error).message}`);
    });
    const queues = this.db.listQueues();
    const queueId = request.queueId && queues.some((queue) => queue.id === request.queueId) ? request.queueId : 'default';
    const now = new Date().toISOString();
    const connections = clampInt(request.connections ?? settings.defaultConnections, 1, 64);
    const speedLimit = clampInt(request.speedLimitBps ?? (request.speedLimitBps === 0 ? 0 : settings.defaultSpeedLimitBps), 0, 10_000_000_000);
    const checksumAlgorithm: ChecksumAlgorithm | '' = request.checksumAlgorithm ?? settings.checksumAlgorithm;
    const checksum = (request.checksum ?? '').trim();
    if (checksum && !checksumAlgorithm) throw new Error('Choose a checksum algorithm before providing a checksum.');
    if (checksum && !validateChecksum(checksum, checksumAlgorithm as ChecksumAlgorithm)) {
      throw new Error('The checksum is not valid for the selected algorithm.');
    }
    const scheduledAt = request.scheduledAt ? new Date(request.scheduledAt) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw new Error('The scheduled time is not valid.');
    let status: DownloadStatus = 'queued';
    if (scheduledAt && scheduledAt.getTime() > Date.now()) status = 'scheduled';
    else if (request.startNow === false) status = 'paused';

    const record: DownloadRecord = {
      id: crypto.randomUUID(),
      kind,
      url: normalized,
      finalUrl: null,
      fileName,
      fileNameExplicit: Boolean(request.fileName),
      destinationDir,
      destinationExplicit,
      targetPath: null,
      tempPath: null,
      category,
      queueId,
      status,
      priority: request.priority ?? 'normal',
      totalBytes: null,
      downloadedBytes: 0,
      resumable: true,
      connections,
      turboMode: request.turboMode ?? settings.turboMode,
      repeatCount: clampInt(request.repeatCount ?? 1, 1, MAX_REPEAT_COUNT),
      repeatTotal: clampInt(request.repeatTotal ?? request.repeatCount ?? 1, 1, MAX_REPEAT_COUNT),
      speedLimitBps: speedLimit,
      headers,
      cookies: sanitizeCookies(request.cookies ?? ''),
      referrer: request.referrer ?? '',
      mimeType,
      etag: '',
      lastModified: '',
      checksum,
      checksumAlgorithm,
      checksumStatus: checksum ? 'pending' : 'none',
      error: '',
      errorCode: '',
      retryCount: 0,
      maxRetries: settings.maxRetries,
      speedBps: 0,
      etaSeconds: null,
      segments: [],
      scheduledAt: scheduledAt?.toISOString() ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      autoOpen: Boolean(request.autoOpen),
      autoDelete: Boolean(request.autoDelete),
      tlsAllowInsecure: Boolean(request.tlsAllowInsecure),
      mediaFormatJson,
      mediaState: '',
      sourcePageUrl: request.sourcePageUrl ?? '',
      recordLog: []
    };
    this.db.insertDownload(record);
    if ((record.repeatCount ?? 1) > 1 && record.fileNameExplicit) this.repeatBaseNames.set(record.id, record.fileName);
    this.downloads.set(record.id, record);
    this.logger.info(
      'downloads',
      `Added ${redactUrl(normalized)} to ${queues.find((queue) => queue.id === queueId)?.name ?? 'queue'}`
    );
    this.emit('updated', record);
    this.emitLifecycle(record, 'queued');
    this.emitChanged();
    this.schedulePump();
    return { id: record.id };
  }

  async probeMedia(
    url: string,
    headers?: Record<string, string>,
    cookies?: string,
    referrer = '',
    mediaEngine?: 'yt-dlp',
    tlsAllowInsecure = false
  ): Promise<MediaProbeResult> {
    if (!allowedUrl(url) || !url.startsWith('http')) throw new Error('Enter a valid HTTP or HTTPS media URL.');
    return this.probeMediaInternal(
      url,
      sanitizeHeaders(headers),
      sanitizeCookies(cookies ?? ''),
      referrer,
      mediaEngine === 'yt-dlp',
      tlsAllowInsecure
    );
  }

  private async probeMediaInternal(
    url: string,
    headers: Record<string, string>,
    cookies: string,
    referrer = '',
    forceYtDlp = false,
    tlsAllowInsecure = false
  ): Promise<MediaProbeResult> {
    const requestHeaders = { ...headers };
    const hasReferer = Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'referer');
    if (referrer && !hasReferer) requestHeaders.Referer = referrer;
    const cacheKey = crypto
      .createHash('sha256')
      .update(url)
      .update('\0')
      .update(cookies)
      .update('\0')
      .update(JSON.stringify(Object.entries(requestHeaders).sort(([left], [right]) => left.localeCompare(right))))
      .update('\0')
      .update(forceYtDlp ? 'yt-dlp' : 'auto')
      .update('\0')
      .update(tlsAllowInsecure ? 'insecure' : 'secure')
      .digest('hex');
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.result;
    const settings = this.settingsService.get();
    const proxy = await this.resolveProxy(url);
    const http = this.createHttpClient(settings, proxy, undefined, undefined, tlsAllowInsecure);
    const runtime = this.runtimeBase(http);
    let result: MediaProbeResult;
    if (isYouTubeUrl(url)) {
      result = await probeYouTube(url, runtime, requestHeaders, cookies);
    } else if (forceYtDlp) {
      try {
        result = await probeYtDlpPage(url, runtime, requestHeaders, cookies);
        if (result.error || !result.formats.length) {
          const fallback = await this.probePageHtmlFallback(
            url,
            http,
            requestHeaders,
            cookies,
            referrer,
            runtime
          );
          if (fallback) result = fallback;
        }
      } catch (error) {
        const fallback = await this.probePageHtmlFallback(
          url,
          http,
          requestHeaders,
          cookies,
          referrer,
          runtime
        );
        if (!fallback) throw error;
        result = fallback;
      }
    } else {
      result = await probeMedia(url, runtime, requestHeaders, cookies);
    }
    if (!result.error) {
      if (this.probeCache.size >= 20) {
        const oldest = this.probeCache.keys().next().value;
        if (oldest) this.probeCache.delete(oldest);
      }
      this.probeCache.set(cacheKey, { at: Date.now(), result });
    }
    return result;
  }

  /**
   * Last-resort extractor for pages yt-dlp cannot parse. It reads the page
   * HTML, follows embedded player pages one level deep, and probes any HLS or
   * DASH URLs it finds.
   */
  private async probePageHtmlFallback(
    pageUrl: string,
    http: HttpClient,
    headers: Record<string, string>,
    cookies: string,
    referrer: string,
    runtime: EngineRuntime
  ): Promise<MediaProbeResult | null> {
    const requestHeaders: Record<string, string> = {
      ...headers,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
    };
    if (cookies) requestHeaders.Cookie = cookies;
    if (referrer && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'referer')) {
      requestHeaders.Referer = referrer;
    }
    const fetchPage = async (target: string): Promise<{ html: string; url: string } | null> => {
      try {
        const response = await http.fetchBuffer(
          target,
          { headers: requestHeaders },
          4 * 1024 * 1024
        );
        if (response.status < 200 || response.status >= 300) return null;
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
        if (contentType && !/text\/html|application\/xhtml|text\/plain/.test(contentType)) return null;
        return { html: response.buffer.toString('utf8'), url: response.url };
      } catch {
        return null;
      }
    };
    const probeCandidates = async (
      page: { html: string; url: string },
      depth: number
    ): Promise<MediaProbeResult | null> => {
      const candidates = extractPageCandidates(page.html, page.url);
      for (const manifest of candidates.manifests.slice(0, 8)) {
        try {
          const probe = await probeMedia(manifest, runtime, requestHeaders, cookies);
          if (!probe.error && probe.formats.length) return probe;
        } catch {
          /* Try the next candidate. */
        }
      }
      if (depth === 0) {
        for (const embedded of candidates.pages.slice(0, 4)) {
          try {
            const probe = await probeYtDlpPage(embedded, runtime, requestHeaders, cookies);
            if (!probe.error && probe.formats.length) return probe;
          } catch {
            /* Try the embedded page HTML directly. */
          }
          const child = await fetchPage(embedded);
          if (!child) continue;
          const nested = await probeCandidates(child, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    };
    const page = await fetchPage(pageUrl);
    if (!page) return null;
    return probeCandidates(page, 0);
  }

  private runtimeBase(http: HttpClient): EngineRuntime {
    return {
      http,
      hostLimiter: this.hostLimiter,
      globalLimiter: this.globalLimiter,
      logger: (level, message, detail) => this.logger[level === 'debug' ? 'debug' : level]('engine', message, detail),
      reservedTargetPaths: this.reservations,
      ytDlpPath: this.ytDlpPath || undefined,
      ffmpegPath: this.ffmpegPath || undefined,
      jsRuntimePath: this.jsRuntimePath || undefined
    };
  }

  updateDownload(id: string, update: UpdateDownloadOptions): DownloadRecord {
    const record = this.requireRecord(id);
    if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) {
      throw new Error('Pause the download before editing it.');
    }
    if (record.status === 'completed') throw new Error('Completed downloads cannot be edited. Rename the file on disk instead.');
    if (update.url !== undefined) {
      const sanitized = update.url.trim();
      if (!allowedUrl(sanitized)) throw new Error('Only http, https, and ftp URLs are supported.');
      if (record.kind === 'hls' || record.kind === 'dash' || record.kind === 'youtube') {
        throw new Error('Media stream URLs cannot be edited.');
      }
      const credentials = extractUrlCredentials(sanitized);
      if (credentials) {
        record.url = credentials.url;
        record.headers = { ...record.headers, Authorization: credentials.authorization };
      } else {
        record.url = sanitized;
      }
      record.kind = record.url.startsWith('ftp:') ? 'ftp' : 'http';
      this.clearResumeArtifacts(record);
    }
    if (update.fileName !== undefined) {
      const name = sanitizeFileName(update.fileName);
      if (!name) throw new Error('A file name is required.');
      if (name !== record.fileName) {
        record.fileName = name;
        record.fileNameExplicit = true;
        record.category = categoryFromFileName(name);
        this.discardTemp(record);
        record.tempPath = null;
        record.targetPath = null;
        record.segments = [];
        record.downloadedBytes = 0;
        record.totalBytes = null;
        record.mediaState = '';
      }
    }
    if (update.destinationDir !== undefined) {
      const destination = path.resolve(update.destinationDir);
      if (destination !== record.destinationDir) {
        this.discardTemp(record);
        record.destinationDir = destination;
        record.destinationExplicit = true;
        record.tempPath = null;
        record.targetPath = null;
        record.segments = [];
        record.downloadedBytes = 0;
        record.mediaState = '';
      }
    }
    if (update.speedLimitBps !== undefined) record.speedLimitBps = clampInt(update.speedLimitBps, 0, 10_000_000_000);
    if (update.headers !== undefined) record.headers = sanitizeHeaders(update.headers);
    if (update.cookies !== undefined) record.cookies = sanitizeCookies(update.cookies);
    if (update.referrer !== undefined) record.referrer = update.referrer;
    if (update.checksum !== undefined) record.checksum = update.checksum.trim();
    if (update.checksumAlgorithm !== undefined) record.checksumAlgorithm = update.checksumAlgorithm;
    if (update.autoOpen !== undefined) record.autoOpen = update.autoOpen;
    if (update.autoDelete !== undefined) record.autoDelete = update.autoDelete;
    if (record.checksum && !record.checksumAlgorithm) throw new Error('Choose a checksum algorithm for the checksum.');
    if (record.checksum && record.checksumAlgorithm && !validateChecksum(record.checksum, record.checksumAlgorithm)) {
      throw new Error('The checksum is not valid for the selected algorithm.');
    }
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    return record;
  }

  pauseDownload(id: string): void {
    const record = this.requireRecord(id);
    if (['queued', 'scheduled'].includes(record.status)) {
      this.setStatus(record, 'paused');
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
      return;
    }
    if (['verifying', 'finalizing'].includes(record.status)) throw new Error('This download is finishing and cannot be paused.');
    const task = this.activeTasks.get(id);
    if (task) {
      this.setStatus(record, 'paused');
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
      task.pause();
    } else if (this.activeIds.has(id)) {
      this.preparingControls.set(id, 'pause');
      this.setStatus(record, 'paused');
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
    } else if (record.status === 'paused') {
      return;
    } else if (record.status === 'failed') {
      this.setStatus(record, 'paused');
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
    }
  }

  resumeDownload(id: string): void {
    const record = this.requireRecord(id);
    if (['queued', 'connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) return;
    if (record.status === 'completed') throw new Error('This download is already complete.');
    this.setStatus(record, 'queued');
    record.error = '';
    record.errorCode = '';
    record.speedBps = 0;
    record.etaSeconds = null;
    this.pausedBySchedule.delete(id);
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    this.schedulePump();
  }

  cancelDownload(id: string): void {
    const record = this.requireRecord(id);
    if (['completed', 'canceled'].includes(record.status)) return;
    if (['verifying', 'finalizing'].includes(record.status)) throw new Error('This download is finishing and cannot be canceled.');
    const task = this.activeTasks.get(id);
    if (task) {
      this.setStatus(record, 'canceled');
      record.error = 'Canceled by user.';
      record.errorCode = 'CANCELED';
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
      task.cancel();
    } else if (this.activeIds.has(id)) {
      this.preparingControls.set(id, 'cancel');
      this.setStatus(record, 'canceled');
      record.error = 'Canceled by user.';
      record.errorCode = 'CANCELED';
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
    } else {
      this.setStatus(record, 'canceled');
      record.error = 'Canceled by user.';
      record.errorCode = 'CANCELED';
      record.downloadedBytes = 0;
      record.segments = [];
      this.discardTemp(record);
      record.tempPath = null;
      record.mediaState = '';
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
      if (record.targetPath && !record.completedAt) void fsp.rm(record.targetPath, { force: true }).catch(() => undefined);
    }
    this.emitLifecycle(record, 'cancelled');
  }

  retryDownload(id: string): void {
    const record = this.requireRecord(id);
    if (record.status !== 'failed' && record.status !== 'canceled') {
      throw new Error('Only failed or canceled downloads can be retried.');
    }
    this.setStatus(record, 'queued');
    record.error = '';
    record.errorCode = '';
    record.checksumStatus = record.checksum ? 'pending' : 'none';
    record.retryCount += 1;
    record.speedBps = 0;
    record.etaSeconds = null;
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    this.schedulePump();
  }

  restartDownload(id: string): void {
    const record = this.requireRecord(id);
    if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) {
      this.restartRequested.add(id);
      const task = this.activeTasks.get(id);
      if (task) task.cancel();
      else if (this.activeIds.has(id)) this.preparingControls.set(id, 'restart');
      return;
    }
    this.resetForRestart(record);
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    this.schedulePump();
  }

  private resetForRestart(record: DownloadRecord): void {
    this.setStatus(record, 'queued');
    this.discardTemp(record);
    if (record.targetPath && !record.completedAt) void fsp.rm(record.targetPath, { force: true }).catch(() => undefined);
    this.releaseReservation(record.id);
    record.tempPath = null;
    record.targetPath = null;
    record.segments = [];
    record.downloadedBytes = 0;
    record.totalBytes = null;
    record.etag = '';
    record.lastModified = '';
    record.mediaState = '';
    record.error = '';
    record.errorCode = '';
    record.checksumStatus = record.checksum ? 'pending' : 'none';
    record.completedAt = null;
    record.startedAt = null;
    record.speedBps = 0;
    record.etaSeconds = null;
  }

  async removeDownload(id: string, deleteFile: boolean): Promise<void> {
    const record = this.requireRecord(id);
    if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) {
      this.removeRequested.add(id);
      if (deleteFile) this.removeRequested.add(`${id}:file`);
      const task = this.activeTasks.get(id);
      if (task) task.cancel();
      else if (this.activeIds.has(id)) this.preparingControls.set(id, 'remove');
      return;
    }
    await this.finalizeRemoval(record, deleteFile);
  }

  private async finalizeRemoval(record: DownloadRecord, deleteFile: boolean): Promise<void> {
    if (deleteFile && record.targetPath) {
      await fsp.rm(record.targetPath, { force: true }).catch(() => undefined);
    }
    await this.removeTempArtifacts(record);
    this.db.deleteDownload(record.id);
    this.downloads.delete(record.id);
    this.releaseReservation(record.id);
    this.emitChanged();
  }

  pauseAll(): void {
    for (const record of this.downloads.values()) {
      if (['queued', 'scheduled'].includes(record.status)) {
        this.setStatus(record, 'paused');
        this.persist(record);
      }
    }
    for (const id of this.activeIds) {
      try {
        this.pauseDownload(id);
      } catch {
        // Ignore items that are finishing.
      }
    }
    this.emitChanged();
  }

  resumeAll(): void {
    for (const queue of this.db.listQueues()) {
      if (queue.status !== 'active') this.startQueue(queue.id);
    }
    for (const record of this.downloads.values()) {
      if (record.status === 'paused') {
        this.setStatus(record, 'queued');
        record.error = '';
        record.errorCode = '';
        this.persist(record);
      }
    }
    this.emitChanged();
    this.schedulePump();
  }

  clearCompleted(): void {
    this.db.deleteCompletedDownloads();
    for (const record of Array.from(this.downloads.values())) {
      if (record.status === 'completed' || record.status === 'canceled') this.downloads.delete(record.id);
    }
    this.emitChanged();
  }

  setPriority(id: string, priority: DownloadPriority): void {
    const record = this.requireRecord(id);
    if (!['low', 'normal', 'high'].includes(priority)) throw new Error('Invalid priority.');
    record.priority = priority;
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    this.schedulePump();
  }

  moveToQueue(ids: string[], queueId: string): void {
    if (!this.db.getQueue(queueId)) throw new Error('Queue not found.');
    for (const id of ids) {
      const record = this.downloads.get(id);
      if (!record) continue;
      if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) continue;
      record.queueId = queueId;
      record.updatedAt = new Date().toISOString();
      this.persist(record);
    }
    this.emitChanged();
    this.schedulePump();
  }

  async verifyDownload(id: string): Promise<DownloadRecord> {
    const record = this.requireRecord(id);
    if (record.status !== 'completed' || !record.targetPath) throw new Error('Only completed downloads can be verified.');
    const algorithm = record.checksumAlgorithm || 'sha256';
    this.logger.info('downloads', `Verifying ${record.fileName} with ${algorithm}.`);
    const actual = await hashFile(record.targetPath, algorithm);
    if (record.checksum) {
      const matches = actual.toLowerCase() === record.checksum.toLowerCase();
      record.checksumStatus = matches ? 'verified' : 'mismatch';
      if (!matches) record.error = 'Integrity verification failed.';
    } else {
      record.checksum = actual;
      record.checksumAlgorithm = algorithm;
      record.checksumStatus = 'verified';
    }
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    return record;
  }

  async openFile(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.status !== 'completed' || !record.targetPath) throw new Error('The file is not ready.');
    const error = await this.host.openPath(record.targetPath);
    if (error) throw new Error(error);
  }

  revealFile(id: string): void {
    const record = this.requireRecord(id);
    if (!record.targetPath) throw new Error('The file is not ready.');
    this.host.revealItem(record.targetPath);
  }

  revealFolder(id: string): void {
    const record = this.requireRecord(id);
    const folder = record.targetPath ? path.dirname(record.targetPath) : record.destinationDir;
    this.host.revealItem(folder);
  }

  saveQueue(input: QueueInput): QueueRecord {
    const timestamp = new Date().toISOString();
    if (!input.name?.trim()) throw new Error('A queue name is required.');
    if (input.id) {
      const existing = this.db.getQueue(input.id);
      if (!existing) throw new Error('Queue not found.');
      const updated: QueueRecord = {
        ...existing,
        name: input.name.trim().slice(0, 80),
        priority: clampInt(input.priority, -100, 100),
        maxConcurrent: clampInt(input.maxConcurrent, 0, 20),
        speedLimitBps: clampInt(input.speedLimitBps, 0, 10_000_000_000),
        onComplete: input.onComplete,
        updatedAt: timestamp
      };
      this.db.updateQueue(updated);
      this.emitChanged();
      this.schedulePump();
      return updated;
    }
    const queue: QueueRecord = {
      id: crypto.randomUUID(),
      name: input.name.trim().slice(0, 80),
      priority: clampInt(input.priority, -100, 100),
      maxConcurrent: clampInt(input.maxConcurrent, 0, 20),
      speedLimitBps: clampInt(input.speedLimitBps, 0, 10_000_000_000),
      status: 'active',
      isDefault: false,
      onComplete: input.onComplete,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.insertQueue(queue);
    this.emitChanged();
    this.schedulePump();
    return queue;
  }

  deleteQueue(id: string): void {
    const queue = this.db.getQueue(id);
    if (!queue) return;
    if (queue.isDefault) throw new Error('The default queue cannot be deleted.');
    this.db.deleteQueue(id);
    for (const record of this.downloads.values()) if (record.queueId === id) record.queueId = 'default';
    this.emitChanged();
    this.schedulePump();
  }

  startQueue(id: string): void {
    const queue = this.db.getQueue(id);
    if (!queue) throw new Error('Queue not found.');
    if (queue.status !== 'active') {
      this.db.updateQueue({ ...queue, status: 'active', updatedAt: new Date().toISOString() });
    }
    for (const idToResume of Array.from(this.pausedBySchedule)) {
      const record = this.downloads.get(idToResume);
      if (record && record.queueId === id) {
        this.pausedBySchedule.delete(idToResume);
        record.status = 'queued';
        this.persist(record);
      }
    }
    this.emitChanged();
    this.schedulePump();
  }

  stopQueue(id: string): void {
    const queue = this.db.getQueue(id);
    if (!queue) throw new Error('Queue not found.');
    this.db.updateQueue({ ...queue, status: 'paused', updatedAt: new Date().toISOString() });
    for (const record of this.downloads.values()) {
      if (record.queueId !== id) continue;
      if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) {
        this.pausedBySchedule.add(record.id);
        this.pauseDownload(record.id);
      }
    }
    this.emitChanged();
  }

  saveSchedule(input: ScheduleInput): ScheduleRecord {
    if (!input.name?.trim()) throw new Error('A schedule name is required.');
    if (!input.days?.length) throw new Error('Select at least one day.');
    const timestamp = new Date().toISOString();
    if (input.id) {
      const existing = this.db.listSchedules().find((schedule) => schedule.id === input.id);
      if (!existing) throw new Error('Schedule not found.');
      const updated: ScheduleRecord = {
        ...existing,
        name: input.name.trim().slice(0, 80),
        queueId: input.queueId,
        action: input.action,
        days: Array.from(new Set(input.days.filter((day) => day >= 0 && day <= 6))).sort(),
        startTime: input.startTime,
        stopTime: input.stopTime,
        enabled: input.enabled,
        updatedAt: timestamp
      };
      this.db.updateSchedule(updated);
      this.emitChanged();
      return updated;
    }
    const schedule: ScheduleRecord = {
      id: crypto.randomUUID(),
      name: input.name.trim().slice(0, 80),
      queueId: input.queueId,
      action: input.action,
      days: Array.from(new Set(input.days.filter((day) => day >= 0 && day <= 6))).sort(),
      startTime: input.startTime,
      stopTime: input.stopTime,
      enabled: input.enabled,
      lastFiredKey: '',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.insertSchedule(schedule);
    this.emitChanged();
    return schedule;
  }

  deleteSchedule(id: string): void {
    this.db.deleteSchedule(id);
    this.emitChanged();
  }

  dispatchScheduleAction(action: ScheduleRecord['action'], queueId: string | null): void {
    if (action === 'start_all') this.resumeAll();
    else if (action === 'pause_all') this.pauseAll();
    else if (action === 'start_queue' && queueId) this.startQueue(queueId);
    else if (action === 'stop_queue' && queueId) this.stopQueue(queueId);
  }

  saveRule(input: RuleInput): CategoryRule {
    const timestamp = new Date().toISOString();
    if (!input.name?.trim() || !input.pattern?.trim()) throw new Error('A name and pattern are required.');
    if (input.id) {
      const existing = this.db.listRules().find((rule) => rule.id === input.id);
      if (!existing) throw new Error('Rule not found.');
      const updated: CategoryRule = {
        ...existing,
        name: input.name.trim().slice(0, 80),
        enabled: input.enabled,
        priority: clampInt(input.priority, -1000, 1000),
        matchType: input.matchType,
        pattern: input.pattern.trim().slice(0, 500),
        category: input.category,
        destinationDir: input.destinationDir ? path.resolve(input.destinationDir) : '',
        autoOpen: input.autoOpen,
        updatedAt: timestamp
      };
      this.db.updateRule(updated);
      this.emitChanged();
      return updated;
    }
    const rule: CategoryRule = {
      id: crypto.randomUUID(),
      name: input.name.trim().slice(0, 80),
      enabled: input.enabled,
      priority: clampInt(input.priority, -1000, 1000),
      matchType: input.matchType,
      pattern: input.pattern.trim().slice(0, 500),
      category: input.category,
      destinationDir: input.destinationDir ? path.resolve(input.destinationDir) : '',
      autoOpen: input.autoOpen,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.insertRule(rule);
    this.emitChanged();
    return rule;
  }

  deleteRule(id: string): void {
    this.db.deleteRule(id);
    this.emitChanged();
  }

  resolveSiteRule(url: string, sourcePageUrl: string, fileName: string): SiteRule | null {
    const host = hostnameFromUrl(sourcePageUrl) || hostnameFromUrl(url);
    if (!host) return null;
    const targetName = fileName || deriveFileNameFromUrl(url, 'download');
    let best: SiteRule | null = null;
    let bestSpecificity = -1;
    for (const rule of this.db.listSiteRules()) {
      if (!rule.enabled || !fileTypeAllowed(targetName, rule)) continue;
      let specificity = -1;
      for (const pattern of rule.pattern.split(',')) {
        if (wildcardHostMatch(pattern, host)) {
          specificity = Math.max(specificity, pattern.replace(/[*.\s]/g, '').length);
        }
      }
      if (specificity > bestSpecificity) {
        best = rule;
        bestSpecificity = specificity;
      }
    }
    return best;
  }

  saveSiteRule(input: SiteRuleInput): SiteRule {
    const timestamp = new Date().toISOString();
    if (!input.name?.trim() || !input.pattern?.trim()) throw new Error('A name and site pattern are required.');
    if (input.id) {
      const existing = this.db.listSiteRules().find((rule) => rule.id === input.id);
      if (!existing) throw new Error('Site rule not found.');
      const updated: SiteRule = {
        ...existing,
        name: input.name.trim().slice(0, 80),
        pattern: input.pattern.trim().slice(0, 500),
        action: input.action,
        fileTypes: input.fileTypes.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean),
        destinationDir: input.destinationDir ? path.resolve(input.destinationDir) : '',
        enabled: input.enabled,
        updatedAt: timestamp
      };
      this.db.updateSiteRule(updated);
      this.emitChanged();
      return updated;
    }
    const rule: SiteRule = {
      id: crypto.randomUUID(),
      name: input.name.trim().slice(0, 80),
      pattern: input.pattern.trim().slice(0, 500),
      action: input.action,
      fileTypes: input.fileTypes.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean),
      destinationDir: input.destinationDir ? path.resolve(input.destinationDir) : '',
      enabled: input.enabled,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.insertSiteRule(rule);
    this.emitChanged();
    return rule;
  }

  deleteSiteRule(id: string): void {
    this.db.deleteSiteRule(id);
    this.emitChanged();
  }

  exportQueue(): string {
    const bundle: ImportExportBundle = {
      kind: 'mdm-queue-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      queues: this.db.listQueues().map((queue) => ({
        id: queue.id,
        name: queue.name,
        priority: queue.priority,
        maxConcurrent: queue.maxConcurrent,
        speedLimitBps: queue.speedLimitBps,
        onComplete: queue.onComplete
      })),
      schedules: this.db.listSchedules().map((schedule) => ({
        name: schedule.name,
        queueId: schedule.queueId,
        action: schedule.action,
        days: schedule.days,
        startTime: schedule.startTime,
        stopTime: schedule.stopTime,
        enabled: schedule.enabled
      }))
    };
    return JSON.stringify(bundle, null, 2);
  }

  importQueue(json: string): number {
    let bundle: ImportExportBundle;
    try {
      bundle = JSON.parse(json) as ImportExportBundle;
    } catch {
      throw new Error('The queue file is not valid JSON.');
    }
    if (bundle.kind !== 'mdm-queue-export' || bundle.version !== 1) {
      throw new Error('This is not an MDM queue export.');
    }
    let imported = 0;
    const idByOld = new Map<string, string>();
    const idByPosition = new Map<number, string>();
    const existing = this.db.listQueues();
    for (const [index, queue] of (bundle.queues ?? []).entries()) {
      const match = existing.find((candidate) => candidate.name === queue.name);
      const queueId = match?.id ?? this.saveQueue({
        name: queue.name,
        priority: queue.priority,
        maxConcurrent: queue.maxConcurrent,
        speedLimitBps: queue.speedLimitBps,
        onComplete: queue.onComplete
      }).id;
      if (!match) imported++;
      idByOld.set(queue.name, queueId);
      if (queue.id) idByOld.set(queue.id, queueId);
      idByPosition.set(index, queueId);
      idByOld.set(String(index), queueId);
    }
    for (const schedule of bundle.schedules ?? []) {
      this.saveSchedule({
        name: schedule.name,
        queueId: schedule.queueId ? idByOld.get(schedule.queueId) ?? idByPosition.get(Number(schedule.queueId)) ?? null : null,
        action: schedule.action,
        days: schedule.days,
        startTime: schedule.startTime,
        stopTime: schedule.stopTime,
        enabled: schedule.enabled
      });
      imported++;
    }
    this.emitChanged();
    return imported;
  }

  processDueScheduled(now = new Date()): void {
    let changed = false;
    for (const record of this.downloads.values()) {
      if (record.status === 'scheduled' && record.scheduledAt) {
        const at = new Date(record.scheduledAt);
        if (at.getTime() <= now.getTime()) {
          record.status = 'queued';
          record.error = '';
          record.errorCode = '';
          this.persist(record);
          changed = true;
        }
      }
    }
    if (changed) {
      this.emitChanged();
      this.schedulePump();
    }
  }

  async testProxy(): Promise<{ ok: boolean; message: string }> {
    const settings = this.settingsService.get();
    try {
      const proxy = await this.resolveProxy('https://example.com/');
      const http = this.createHttpClient(settings, proxy, 12_000, 12_000);
      const response = await http.request('https://example.com/', { method: 'HEAD' });
      response.close();
      return { ok: response.status > 0, message: `Proxy reachable (HTTP ${response.status}).` };
    } catch (error) {
      return { ok: false, message: friendlyErrorMessage(mapNetworkError(error)) };
    }
  }

  encodeQueueForBridge(): { queues: QueueRecord[] } {
    return { queues: this.db.listQueues() };
  }

  private handleSettingsChanged(settings: AppSettings): void {
    this.probeCache.clear();
    this.globalLimiter.setRate(settings.globalSpeedLimitBps);
    this.hostLimiter.setLimit(settings.maxConnectionsPerHost);
    setDirectAgentMaxSockets(settings.maxConnectionsPerHost);
    const connections = clampInt(settings.defaultConnections, 1, 64);
    for (const record of this.getRecords()) {
      if (record.connections === connections || record.status === 'completed' || record.status === 'canceled') continue;
      record.connections = connections;
      record.updatedAt = new Date().toISOString();
      this.persist(record);
      this.emit('updated', record);
    }
    this.schedulePump();
    this.emitChanged();
  }

  private schedulePump(): void {
    if (this.pumpQueued || this.shuttingDown) return;
    this.pumpQueued = true;
    setTimeout(() => {
      this.pumpQueued = false;
      this.pump().catch((error) => this.logger.error('downloads', `Scheduler error: ${(error as Error).message}`));
    }, 120);
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    this.processDueScheduled();
    const settings = this.settingsService.get();
    const queues = new Map(this.db.listQueues().map((queue) => [queue.id, queue]));
    for (;;) {
      const records = this.getRecords();
      const globalActive = records.filter((record) => ['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)).length;
      if (globalActive >= settings.maxConcurrentDownloads) break;
      const queueCounts = new Map<string, number>();
      for (const record of records) {
        if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) {
          queueCounts.set(record.queueId, (queueCounts.get(record.queueId) ?? 0) + 1);
        }
      }
      const candidates = records
        .filter((record) => record.status === 'queued')
        .filter((record) => {
          const queue = queues.get(record.queueId);
          if (!queue || queue.status !== 'active') return false;
          if (queue.maxConcurrent > 0 && (queueCounts.get(queue.id) ?? 0) >= queue.maxConcurrent) return false;
          return true;
        })
        .sort((a, b) => {
          const score = priorityScore(b.priority) - priorityScore(a.priority) ||
            (queues.get(b.queueId)?.priority ?? 0) - (queues.get(a.queueId)?.priority ?? 0);
          return score !== 0 ? score : a.createdAt.localeCompare(b.createdAt);
        });
      const next = candidates[0];
      if (!next) break;
      this.beginTask(next);
    }
  }

  private beginTask(record: DownloadRecord): void {
    if (this.activeIds.has(record.id) || this.shuttingDown) return;
    this.activeIds.add(record.id);
    this.setStatus(record, 'connecting');
    record.error = '';
    record.errorCode = '';
    if (!record.startedAt) this.startNotifications.add(record.id);
    record.startedAt ??= new Date().toISOString();
    record.speedBps = 0;
    record.etaSeconds = null;
    this.persist(record);
    this.queueActivity.set(record.queueId, { hadActivity: true });
    this.emit('updated', record);
    this.emitChanged();
    const run = this.runTask(record).catch((error) => {
      this.logger.error('downloads', `Unhandled task failure: ${(error as Error).message}`);
    });
    this.activeRuns.add(run);
    void run.finally(() => this.activeRuns.delete(run));
  }

  private async runTask(record: DownloadRecord): Promise<void> {
    let task: RunningTask | null = null;
    try {
      const settings = this.settingsService.get();
      const proxy = await this.resolveProxy(record.url);
      const http = this.createHttpClient(settings, proxy);
      const queue = this.db.getQueue(record.queueId);
      const runtime = this.buildRuntime(record, http);
      const config = this.buildDownloadConfig(record, settings, queue);
      const callbacks = this.buildCallbacks(record);
      if (record.kind === 'ftp') task = new FtpDownloadTask(config, runtime, callbacks);
      else if (record.kind === 'youtube') task = new YtDlpDownloadTask(config, runtime, callbacks);
      else if (record.kind === 'hls' || record.kind === 'dash') task = new MediaDownloadTask(config, runtime, callbacks);
      else task = new HttpDownloadTask(config, runtime, callbacks);
      this.activeTasks.set(record.id, task);
      const pending = this.preparingControls.get(record.id);
      if (pending === 'pause') task.pause();
      else if (pending === 'cancel' || pending === 'remove' || pending === 'restart') task.cancel();
      this.preparingControls.delete(record.id);
      const outcome = await task.run();
      await this.handleOutcome(record, outcome);
    } catch (error) {
      await this.handleTaskError(record, error);
    } finally {
      this.activeTasks.delete(record.id);
      this.activeIds.delete(record.id);
      this.preparingControls.delete(record.id);
      this.releaseReservation(record.id);
      this.emitChanged();
      if (!this.shuttingDown) {
        this.schedulePump();
        this.checkQueueCompletion(record.queueId).catch(() => undefined);
      }
    }
  }

  private buildRuntime(record: DownloadRecord, http: HttpClient): EngineRuntime {
    const runtime = this.runtimeBase(http);
    runtime.resolveDirectory = record.destinationExplicit
      ? undefined
      : async (fileName, mimeType) => {
          const result = this.categoryDirectory(fileName, mimeType, record.url);
          if (result.directory !== record.destinationDir || result.category !== record.category) {
            record.destinationDir = result.directory;
            record.category = result.category;
            this.persist(record);
          }
          return result.directory;
        };
    return runtime;
  }

  private buildDownloadConfig(record: DownloadRecord, settings: AppSettings, queue: QueueRecord | null): DownloadConfig {
    let mediaFormat: MediaFormat | undefined;
    if (record.mediaFormatJson) {
      try {
        mediaFormat = JSON.parse(record.mediaFormatJson) as MediaFormat;
      } catch {
        mediaFormat = undefined;
      }
    }
    if ((record.kind === 'hls' || record.kind === 'dash') && !mediaFormat) {
      throw new DownloadError('The selected media format is missing. Restart the download.', 'UNSUPPORTED_MEDIA');
    }
    if (record.kind === 'youtube' && !mediaFormat?.formatSelector) {
      throw new DownloadError('The selected video format is missing. Add the video again.', 'YOUTUBE_UNAVAILABLE');
    }
    const speedLimit = record.speedLimitBps || queue?.speedLimitBps || settings.defaultSpeedLimitBps;
    return {
      id: record.id,
      kind: record.kind,
      url: record.url,
      destinationDir: record.destinationDir,
      fileName: record.fileName,
      fileNameExplicit: record.fileNameExplicit,
      headers: record.headers,
      cookies: record.cookies,
      referrer: record.referrer,
      connections: record.connections,
      // Turbo only makes sense when nothing caps the speed: a limit means "use less".
      turbo:
        (record.turboMode ?? settings.turboMode) && !speedLimit && !settings.globalSpeedLimitBps
          ? { maxConnections: Math.max(settings.turboMaxConnections, record.connections) }
          : undefined,
      speedLimitBps: speedLimit,
      maxRetries: record.maxRetries || settings.maxRetries,
      retryBaseDelayMs: settings.retryBaseDelayMs,
      checksum: record.checksum,
      checksumAlgorithm: record.checksumAlgorithm,
      // Auto delete removes the file afterwards, so it must not first replace one the person already has.
      conflictPolicy: record.autoDelete && settings.duplicatePolicy === 'overwrite' ? 'rename' : settings.duplicatePolicy,
      tlsAllowInsecure: record.tlsAllowInsecure,
      resume:
        record.tempPath && record.segments.length
          ? {
              tempPath: record.tempPath,
              targetPath: record.targetPath ?? path.join(record.destinationDir, record.fileName),
              fileName: record.fileName,
              finalUrl: record.finalUrl ?? record.url,
              totalBytes: record.totalBytes,
              downloadedBytes: record.downloadedBytes,
              resumable: record.resumable,
              etag: record.etag,
              lastModified: record.lastModified,
              mimeType: record.mimeType,
              segments: record.segments,
              mediaState: record.mediaState
            }
          : undefined,
      mediaFormat,
      sourcePageUrl: record.sourcePageUrl
    };
  }

  private buildCallbacks(record: DownloadRecord): EngineCallbacks {
    let lastBroadcast = 0;
    return {
      onPrepared: (prepared) => {
        this.applyPrepared(record, prepared);
      },
      onProgress: (progress) => {
        this.applyProgress(record, progress);
        const now = Date.now();
        if (now - lastBroadcast >= PROGRESS_INTERVAL_MS) {
          lastBroadcast = now;
          const event: DownloadProgressEvent = {
            id: record.id,
            status: record.status,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            speedBps: progress.speedBps,
            etaSeconds: progress.etaSeconds,
            segments: progress.segments.map((segment) => ({ ...segment })),
            attempts: progress.attempts
          };
          this.emit('progress', event);
        }
      },
      onCheckpoint: (checkpoint) => {
        this.applyCheckpoint(record, checkpoint);
      },
      onLog: (level, message) => {
        this.appendRecordLog(record, level, message);
      }
    };
  }

  private applyPrepared(record: DownloadRecord, prepared: PreparedDownload): void {
    record.finalUrl = prepared.finalUrl;
    record.fileName = prepared.fileName;
    record.destinationDir = prepared.destinationDir;
    record.targetPath = prepared.targetPath;
    record.tempPath = prepared.tempPath;
    record.totalBytes = prepared.totalBytes;
    record.downloadedBytes = prepared.downloadedBytes;
    record.resumable = prepared.resumable;
    record.etag = prepared.etag;
    record.lastModified = prepared.lastModified;
    record.mimeType = prepared.mimeType;
    record.segments = prepared.segments.map((segment) => ({ ...segment }));
    record.mediaState = prepared.mediaState ?? '';
    record.category = categoryFromFileName(prepared.fileName);
    if (!record.destinationExplicit) {
      const categorized = this.categoryDirectory(prepared.fileName, prepared.mimeType, record.url);
      record.category = categorized.category;
    }
    if (!record.fileNameExplicit) record.fileName = prepared.fileName;
    this.setStatus(record, 'downloading');
    if (this.reservations.has(record.targetPath) && this.reservedByDownload.get(record.id) !== record.targetPath) {
      // The engine resolves collisions against the reservation set; this is just defensive.
    }
    this.reservations.add(record.targetPath);
    this.reservedByDownload.set(record.id, record.targetPath);
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    this.emit('updated', record);
    this.emitLifecycle(record, 'started');
    this.emitChanged();
    const settings = this.settingsService.get();
    if (this.startNotifications.delete(record.id) && settings.notificationsEnabled && settings.notifyOnStart) {
      this.host.notify('Download started', record.fileName, record.id);
    }
  }

  private applyProgress(record: DownloadRecord, progress: ProgressState): void {
    if (record.status === 'canceled' || record.status === 'paused') return;
    record.downloadedBytes = progress.downloadedBytes;
    if (progress.totalBytes !== null) record.totalBytes = progress.totalBytes;
    record.speedBps = progress.speedBps;
    record.etaSeconds = progress.etaSeconds;
    record.segments = progress.segments.map((segment) => ({ ...segment }));
    if (!['connecting', 'verifying', 'finalizing'].includes(record.status)) {
      record.status = progress.status === 'connecting' ? record.status : progress.status;
    }
    record.retryCount = Math.max(record.retryCount, progress.attempts);
  }

  private applyCheckpoint(record: DownloadRecord, checkpoint: EngineCheckpoint): void {
    if (record.status === 'canceled' || record.status === 'completed' || record.status === 'failed') return;
    // A paused checkpoint from a superseded task run must never resurrect the
    // paused state after the user resumed (or the record moved on) — that would
    // deadlock the download outside the queue pump.
    if (checkpoint.status === 'paused' && record.status !== 'paused') return;

    const isProgressOnly = checkpoint.progressOnly === true &&
      checkpoint.status === 'downloading' &&
      !checkpoint.error &&
      !checkpoint.errorCode &&
      !checkpoint.checksumStatus &&
      checkpoint.mediaState === undefined;

    // Update in-memory record for progress events and UI
    record.finalUrl = checkpoint.prepared.finalUrl;
    record.fileName = checkpoint.prepared.fileName;
    record.destinationDir = checkpoint.prepared.destinationDir;
    record.targetPath = checkpoint.prepared.targetPath;
    record.tempPath = checkpoint.prepared.tempPath;
    record.totalBytes = checkpoint.totalBytes;
    record.downloadedBytes = checkpoint.downloadedBytes;
    record.resumable = checkpoint.prepared.resumable;
    record.etag = checkpoint.prepared.etag;
    record.lastModified = checkpoint.prepared.lastModified;
    record.mimeType = checkpoint.prepared.mimeType;
    record.mediaState = checkpoint.mediaState ?? checkpoint.prepared.mediaState ?? '';
    record.segments = checkpoint.prepared.segments.map((segment) => ({ ...segment }));
    if (checkpoint.checksumStatus) record.checksumStatus = checkpoint.checksumStatus;
    if (checkpoint.error) record.error = checkpoint.error;
    if (checkpoint.errorCode) record.errorCode = checkpoint.errorCode;
    record.retryCount = Math.max(record.retryCount, checkpoint.attempts);
    if (record.status === 'paused' || (checkpoint.status as DownloadStatus) === 'paused') {
      record.status = 'paused';
      record.speedBps = 0;
      record.etaSeconds = null;
    }
    record.updatedAt = new Date().toISOString();

    try {
      if (isProgressOnly) {
        this.db.saveProgress(
          record.id,
          record.downloadedBytes,
          record.speedBps,
          record.etaSeconds,
          record.segments
        );
      } else {
        this.db.saveCheckpoint(
          record.id,
          {
            finalUrl: record.finalUrl,
            fileName: record.fileName,
            destinationDir: record.destinationDir,
            targetPath: record.targetPath,
            tempPath: record.tempPath,
            totalBytes: record.totalBytes,
            downloadedBytes: record.downloadedBytes,
            resumable: record.resumable,
            etag: record.etag,
            lastModified: record.lastModified,
            mimeType: record.mimeType,
            mediaStateJson: record.mediaState,
            checksumStatus: record.checksumStatus,
            error: record.error,
            errorCode: record.errorCode,
            retryCount: record.retryCount,
            speedBps: record.speedBps,
            etaSeconds: record.etaSeconds,
            recordLogJson: JSON.stringify(record.recordLog)
          },
          record.segments
        );
      }
    } catch (error) {
      this.logger.warn('downloads', `Failed to save checkpoint: ${(error as Error).message}`);
    }
  }

  private async handleOutcome(record: DownloadRecord, outcome: EngineOutcome): Promise<void> {
    if (outcome.status === 'completed') {
      if (this.removeRequested.has(record.id)) {
        await this.finalizeRemoval(record, true);
        return;
      }
      record.fileName = outcome.result.fileName;
      record.targetPath = outcome.result.targetPath;
      record.totalBytes = outcome.result.totalBytes;
      record.downloadedBytes = outcome.result.downloadedBytes;
      record.checksumStatus = outcome.result.checksumStatus;
      record.segments = outcome.result.segments.map((segment) => ({ ...segment }));
      record.mimeType = outcome.result.mimeType || record.mimeType;
      record.mediaState = outcome.result.mediaState ?? record.mediaState;
      record.status = 'completed';
      record.error = '';
      record.errorCode = '';
      record.speedBps = 0;
      record.etaSeconds = null;
      record.completedAt = new Date().toISOString();
      record.tempPath = null;
      record.updatedAt = record.completedAt;
      this.persist(record);
      this.appendRecordLog(record, 'info', 'Download completed.');
      this.emit('updated', record);
      this.startNotifications.delete(record.id);
      this.emitLifecycle(record, 'completed');
      this.emitChanged();
      const settings = this.settingsService.get();
      if (settings.notificationsEnabled && settings.notifyOnComplete) {
        this.host.notify('Download complete', record.fileName, record.id);
      }
      if (record.autoDelete) {
        await this.deleteDownloadedFile(record);
      } else if (record.autoOpen || settings.autoOpenCompleted) {
        if (isSafeToAutoOpen(record.fileName) && record.targetPath) {
          const error = await this.host.openPath(record.targetPath).catch(() => 'open failed');
          if (error) this.logger.warn('downloads', `Could not open ${record.fileName}: ${error}`);
        }
      }
      // Batch repeat: queue the next copy with everything this one needed. Without
      // the cookies, headers and referrer a login-protected file is refused (403)
      // and the whole batch stops after the first copy.
      const batchTotal = record.repeatTotal ?? 1;
      if (record.repeatCount && record.repeatCount > 1) {
        if (record.kind !== 'http' && record.kind !== 'ftp') {
          this.logger.warn('downloads', 'Batch repeat is only available for plain HTTP and FTP downloads.');
        } else {
          try {
            const baseName = record.fileNameExplicit ? (this.repeatBaseNames.get(record.id) ?? record.fileName) : undefined;
            this.repeatBaseNames.delete(record.id);
            await this.addDownload({
              url: record.url,
              fileName: baseName,
              destinationDir: record.destinationDir,
              queueId: record.queueId,
              priority: record.priority,
              speedLimitBps: record.speedLimitBps,
              headers: record.headers,
              cookies: record.cookies,
              referrer: record.referrer,
              sourcePageUrl: record.sourcePageUrl,
              checksum: record.checksum,
              checksumAlgorithm: record.checksumAlgorithm,
              tlsAllowInsecure: record.tlsAllowInsecure,
              turboMode: record.turboMode,
              connections: record.connections,
              autoDelete: record.autoDelete,
              startNow: true,
              repeatCount: record.repeatCount - 1,
              repeatTotal: batchTotal
            });
            this.logger.info('downloads', `Batch repeat: queued copy ${batchTotal - record.repeatCount + 2} of ${batchTotal}.`);
          } catch (error) {
            this.logger.warn('downloads', `Batch repeat stopped: ${(error as Error).message}`);
          }
        }
      } else if (batchTotal > 1) {
        this.host.notify('Batch complete', `All ${batchTotal} downloads finished.`);
      }
      return;
    }
    if (outcome.status === 'paused') {
      const checkpoint = outcome.checkpoint;
      if (checkpoint) this.applyCheckpoint(record, checkpoint);
      // Only transition from active-transfer states: if the user already
      // resumed (status 'queued') or the record moved on while the engine was
      // unwinding, forcing 'paused' here would deadlock the download outside
      // the queue pump.
      if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) {
        this.setStatus(record, 'paused');
      }
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
      return;
    }
    if (outcome.status === 'canceled') {
      if (this.removeRequested.has(record.id)) {
        await this.finalizeRemoval(record, this.removeRequested.has(`${record.id}:file`));
        return;
      }
      if (this.restartRequested.has(record.id)) {
        this.restartRequested.delete(record.id);
        this.resetForRestart(record);
        this.persist(record);
        this.emit('updated', record);
        this.emitChanged();
        this.schedulePump();
        return;
      }
      this.setStatus(record, 'canceled');
      record.error = 'Canceled by user.';
      record.errorCode = 'CANCELED';
      record.downloadedBytes = 0;
      record.segments = [];
      record.tempPath = null;
      record.mediaState = '';
      record.speedBps = 0;
      record.etaSeconds = null;
      this.persist(record);
      this.emit('updated', record);
      this.startNotifications.delete(record.id);
      this.emitLifecycle(record, 'cancelled');
      this.emitChanged();
    }
  }

  private async deleteDownloadedFile(record: DownloadRecord): Promise<void> {
    const target = record.targetPath;
    if (!target) return;
    try {
      // Permanent delete: unlink bypasses the Recycle Bin, like Shift+Delete.
      await fsp.unlink(target);
      this.appendRecordLog(record, 'info', 'Downloaded file deleted permanently (auto delete).');
      record.targetPath = null;
      record.updatedAt = new Date().toISOString();
      this.persist(record);
      this.emit('updated', record);
      this.emitChanged();
    } catch (error) {
      this.logger.warn('downloads', `Auto delete failed for ${record.fileName}: ${(error as Error).message}`);
    }
  }

  private async handleTaskError(record: DownloadRecord, error: unknown): Promise<void> {
    if (this.removeRequested.has(record.id)) {
      await this.finalizeRemoval(record, this.removeRequested.has(`${record.id}:file`));
      return;
    }
    if (this.restartRequested.has(record.id)) {
      this.restartRequested.delete(record.id);
      await this.retryWithBackoff(record);
      return;
    }
    if (record.status === 'canceled') {
      this.emit('updated', record);
      return;
    }
    const mapped = error instanceof Error && 'code' in error ? (error as DownloadError) : mapNetworkError(error);
    record.status = 'failed';
    record.error = friendlyErrorMessage(mapped);
    record.errorCode = mapped.code ?? 'INTERNAL';
    record.speedBps = 0;
    record.etaSeconds = null;
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    this.appendRecordLog(record, 'error', record.error);
    const cause = mapped.cause as (NodeJS.ErrnoException & { remoteAddress?: string }) | undefined;
    const detail: Record<string, string> = { url: redactUrl(record.url), code: record.errorCode };
    if (cause?.code) detail.causeCode = String(cause.code);
    if (cause?.message) detail.causeMessage = cause.message.slice(0, 300);
    if (cause?.remoteAddress) detail.remoteAddress = cause.remoteAddress;
    this.logger.error('downloads', `${record.fileName}: ${record.error}`, detail);
    this.emit('updated', record);
    this.startNotifications.delete(record.id);
    this.emitLifecycle(record, 'failed');
    this.emitChanged();
    const settings = this.settingsService.get();
    if (settings.notificationsEnabled && settings.notifyOnFailure) {
      this.host.notify('Download failed', `${record.fileName}: ${record.error}`, record.id);
    }
  }

  private async retryWithBackoff(record: DownloadRecord): Promise<void> {
    this.resetForRestart(record);
    record.retryCount += 1;
    this.persist(record);
    this.emit('updated', record);
    this.emitChanged();
    this.schedulePump();
  }

  private async checkQueueCompletion(queueId: string): Promise<void> {
    if (this.shuttingDown) return;
    const activity = this.queueActivity.get(queueId);
    if (!activity?.hadActivity) return;
    const records = Array.from(this.downloads.values()).filter((record) => record.queueId === queueId);
    const pending = records.some((record) =>
      ['queued', 'scheduled', 'connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)
    );
    if (pending) return;
    this.queueActivity.delete(queueId);
    const queue = this.db.getQueue(queueId);
    if (!queue) return;
    const failed = records.filter((record) => record.status === 'failed').length;
    const completed = records.filter((record) => record.status === 'completed').length;
    const settings = this.settingsService.get();
    if (settings.notificationsEnabled) {
      const body = `${completed} completed${failed ? `, ${failed} failed` : ''}.`;
      this.host.notify(`Queue "${queue.name}" finished`, body);
    }
    this.emit('queue-complete', { queue, completed, failed });
    if ((queue.onComplete === 'shutdown' || settings.autoShutdownAfterQueue) && failed === 0 && !this.shutdownRequested) {
      this.shutdownRequested = true;
      this.logger.info('system', 'All downloads have finished. Requesting system shutdown as configured.');
      this.host.requestShutdown(queue);
    }
  }

  private async resolveProxy(url: string): Promise<ResolvedProxy | null> {
    const settings = this.settingsService.get();
    if (settings.proxy.mode === 'none') return null;
    if (settings.proxy.mode === 'system') return this.host.createSystemProxy(url);
    if (!settings.proxy.host) return null;
    const username = settings.proxy.username;
    const password = this.settingsService.getProxyPassword();
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const proxyUrl = `${settings.proxy.protocol}://${auth}${settings.proxy.host}:${settings.proxy.port}`;
    return {
      protocol: settings.proxy.protocol,
      host: settings.proxy.host,
      port: settings.proxy.port,
      username,
      password,
      bypass: settings.proxy.bypass.split(',').map((value) => value.trim()).filter(Boolean),
      url: proxyUrl
    };
  }

  private createHttpClient(settings: AppSettings, proxy: ResolvedProxy | null, connectTimeoutMs?: number, idleTimeoutMs?: number, tlsAllowInsecure = false): HttpClient {
    return new HttpClient({
      connectTimeoutMs: connectTimeoutMs ?? settings.connectTimeoutMs,
      idleTimeoutMs: idleTimeoutMs ?? settings.idleTimeoutMs,
      tlsAllowInsecure,
      maxRedirects: settings.maxRedirects,
      ipVersion: settings.ipVersion,
      userAgent: settings.userAgentMode === 'custom' ? settings.userAgent : `${APP_SHORT_NAME}/${APP_VERSION}`,
      proxy,
      maxSocketsPerHost: settings.maxConnectionsPerHost
    });
  }

  private categoryDirectory(fileName: string, mimeType: string, url: string): { directory: string; category: FileCategory } {
    const settings = this.settingsService.get();
    const detected = categoryFromFileName(fileName);
    const mimeCategory = mimeType ? categoryFromMime(mimeType) : 'other';
    const category =
      detected === 'other' || (mimeCategory === 'audio' && detected === 'video') ? mimeCategory : detected;
    const rules = this.db.listRules().filter((rule) => rule.enabled);
    for (const rule of rules) {
      if (!ruleMatches(rule, fileName, mimeType, url)) continue;
      if (!settings.categorizeByType && !rule.destinationDir) continue;
      const directory = rule.destinationDir
        ? path.resolve(rule.destinationDir)
        : path.join(settings.defaultDownloadDir, settings.categoryFolders[rule.category]);
      return { directory, category: rule.category };
    }
    if (!settings.categorizeByType) return { directory: settings.defaultDownloadDir, category };
    const folder = settings.categoryFolders[category] || settings.categoryFolders.other;
    return { directory: path.join(settings.defaultDownloadDir, folder), category };
  }

  private applyDestinationChange(record: DownloadRecord, fileName: string, mimeType: string): void {
    if (record.destinationExplicit) return;
    const categorized = this.categoryDirectory(fileName, mimeType, record.url);
    record.destinationDir = categorized.directory;
    record.category = categorized.category;
  }

  levelForLog(level: string): 'info' | 'warn' | 'error' {
    return level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  }

  private requireRecord(id: string): DownloadRecord {
    const record = this.downloads.get(id);
    if (!record) throw new Error('Download not found.');
    return record;
  }

  private setStatus(record: DownloadRecord, status: DownloadStatus): void {
    record.status = status;
    record.updatedAt = new Date().toISOString();
  }

  private emitLifecycle(record: DownloadRecord, state: DownloadLifecycleState): void {
    if (this.lifecycleStates.get(record.id) === state) return;
    this.lifecycleStates.set(record.id, state);
    const event: DownloadLifecycleEvent = {
      id: record.id,
      state,
      record: structuredClone(record),
      at: new Date().toISOString(),
      errorCode: record.errorCode || undefined
    };
    this.emit('lifecycle', event);
  }

  private persist(record: DownloadRecord): void {
    try {
      this.db.updateDownload(record.id, {
        kind: record.kind,
        url: record.url,
        finalUrl: record.finalUrl,
        fileName: record.fileName,
        fileNameExplicit: record.fileNameExplicit,
        destinationDir: record.destinationDir,
        destinationExplicit: record.destinationExplicit,
        targetPath: record.targetPath,
        tempPath: record.tempPath,
        category: record.category,
        queueId: record.queueId,
        status: record.status,
        priority: record.priority,
        totalBytes: record.totalBytes,
        downloadedBytes: record.downloadedBytes,
        resumable: record.resumable,
        connections: record.connections,
        speedLimitBps: record.speedLimitBps,
        headers: record.headers,
        cookies: record.cookies,
        referrer: record.referrer,
        mimeType: record.mimeType,
        etag: record.etag,
        lastModified: record.lastModified,
        checksum: record.checksum,
        checksumAlgorithm: record.checksumAlgorithm,
        checksumStatus: record.checksumStatus,
        error: record.error,
        errorCode: record.errorCode,
        retryCount: record.retryCount,
        maxRetries: record.maxRetries,
        speedBps: record.speedBps,
        etaSeconds: record.etaSeconds,
        mediaFormatJson: record.mediaFormatJson,
        mediaStateJson: record.mediaState,
        sourcePageUrl: record.sourcePageUrl,
        autoOpen: record.autoOpen,
        scheduledAt: record.scheduledAt,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        recordLogJson: JSON.stringify(record.recordLog)
      });
    } catch (error) {
      this.logger.warn('database', `Could not update download metadata: ${(error as Error).message}`);
    }
  }

  private appendRecordLog(record: DownloadRecord, level: 'info' | 'warn' | 'error', message: string): void {
    record.recordLog.push({ at: new Date().toISOString(), level, message: message.slice(0, 1000) });
    if (record.recordLog.length > 40) record.recordLog.splice(0, record.recordLog.length - 40);
  }

  private discardTemp(record: DownloadRecord): void {
    void this.removeTempArtifacts(record);
  }

  private async removeTempArtifacts(record: DownloadRecord): Promise<void> {
    const tempPath = record.tempPath;
    if (!tempPath) return;
    await fsp.rm(tempPath, { force: true, recursive: record.kind === 'youtube' }).catch(() => undefined);
  }

  private clearResumeArtifacts(record: DownloadRecord): void {
    this.discardTemp(record);
    record.tempPath = null;
    record.targetPath = null;
    record.segments = [];
    record.downloadedBytes = 0;
    record.totalBytes = null;
    record.etag = '';
    record.lastModified = '';
    record.mediaState = '';
    record.finalUrl = null;
  }

  private releaseReservation(id: string): void {
    const target = this.reservedByDownload.get(id);
    if (target) this.reservations.delete(target);
    this.reservedByDownload.delete(id);
  }

  private emitChanged(): void {
    this.emit('changed');
  }
}

function priorityScore(priority: DownloadPriority): number {
  return priority === 'high' ? 2 : priority === 'low' ? 0 : 1;
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function categoryFromMime(mimeType: string): FileCategory {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'images';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('7z')) return 'archives';
  if (mime.startsWith('text/') || mime.includes('pdf') || mime.includes('document') || mime.includes('sheet')) return 'documents';
  if (mime.includes('executable') || mime.includes('msi')) return 'programs';
  return 'other';
}

function ruleMatches(rule: CategoryRule, fileName: string, mimeType: string, url: string): boolean {
  if (rule.matchType === 'extension') {
    const ext = extensionFromFileName(fileName);
    const patterns = rule.pattern.split(',').map((value) => value.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
    return patterns.some((pattern) => (pattern.includes('*') ? new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(ext) : pattern === ext));
  }
  if (rule.matchType === 'mime') {
    const pattern = rule.pattern.toLowerCase();
    const mime = (mimeType.split(';')[0] ?? '').toLowerCase();
    return pattern.includes('*') ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(mime) : pattern === mime;
  }
  const host = hostnameFromUrl(url);
  return rule.pattern.split(',').some((pattern) => wildcardHostMatch(pattern, host));
}

function extractUrlCredentials(raw: string): { url: string; authorization: string } | null {
  try {
    const url = new URL(raw);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) {
      const decodedUser = decodeURIComponent(url.username);
      const decodedPass = decodeURIComponent(url.password);
      url.username = '';
      url.password = '';
      return {
        url: url.toString(),
        authorization: `Basic ${Buffer.from(`${decodedUser}:${decodedPass}`).toString('base64')}`
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function extractPageCandidates(html: string, baseUrl: string): { manifests: string[]; pages: string[] } {
  const text = html
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
  const raw: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value) return;
    const cleaned = value.trim().replace(/^['"]|['"]$/g, '');
    if (!cleaned || /^(?:data|blob|javascript):/i.test(cleaned)) return;
    try {
      const resolved = new URL(cleaned, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
      raw.push(resolved.toString());
    } catch {
      /* Ignore malformed candidates. */
    }
  };
  const attributes = /<(?:iframe|frame|embed|object|video|audio|source)[^>]*?\s(?:src|data|data-src|data-url)\s*=\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(attributes)) add(match[1]);
  for (const match of text.matchAll(/<meta[^>]*>/gi)) {
    const tag = match[0];
    if (!/(?:og:video|twitter:player:stream|twitter:player)/i.test(tag)) continue;
    const content = /\scontent\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (content) add(content[1]);
  }
  for (const match of text.matchAll(
    /["'](?:file|src|url|hls|dash|playlist|video_url|videoUrl|manifest)["']\s*:\s*["']([^"']+)["']/gi
  )) {
    add(match[1]);
  }
  for (const match of text.matchAll(
    /(?:https?:)?\/\/[^\s"'<>\\]+\.(?:m3u8|mpd|mp4|m4v|webm|mov|mkv|flv|avi)(?:\?[^\s"'<>\\]*)?/gi
  )) {
    add(match[0]);
  }
  const isManifest = (value: string): boolean =>
    /\.(?:m3u8|m3u|mpd)(?:$|[?#])/i.test(value) ||
    /\/master\.txt(?:$|[?#])/i.test(value) ||
    /\.urlset(?:\/|$)/i.test(value);
  const isMedia = (value: string): boolean =>
    isManifest(value) ||
    /\.(?:mp4|m4v|webm|mov|mkv|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])/i.test(value);
  const manifests: string[] = [];
  const pages: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (seen.has(value)) continue;
    seen.add(value);
    if (isManifest(value)) manifests.push(value);
    else if (!isMedia(value) && value !== baseUrl) pages.push(value);
  }
  return { manifests: manifests.slice(0, 16), pages: pages.slice(0, 8) };
}

function pickBestFormat(formats: MediaFormat[]): MediaFormat {
  const available = formats.some((format) => !format.protected)
    ? formats.filter((format) => !format.protected)
    : formats;
  const video = available.filter((format) => !format.mimeType.startsWith('audio/'));
  if (!video.length) return available[0]!;
  return video.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0]!;
}

function formatExtension(format: MediaFormat): string {
  if (format.type === 'hls') return '.ts';
  const mime = format.mimeType.toLowerCase();
  if (mime.startsWith('audio/')) {
    if (mime.includes('mpeg')) return '.mp3';
    if (mime.includes('webm')) return '.webm';
    if (mime.includes('opus')) return '.opus';
    if (mime.includes('ogg')) return '.ogg';
    if (mime.includes('aac')) return '.aac';
    if (mime.includes('flac')) return '.flac';
    if (mime.includes('wav')) return '.wav';
    return '.m4a';
  }
  if (mime.includes('webm')) return '.webm';
  return '.mp4';
}

function isSafeToAutoOpen(fileName: string): boolean {
  const ext = extensionFromFileName(fileName);
  return !['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'jar', 'scr', 'pif', 'dll', 'apk', 'dmg', 'pkg'].includes(ext);
}
