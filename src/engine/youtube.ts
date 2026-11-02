import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { systemExecutable } from './win-tools';
import type { ChecksumStatus, DownloadSegment, MediaFormat, MediaProbeResult } from '../shared/types';
import { CHECKPOINT_INTERVAL_MS } from '../shared/defaults';
import { sanitizeFileName } from '../shared/validation';
import { hashFile } from './checksum';
import { DownloadError } from './errors';
import { atomicPlace, checkDiskSpace, resolveTargetPath } from './fs-utils';
import { buildYtDlpDownloadArgs, withUrlLast } from './ytdlp-args';
import { prepareYtDlpRequest } from './ytdlp-request';
import type {
  DownloadConfig,
  EngineCallbacks,
  EngineCheckpoint,
  EngineOutcome,
  EngineRuntime,
  PreparedDownload
} from './types';

const PROBE_TIMEOUT_MS = 90_000;
const PROBE_IDLE_TIMEOUT_MS = 45_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_PROBE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const PROGRESS_INTERVAL_MS = 500;
const SELECTOR_PATTERN = /^[A-Za-z0-9_.:-]{1,80}(?:\+[A-Za-z0-9_.:-]{1,80})?$/;
const INFO_CACHE_TTL_MS = 10 * 60_000;
const INFO_CACHE_LIMIT = 8;

/**
 * Quality-list extractions kept for the matching download so yt-dlp does not
 * extract the whole page a second time when the user presses Download.
 * (Signed URLs expire, so stale entries are discarded on failure.)
 */
const infoJsonCache = new Map<string, { at: number; json: string }>();

function infoCacheKey(url: string, headers: Record<string, string>, cookies: string): string {
  return `${url}\0${cookies}\0${JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))}`;
}

function rememberInfoJson(url: string, headers: Record<string, string>, cookies: string, json: string): void {
  const key = infoCacheKey(url, headers, cookies);
  if (infoJsonCache.size >= INFO_CACHE_LIMIT) {
    const oldest = infoJsonCache.keys().next().value;
    if (oldest !== undefined) infoJsonCache.delete(oldest);
  }
  infoJsonCache.set(key, { at: Date.now(), json });
}

function takeInfoJson(url: string, headers: Record<string, string>, cookies: string): string | null {
  const key = infoCacheKey(url, headers, cookies);
  const entry = infoJsonCache.get(key);
  if (!entry || Date.now() - entry.at > INFO_CACHE_TTL_MS) {
    infoJsonCache.delete(key);
    return null;
  }
  // Single use: the format list may be requested again after a failure.
  infoJsonCache.delete(key);
  return entry.json;
}

export interface YtFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  tbr?: number;
  abr?: number;
  filesize?: number | null;
  filesize_approx?: number | null;
  protocol?: string;
  mime_type?: string;
  language?: string;
  language_preference?: number;
  dynamic_range?: string;
  format_note?: string;
  has_drm?: boolean;
}

export interface YtInfo {
  id?: string;
  title?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  availability?: string;
  webpage_url?: string;
  _type?: string;
  _has_drm?: boolean;
  formats?: YtFormat[];
  entries?: YtInfo[];
}

interface YtDlpRunOptions {
  binary: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  collectStdout?: boolean;
  maxStdoutBytes?: number;
  onSpawn?: (child: ChildProcess) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

interface YtDlpRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface YouTubeState {
  v: 1;
  selector: string;
  extension: string;
}

export async function probeYouTube(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string
): Promise<MediaProbeResult> {
  return probeWithYtDlp(url, runtime, headers, cookies, 'YouTube');
}

export async function probeYtDlpPage(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string,
  label?: string
): Promise<MediaProbeResult> {
  return probeWithYtDlp(url, runtime, headers, cookies, pageLabel(url, label), true);
}

async function probeWithYtDlp(
  url: string,
  runtime: EngineRuntime,
  headers: Record<string, string>,
  cookies: string,
  siteLabel: string,
  genericFallback = false
): Promise<MediaProbeResult> {
  const binary = requireYtDlp(runtime);
  const buildArgs = (extra: string[], requestArgs: string[]): string[] =>
    withUrlLast([...baseArgs(runtime), '--dump-single-json', '--skip-download', ...extra, ...requestArgs], url);
  const run = async (extra: string[]): Promise<YtDlpRunResult> => {
    const request = await prepareYtDlpRequest(url, headers, cookies);
    try {
      return await runYtDlp({
        binary,
        args: buildArgs(extra, request.args),
        env: { ...toolEnvironment(runtime), ...request.env },
        timeoutMs: PROBE_TIMEOUT_MS,
        idleTimeoutMs: PROBE_IDLE_TIMEOUT_MS,
        collectStdout: true,
        maxStdoutBytes: MAX_PROBE_BYTES
      });
    } finally {
      await request.cleanup();
    }
  };
  let result = await run([]);
  if (
    genericFallback &&
    result.code !== 0 &&
    !result.timedOut &&
    /unsupported url|no suitable extractor|unable to extract|no video formats/i.test(result.stderr)
  ) {
    // Some sites expose their player only through an embedded page. The
    // generic extractor scans the HTML for a direct media URL.
    result = await run(['--force-generic-extractor']);
  }
  if (result.timedOut) {
    throw new DownloadError(`${siteLabel} took too long to respond. Try again in a moment.`, 'TIMEOUT', { retryable: true });
  }
  if (result.code !== 0) throw ytDlpFailure(result.stderr, siteLabel);
  let info: YtInfo;
  try {
    info = JSON.parse(result.stdout) as YtInfo;
  } catch {
    throw new DownloadError(`${siteLabel} returned an unreadable response. Try again.`, 'YOUTUBE_UNAVAILABLE', { retryable: true });
  }
  // Keep the extraction so the download can skip a second one.
  rememberInfoJson(url, headers, cookies, result.stdout);
  return buildYouTubeProbe(url, info, siteLabel);
}

function pageLabel(url: string, supplied?: string): string {
  const preferred = String(supplied ?? '').trim();
  if (preferred) return preferred.slice(0, 80);
  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, '');
    if (/(^|\.)(?:youtube\.com|youtube-nocookie\.com)$/i.test(hostname) || hostname === 'youtu.be') return 'YouTube';
    return hostname || 'This site';
  } catch {
    return 'This site';
  }
}

function requireYtDlp(runtime: EngineRuntime): string {
  if (!runtime.ytDlpPath) {
    throw new DownloadError(
      'yt-dlp is missing. Reinstall MDM or put yt-dlp.exe on PATH.',
      'TOOL_MISSING'
    );
  }
  return runtime.ytDlpPath;
}

function baseArgs(runtime: EngineRuntime): string[] {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-color',
    '--socket-timeout',
    '20',
    '--retries',
    '3',
    '--fragment-retries',
    '3'
  ];
  if (runtime.jsRuntimePath) args.push('--js-runtimes', `node:${runtime.jsRuntimePath}`);
  return args;
}

function toolEnvironment(runtime: EngineRuntime): NodeJS.ProcessEnv {
  if (!runtime.jsRuntimePath) return { ...process.env };
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
}

export function buildYouTubeProbe(url: string, source: YtInfo, siteLabel = 'YouTube'): MediaProbeResult {
  const info = source._type === 'playlist' && Array.isArray(source.entries) ? source.entries[0] ?? source : source;
  const title = sanitizeFileName(String(info.title ?? '').trim() || `${siteLabel} video`);
  const duration = Number.isFinite(info.duration) ? Number(info.duration) : null;
  if (info.is_live || (info.live_status && info.live_status !== 'not_live')) {
    return probeError(info, title, duration, `Live ${siteLabel} streams are not supported.`);
  }
  if (info._has_drm) {
    return probeError(info, title, duration, `This ${siteLabel} video is DRM-protected and cannot be downloaded.`);
  }
  const availability = String(info.availability ?? '').toLowerCase();
  if (availability === 'private') {
    return probeError(info, title, duration, `This ${siteLabel} video is private.`);
  }
  if (availability === 'premium' || availability === 'subscriber_only') {
    const audience = siteLabel === 'YouTube' ? 'channel members' : 'subscribers or members';
    return probeError(info, title, duration, `This ${siteLabel} video is available only to ${audience}.`);
  }
  if (availability === 'needs_auth') {
    return probeError(info, title, duration, `${siteLabel} requires a signed-in browser session for this video.`);
  }

  const formats = (Array.isArray(info.formats) ? info.formats : []).filter(
    (format) => typeof format.format_id === 'string' && format.format_id.length > 0
  );
  if (!formats.length) {
    return probeError(info, title, duration, `No downloadable ${siteLabel} formats were found.`);
  }

  const videos = formats.filter(isVideoFormat);
  const videosOnly = videos.filter((format) => !isAudioFormat(format));
  const combined = videos.filter(isAudioFormat);
  const audioOnly = formats.filter((format) => isAudioFormat(format) && !isVideoFormat(format));

  const mergeByHeight = (videoPool: YtFormat[]): MediaFormat[] => {
    const byHeight = new Map<number, YtFormat>();
    for (const format of videoPool) {
      const height = Number(format.height ?? 0);
      if (!height) continue;
      const current = byHeight.get(height);
      if (!current || videoScore(format) > videoScore(current)) byHeight.set(height, format);
    }

    const merged: MediaFormat[] = [];
    for (const height of Array.from(byHeight.keys()).sort((a, b) => b - a)) {
      const video = byHeight.get(height)!;
      const videoHasAudio = isAudioFormat(video);
      const audio = videoHasAudio ? null : chooseAudio(audioOnly, video.ext ?? '');
      if (!videoHasAudio && !audio) continue;
      const protectedFormat = Boolean(info._has_drm || video.has_drm || audio?.has_drm);
      const extension = extensionForYtFormat(video);
      const videoId = String(video.format_id);
      const audioId = audio ? String(audio.format_id) : '';
      const selector = audioId ? `${videoId}+${audioId}` : videoId;
      const fps = Number(video.fps ?? 0);
      const dynamicRange = String(video.dynamic_range ?? '').trim();
      const labelParts = [`${height}p`];
      if (dynamicRange && dynamicRange.toUpperCase() !== 'SDR') labelParts.push(dynamicRange);
      if (fps >= 50) labelParts.push(`${Math.round(fps)}fps`);
      const sizeBytes = estimatedSize(video) + (audio ? estimatedSize(audio) : 0);
      merged.push({
        id: `youtube:${height}:${selector}`,
        label: labelParts.join(' · '),
        url,
        bandwidth: Math.round((numberValue(video.tbr) + numberValue(audio?.tbr ?? audio?.abr)) * 1000),
        resolution: video.width && height ? `${Number(video.width)}x${height}` : `${height}p`,
        codecs: [video.vcodec, audio?.acodec].filter((value) => value && value !== 'none').join(', '),
        mimeType: mimeForExtension(extension),
        language: String(audio?.language ?? ''),
        protected: protectedFormat,
        type: 'youtube',
        sizeBytes: sizeBytes > 0 ? sizeBytes : undefined,
        formatSelector: selector
      });
    }
    return merged;
  };

  let formatsByHeight = mergeByHeight(videosOnly.length ? videosOnly : combined);
  if (!formatsByHeight.length && videosOnly.length && combined.length) {
    formatsByHeight = mergeByHeight(combined);
  }
  const audioFormats = buildYouTubeAudioFormats(audioOnly, url);

  if (!formatsByHeight.length && !audioFormats.length) {
    const hasProtected = formats.some((format) => format.has_drm);
    return probeError(
      info,
      title,
      duration,
      hasProtected
        ? `This ${siteLabel} video is DRM-protected and cannot be downloaded.`
        : `No downloadable ${siteLabel} formats were found.`
    );
  }
  const availableFormats = [...formatsByHeight, ...audioFormats];
  const preferred = availableFormats[0]!;
  const extension = extensionFromMimeType(preferred.mimeType);
  const hasProtected = availableFormats.every((format) => format.protected);
  return {
    kind: 'youtube',
    title,
    formats: availableFormats,
    durationSeconds: duration,
    protected: hasProtected,
    error: hasProtected ? `This ${siteLabel} video is DRM-protected and cannot be downloaded.` : '',
    suggestedFileName: `${title}${extension}`
  };
}

function buildYouTubeAudioFormats(audioOnly: YtFormat[], url: string): MediaFormat[] {
  const preferredOrder = ['m4a', 'mp3', 'webm', 'opus', 'ogg', 'aac', 'flac', 'wav'];
  const bestByExtension = new Map<string, YtFormat>();
  for (const format of audioOnly) {
    if (!format.format_id) continue;
    const extension = audioExtension(format);
    const current = bestByExtension.get(extension);
    const score = numberValue(format.abr ?? format.tbr) + numberValue(format.language_preference);
    const currentScore = current
      ? numberValue(current.abr ?? current.tbr) + numberValue(current.language_preference)
      : -1;
    if (!current || score > currentScore) bestByExtension.set(extension, format);
  }
  return Array.from(bestByExtension.entries())
    .sort(([leftExtension, left], [rightExtension, right]) => {
      const byExtension = preferredOrder.indexOf(leftExtension) - preferredOrder.indexOf(rightExtension);
      if (byExtension !== 0) return byExtension;
      return numberValue(right.abr ?? right.tbr) - numberValue(left.abr ?? left.tbr);
    })
    .map(([extension, format]) => {
      const bitrate = Math.round(numberValue(format.abr ?? format.tbr));
      const sizeBytes = estimatedSize(format);
      return {
        id: `youtube:audio:${format.format_id}`,
        label: `Audio ${extension.toUpperCase()}${bitrate ? ` ${bitrate} kbps` : ''}`,
        url,
        bandwidth: Math.round(numberValue(format.abr ?? format.tbr) * 1000),
        resolution: '',
        codecs: String(format.acodec ?? ''),
        mimeType: audioMimeForExtension(extension),
        language: String(format.language ?? ''),
        protected: Boolean(format.has_drm),
        type: 'youtube',
        sizeBytes: sizeBytes > 0 ? sizeBytes : undefined,
        formatSelector: String(format.format_id)
      } satisfies MediaFormat;
    });
}

function probeError(info: YtInfo, title: string, duration: number | null, error: string): MediaProbeResult {
  return {
    kind: 'youtube',
    title,
    formats: [],
    durationSeconds: duration,
    protected: Boolean(info._has_drm),
    error,
    suggestedFileName: `${title}.mp4`
  };
}

function isVideoFormat(format: YtFormat): boolean {
  const codec = String(format.vcodec ?? '').toLowerCase();
  return Boolean(codec && codec !== 'none' && Number(format.height ?? 0) > 0) && !/storyboard/i.test(String(format.format_note ?? ''));
}

function isAudioFormat(format: YtFormat): boolean {
  const codec = String(format.acodec ?? '').toLowerCase();
  return Boolean(codec && codec !== 'none');
}

function videoScore(format: YtFormat): number {
  const extension = String(format.ext ?? '').toLowerCase();
  const codec = String(format.vcodec ?? '').toLowerCase();
  let score = 0;
  if (extension === 'mp4' && codec.startsWith('avc')) score += 60;
  else if (extension === 'mp4') score += 50;
  else if (extension === 'webm' && codec.startsWith('vp')) score += 35;
  else if (extension === 'webm') score += 30;
  else score += 10;
  if (!/m3u8|m3u/i.test(String(format.protocol ?? ''))) score += 5;
  if (Number(format.fps ?? 0) >= 50) score += 3;
  if (!String(format.dynamic_range ?? '').toUpperCase().includes('HDR')) score += 1;
  return score * 1_000_000 + numberValue(format.tbr);
}

function chooseAudio(formats: YtFormat[], videoExtension: string): YtFormat | null {
  if (!formats.length) return null;
  const preferred = videoExtension === 'webm' ? 'webm' : 'm4a';
  return formats
    .slice()
    .sort((a, b) => {
      const aPreferred = String(a.ext ?? '').toLowerCase() === preferred ? 1 : 0;
      const bPreferred = String(b.ext ?? '').toLowerCase() === preferred ? 1 : 0;
      if (aPreferred !== bPreferred) return bPreferred - aPreferred;
      const aLanguage = numberValue(a.language_preference);
      const bLanguage = numberValue(b.language_preference);
      if (aLanguage !== bLanguage) return bLanguage - aLanguage;
      return numberValue(b.abr ?? b.tbr) - numberValue(a.abr ?? a.tbr);
    })[0] ?? null;
}

function estimatedSize(format: YtFormat | null | undefined): number {
  if (!format) return 0;
  return numberValue(format.filesize) || numberValue(format.filesize_approx);
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function extensionForYtFormat(format: YtFormat): string {
  const extension = String(format.ext ?? '').toLowerCase();
  return extension === 'webm' ? 'webm' : 'mp4';
}

function mimeForExtension(extension: string): string {
  return extension === 'webm' ? 'video/webm' : 'video/mp4';
}

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'webm', 'opus', 'ogg', 'aac', 'flac', 'wav']);

function audioExtension(format: YtFormat): string {
  const extension = String(format.ext ?? '').toLowerCase();
  return AUDIO_EXTENSIONS.has(extension) ? extension : 'm4a';
}

function audioMimeForExtension(extension: string): string {
  switch (extension) {
    case 'mp3':
      return 'audio/mpeg';
    case 'webm':
      return 'audio/webm';
    case 'opus':
      return 'audio/opus';
    case 'ogg':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    default:
      return 'audio/mp4';
  }
}

function extensionFromMimeType(mimeType: string): string {
  const mime = mimeType.toLowerCase();
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
  return mime.includes('webm') ? '.webm' : '.mp4';
}

/** What yt-dlp prints when ffmpeg or ffprobe really cannot be used. A bare mention of the word is not enough. */
const FFMPEG_MISSING =
  /ffmpeg(?:\.exe)?(?: and ffprobe)? (?:is )?not (?:found|installed)|ffprobe and ffmpeg not found|requested merging of multiple formats but ffmpeg is not installed|ffmpeg-location[^\n]*does not exist|no such file or directory[^\n]*ff(?:mpeg|probe)/i;

export function ytDlpFailure(stderr: string, siteLabel = 'YouTube'): DownloadError {
  const text = stderr.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const errorLine = /^(?:ERROR|yt-dlp(?:\.exe)?: error):\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
  const lower = text.toLowerCase();
  if (/no such option|unrecognized arguments|invalid choice|invalid option/.test(lower)) {
    return new DownloadError(
      `The bundled yt-dlp rejected an MDM download option. Update MDM and try again.`,
      'INTERNAL'
    );
  }
  if (/sign in to confirm|not a bot|confirm you.re not a bot|use --cookies/.test(lower)) {
    return new DownloadError(
      `${siteLabel} requires a signed-in browser session for this video. Open ${siteLabel}, sign in, then try again.`,
      'YOUTUBE_UNAVAILABLE'
    );
  }
  if (/private video|video is private/.test(lower)) {
    return new DownloadError(`This ${siteLabel} video is private.`, 'YOUTUBE_UNAVAILABLE');
  }
  if (/members-only|join this channel|channel members|subscriber_only/.test(lower)) {
    const audience = siteLabel === 'YouTube' ? 'channel members' : 'subscribers or members';
    return new DownloadError(`This ${siteLabel} video is available only to ${audience}.`, 'YOUTUBE_UNAVAILABLE');
  }
  if (/age-restricted|age restricted|inappropriate for some users/.test(lower)) {
    return new DownloadError(`This ${siteLabel} video is age-restricted and cannot be downloaded.`, 'YOUTUBE_UNAVAILABLE');
  }
  if (/drm|protected/.test(lower)) {
    return new DownloadError(`This ${siteLabel} video is DRM-protected and cannot be downloaded.`, 'YOUTUBE_UNAVAILABLE');
  }
  if (/requested format is not available|requested format not available/.test(lower)) {
    return new DownloadError(`The selected ${siteLabel} format is no longer available. Refresh the page and try again.`, 'YOUTUBE_UNAVAILABLE');
  }
  if (FFMPEG_MISSING.test(text)) {
    return new DownloadError('FFmpeg is required to merge the downloaded video and audio. Install FFmpeg or put it on PATH.', 'TOOL_MISSING');
  }
  if (/video unavailable|not available in your country|has been removed|this video is unavailable/.test(lower)) {
    return new DownloadError(`This ${siteLabel} video is not available.`, 'YOUTUBE_UNAVAILABLE');
  }
  const message = errorLine.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '').slice(0, 500);
  return new DownloadError(
    message ? `${siteLabel} could not prepare this download: ${message}` : `${siteLabel} could not prepare this download. Try again.`,
    'YOUTUBE_UNAVAILABLE'
  );
}

export class YtDlpDownloadTask {
  private readonly config: DownloadConfig;
  private readonly runtime: EngineRuntime;
  private readonly callbacks: EngineCallbacks;
  private paused = false;
  private canceled = false;
  private prepared: PreparedDownload | null = null;
  private state: YouTubeState | null = null;
  private child: ChildProcess | null = null;
  private poller: NodeJS.Timeout | null = null;
  private polling = false;
  private downloadedBytes = 0;
  private lastSampledBytes = 0;
  private lastSampleAt = 0;
  private speedBps = 0;
  private totalBytes: number | null = null;
  private lastProgressAt = 0;
  private lastCheckpointAt = 0;
  private printedPath = '';

  private get siteLabel(): string {
    return pageLabel(this.config.url);
  }

  constructor(config: DownloadConfig, runtime: EngineRuntime, callbacks: EngineCallbacks) {
    this.config = config;
    this.runtime = runtime;
    this.callbacks = callbacks;
  }

  pause(): void {
    if (this.canceled || this.paused) return;
    this.paused = true;
    this.stopProcess();
  }

  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    this.stopProcess();
  }

  async run(): Promise<EngineOutcome> {
    try {
      await this.prepare();
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) {
        await this.cleanupTemp();
        return { status: 'canceled' };
      }
      await this.download();
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) {
        await this.cleanupTemp();
        return { status: 'canceled' };
      }
      return await this.finalize();
    } catch (error) {
      if (this.canceled) {
        await this.cleanupTemp();
        return { status: 'canceled' };
      }
      if (this.paused) return this.pausedOutcome();
      if (error instanceof DownloadError) throw error;
      throw new DownloadError(
        error instanceof Error ? error.message : `The ${this.siteLabel} download failed.`,
        'NETWORK',
        { retryable: true, cause: error }
      );
    } finally {
      this.stopPoller();
    }
  }

  private async prepare(): Promise<void> {
    requireYtDlp(this.runtime);
    const format = this.config.mediaFormat;
    const selector = format?.formatSelector?.trim() ?? '';
    if (!format || format.type !== 'youtube' || !SELECTOR_PATTERN.test(selector)) {
      throw new DownloadError(`The selected ${this.siteLabel} format is missing. Add the video again.`, 'YOUTUBE_UNAVAILABLE');
    }
    if (selector.includes('+') && !this.runtime.ffmpegPath) {
      throw new DownloadError(
        'FFmpeg is required to merge the downloaded video and audio. Install FFmpeg or put it on PATH.',
        'TOOL_MISSING'
      );
    }

    const extension = extensionFromMimeType(format.mimeType);
    const baseTitle = sanitizeFileName(
      this.config.fileNameExplicit && this.config.fileName
        ? this.config.fileName
        : this.config.fileName || format.label || 'youtube-video'
    );
    const fileName = sanitizeFileName(`${baseTitle.replace(/\.[a-z0-9]{2,10}$/i, '')}${extension}`);
    let destinationDir = path.resolve(this.config.destinationDir);
    if (this.runtime.resolveDirectory) {
      destinationDir = await this.runtime.resolveDirectory(fileName, format.mimeType);
    }
    await fsp.mkdir(destinationDir, { recursive: true });

    const tempPath = this.config.resume?.tempPath
      ? path.resolve(this.config.resume.tempPath)
      : path.join(destinationDir, `.mdm-yt-${this.config.id}`);
    const priorState = this.parseState(this.config.resume?.mediaState);
    if (priorState && (priorState.selector !== selector || priorState.extension !== extension)) {
      await fsp.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.ensureTempDirectory(tempPath);
    const existingBytes = await directorySize(tempPath);
    const targetPath = await resolveTargetPath(
      destinationDir,
      fileName,
      this.config.conflictPolicy,
      this.runtime.reservedTargetPaths ?? new Set<string>()
    );
    this.state = { v: 1, selector, extension };
    this.downloadedBytes = existingBytes;
    this.lastSampledBytes = existingBytes;
    this.lastSampleAt = Date.now();
    this.totalBytes = format.sizeBytes && format.sizeBytes > 0 ? format.sizeBytes : null;
    await checkDiskSpace(destinationDir, this.totalBytes, this.runtime.diskSpaceProbe);

    const segment: DownloadSegment = {
      index: 0,
      startByte: 0,
      endByte: this.totalBytes ? this.totalBytes - 1 : null,
      downloadedBytes: existingBytes,
      status: 'active'
    };
    this.prepared = {
      finalUrl: this.config.url,
      fileName,
      destinationDir,
      targetPath,
      tempPath,
      totalBytes: this.totalBytes,
      downloadedBytes: existingBytes,
      resumable: true,
      etag: '',
      lastModified: '',
      mimeType: format.mimeType,
      segments: [segment],
      kind: 'youtube',
      mediaState: JSON.stringify(this.state)
    };
    await this.callbacks.onPrepared(this.prepared, [this.config.url]);
    await this.saveCheckpoint('downloading');
    this.emitProgress('downloading');
  }

  private async download(): Promise<void> {
    if (!this.prepared || !this.state) throw new DownloadError(`${this.siteLabel} download not prepared.`, 'INTERNAL');
    const binary = requireYtDlp(this.runtime);
    const buildArgs = (infoJsonPath: string | null, requestArgs: string[], extra: string[] = []): string[] =>
      buildYtDlpDownloadArgs({
        baseArgs: baseArgs(this.runtime),
        selector: this.state!.selector,
        mergeFormat: this.state!.extension === 'webm' ? 'webm' : 'mp4',
        output: path.join(this.prepared!.tempPath, 'media.%(ext)s'),
        infoJsonPath,
        ffmpegPath: this.runtime.ffmpegPath,
        requestArgs,
        extra,
        url: this.config.url
      });
    const runAttempt = async (
      infoJsonPath: string | null,
      extra: string[] = []
    ): Promise<YtDlpRunResult> => {
      const request = await prepareYtDlpRequest(this.config.url, this.config.headers, this.config.cookies);
      try {
        return await runYtDlp({
          binary,
          args: buildArgs(infoJsonPath, request.args, extra),
          env: { ...toolEnvironment(this.runtime), ...request.env },
          idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
          onSpawn: (child) => {
            this.child = child;
            if (this.paused || this.canceled) terminateProcess(child);
          },
          onStdoutLine: (line) => this.handleStdoutLine(line),
          onStderrLine: (line) => this.handleStderrLine(line)
        });
      } finally {
        await request.cleanup();
      }
    };
    // Prefer the saved quality-list extraction: no second page extraction,
    // no repeated JS-challenge solving. Falls back to a fresh URL extraction
    // when the cached data is rejected (e.g. signed URLs expired).
    const cachedInfo = takeInfoJson(this.config.url, this.config.headers, this.config.cookies);
    let infoPath: string | null = null;
    if (cachedInfo) {
      infoPath = path.join(this.prepared.tempPath, 'mdm-info.json');
      await fsp.writeFile(infoPath, cachedInfo, 'utf8').catch(() => {
        infoPath = null;
      });
    }
    this.startPoller();
    let result: YtDlpRunResult;
    try {
      result = await runAttempt(infoPath);
      if (infoPath && result.code !== 0 && !result.timedOut) {
        this.callbacks.onLog('warn', 'The saved video data was rejected; extracting the page again.');
        result = await runAttempt(null);
      }
      if (
        this.siteLabel !== 'YouTube' &&
        result.code !== 0 &&
        !result.timedOut &&
        /unsupported url|no suitable extractor|unable to extract|no video formats/i.test(result.stderr)
      ) {
        this.callbacks.onLog('warn', 'Retrying this page with the generic extractor.');
        result = await runAttempt(null, ['--force-generic-extractor']);
      }
    } finally {
      this.child = null;
      if (infoPath) await fsp.rm(infoPath, { force: true }).catch(() => undefined);
    }
    this.stopPoller();
    await this.refreshProgress(true);
    if (this.paused || this.canceled) return;
    if (result.timedOut) {
      throw new DownloadError('yt-dlp stopped responding. The download can be resumed.', 'TIMEOUT', { retryable: true });
    }
    if (result.code !== 0) throw ytDlpFailure(result.stderr, this.siteLabel);
  }

  private handleStdoutLine(line: string): void {
    const clean = line.trim();
    if (clean.startsWith('MDM_FILE ')) {
      this.printedPath = clean.slice('MDM_FILE '.length).trim();
      return;
    }
    if (clean.startsWith('MDM_PROGRESS ')) {
      const [downloaded, total, estimate] = clean.slice('MDM_PROGRESS '.length).split('|');
      const totalBytes = numberValue(total) || numberValue(estimate);
      if (totalBytes > 0 && (!this.totalBytes || totalBytes > this.totalBytes)) {
        this.totalBytes = totalBytes;
        if (this.prepared) this.prepared.totalBytes = totalBytes;
      }
      const bytes = numberValue(downloaded);
      if (bytes > this.downloadedBytes) this.downloadedBytes = bytes;
    }
  }

  private handleStderrLine(line: string): void {
    const clean = line.trim();
    if (!clean || /^WARNING:/.test(clean)) return;
    if (/^ERROR:/.test(clean)) this.callbacks.onLog('error', clean.slice(0, 1000));
  }

  private startPoller(): void {
    this.stopPoller();
    this.poller = setInterval(() => {
      void this.refreshProgress(false);
    }, PROGRESS_INTERVAL_MS);
    this.poller.unref?.();
  }

  private stopPoller(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private async refreshProgress(final: boolean): Promise<void> {
    if (!this.prepared || this.polling) return;
    this.polling = true;
    try {
      const bytes = await directorySize(this.prepared.tempPath);
      const now = Date.now();
      if (bytes > this.downloadedBytes) {
        this.downloadedBytes = bytes;
        const elapsed = (now - this.lastSampleAt) / 1000;
        if (elapsed > 0) {
          const instant = Math.max(0, (bytes - this.lastSampledBytes) / elapsed);
          this.speedBps = this.speedBps > 0 ? this.speedBps * 0.6 + instant * 0.4 : instant;
        }
      }
      this.lastSampledBytes = bytes;
      this.lastSampleAt = now;
      this.refreshSegment();
      if (final || now - this.lastProgressAt >= PROGRESS_INTERVAL_MS) {
        this.lastProgressAt = now;
        this.emitProgress('downloading');
      }
      if (now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        await this.saveCheckpoint('downloading');
      }
    } finally {
      this.polling = false;
    }
  }

  private refreshSegment(): void {
    if (!this.prepared) return;
    const segment = this.prepared.segments[0];
    if (!segment) return;
    segment.downloadedBytes = this.downloadedBytes;
    segment.endByte = this.totalBytes ? this.totalBytes - 1 : null;
    this.prepared.downloadedBytes = this.downloadedBytes;
    this.prepared.totalBytes = this.totalBytes;
  }

  private emitProgress(status: 'downloading' | 'finalizing'): void {
    const total = this.totalBytes;
    const eta = this.speedBps > 0 && total ? Math.max(0, (total - this.downloadedBytes) / this.speedBps) : null;
    this.callbacks.onProgress({
      status,
      downloadedBytes: this.downloadedBytes,
      totalBytes: total,
      speedBps: status === 'finalizing' ? 0 : this.speedBps,
      etaSeconds: status === 'finalizing' ? null : eta,
      segments: this.prepared ? this.prepared.segments.map((segment) => ({ ...segment })) : [],
      attempts: 0
    });
  }

  private async saveCheckpoint(status: 'downloading' | 'paused'): Promise<void> {
    if (!this.prepared) return;
    this.refreshSegment();
    this.lastCheckpointAt = Date.now();
    const checkpoint: EngineCheckpoint = {
      prepared: {
        ...this.prepared,
        segments: this.prepared.segments.map((segment) => ({ ...segment }))
      },
      status,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      attempts: 0,
      mediaState: this.prepared.mediaState
    };
    await this.callbacks.onCheckpoint(checkpoint);
  }

  private async finalize(): Promise<EngineOutcome> {
    if (!this.prepared) throw new DownloadError(`${this.siteLabel} download not prepared.`, 'INTERNAL');
    this.stopPoller();
    await this.refreshProgress(true);
    const output = await this.findOutputFile(this.prepared.tempPath);
    const stat = await fsp.stat(output);
    const total = stat.size;
    let checksumStatus: ChecksumStatus = 'none';
    if (this.config.checksum && this.config.checksumAlgorithm) {
      const actual = await hashFile(output, this.config.checksumAlgorithm);
      if (actual.toLowerCase() !== this.config.checksum.trim().toLowerCase()) {
        throw new DownloadError('Checksum mismatch.', 'CHECKSUM_MISMATCH');
      }
      checksumStatus = 'verified';
    }
    this.downloadedBytes = total;
    this.totalBytes = total;
    this.speedBps = 0;
    this.refreshSegment();
    this.emitProgress('finalizing');
    const placed = await atomicPlace(
      output,
      this.prepared.targetPath,
      this.config.conflictPolicy === 'overwrite',
      { sourceUrl: this.config.url, referrer: this.config.referrer }
    );
    this.prepared.fileName = path.basename(placed);
    this.prepared.targetPath = placed;
    this.prepared.totalBytes = total;
    this.prepared.downloadedBytes = total;
    this.prepared.mediaState = JSON.stringify(this.state);
    await fsp.rm(this.prepared.tempPath, { recursive: true, force: true }).catch(() => undefined);
    return {
      status: 'completed',
      result: {
        fileName: path.basename(placed),
        targetPath: placed,
        finalUrl: this.config.url,
        totalBytes: total,
        downloadedBytes: total,
        checksumStatus,
        segments: [
          { index: 0, startByte: 0, endByte: total > 0 ? total - 1 : null, downloadedBytes: total, status: 'complete' }
        ],
        mimeType: this.prepared.mimeType,
        mediaState: this.prepared.mediaState
      }
    };
  }

  private async pausedOutcome(): Promise<EngineOutcome> {
    this.stopPoller();
    if (!this.prepared) return { status: 'paused', checkpoint: null };
    this.refreshSegment();
    this.speedBps = 0;
    const checkpoint: EngineCheckpoint = {
      prepared: {
        ...this.prepared,
        segments: this.prepared.segments.map((segment) => ({ ...segment }))
      },
      status: 'paused',
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      attempts: 0,
      mediaState: this.prepared.mediaState
    };
    return { status: 'paused', checkpoint };
  }

  private async findOutputFile(tempDir: string): Promise<string> {
    if (this.printedPath) {
      const candidate = path.resolve(this.printedPath);
      if (isInside(tempDir, candidate) && (await isFile(candidate))) return candidate;
    }
    const entries = await fsp.readdir(tempDir, { withFileTypes: true }).catch(() => []);
    const files: Array<{ filePath: string; size: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(mp4|webm|mkv|m4a|mp3|opus|ogg|aac|flac|wav)$/i.test(entry.name)) continue;
      const filePath = path.join(tempDir, entry.name);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat?.isFile()) files.push({ filePath, size: stat.size });
    }
    files.sort((a, b) => b.size - a.size);
    if (!files[0]) {
      throw new DownloadError('yt-dlp did not produce a downloadable file.', 'YOUTUBE_UNAVAILABLE', { retryable: true });
    }
    return files[0].filePath;
  }

  private async ensureTempDirectory(tempPath: string): Promise<void> {
    const stat = await fsp.stat(tempPath).catch(() => null);
    if (stat && !stat.isDirectory()) await fsp.rm(tempPath, { force: true });
    await fsp.mkdir(tempPath, { recursive: true });
  }

  private async cleanupTemp(): Promise<void> {
    this.stopPoller();
    if (!this.prepared) return;
    await fsp.rm(this.prepared.tempPath, { recursive: true, force: true }).catch(() => undefined);
  }

  private parseState(mediaState: string | undefined): YouTubeState | null {
    if (!mediaState) return null;
    try {
      const state = JSON.parse(mediaState) as YouTubeState;
      return state?.v === 1 && typeof state.selector === 'string' ? state : null;
    } catch {
      return null;
    }
  }

  private stopProcess(): void {
    this.stopPoller();
    if (this.child) terminateProcess(this.child);
  }
}

function runYtDlp(options: YtDlpRunOptions): Promise<YtDlpRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.binary, options.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ?? { ...process.env }
      });
    } catch (error) {
      reject(
        new DownloadError(
          `yt-dlp could not be started: ${(error as Error).message}`,
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'TOOL_MISSING' : 'INTERNAL',
          { cause: error }
        )
      );
      return;
    }

    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let outBuffer = '';
    let errBuffer = '';
    let idleTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    const maxStdout = options.maxStdoutBytes ?? MAX_PROBE_BYTES;
    options.onSpawn?.(child);

    const finish = (error: Error | null, value?: YtDlpRunResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (error) reject(error);
      else resolve(value!);
    };

    const timeout = (): void => {
      timedOut = true;
      terminateProcess(child);
    };

    const resetIdle = (): void => {
      if (!options.idleTimeoutMs || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(timeout, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    if (options.timeoutMs) {
      hardTimer = setTimeout(timeout, options.timeoutMs);
      hardTimer.unref?.();
    }
    resetIdle();

    const feed = (chunk: string, isStdout: boolean): void => {
      resetIdle();
      if (isStdout) {
        if (options.collectStdout) {
          if (stdout.length + chunk.length > maxStdout) {
            terminateProcess(child);
            finish(new DownloadError('The media response was unexpectedly large.', 'YOUTUBE_UNAVAILABLE'));
            return;
          }
          stdout += chunk;
        }
        if (!options.onStdoutLine) return;
        outBuffer += chunk;
        const lines = outBuffer.split(/\r?\n/);
        outBuffer = lines.pop() ?? '';
        for (const line of lines) options.onStdoutLine(line);
        return;
      }
      stderr = (stderr + chunk).slice(-MAX_ERROR_BYTES);
      if (!options.onStderrLine) return;
      errBuffer += chunk;
      const lines = errBuffer.split(/\r?\n/);
      errBuffer = lines.pop() ?? '';
      for (const line of lines) options.onStderrLine(line);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => feed(chunk, true));
    child.stderr?.on('data', (chunk: string) => feed(chunk, false));
    child.on('error', (error) => {
      finish(
        new DownloadError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'yt-dlp is missing. Reinstall MDM or put yt-dlp.exe on PATH.'
            : `yt-dlp could not be started: ${error.message}`,
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'TOOL_MISSING' : 'INTERNAL',
          { cause: error }
        )
      );
    });
    child.on('close', (code) => {
      if (outBuffer && options.onStdoutLine) options.onStdoutLine(outBuffer);
      if (errBuffer && options.onStderrLine) options.onStderrLine(errBuffer);
      finish(null, { code, stdout, stderr, timedOut });
    });
  });
}

function terminateProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn(systemExecutable('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('error', () => undefined);
      killer.unref();
    } catch {
      // Fall through to child.kill.
    }
  }
  try {
    child.kill();
  } catch {
    // The process may have already exited.
  }
}

async function directorySize(directory: string): Promise<number> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(path.join(directory, entry.name)).catch(() => null);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isFile(target: string): Promise<boolean> {
  const stat = await fsp.stat(target).catch(() => null);
  return stat?.isFile() ?? false;
}
