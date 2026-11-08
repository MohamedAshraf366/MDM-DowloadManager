export type DownloadStatus =
  | 'queued'
  | 'scheduled'
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

export type DownloadKind = 'http' | 'ftp' | 'hls' | 'dash' | 'youtube';
export type DownloadPriority = 'low' | 'normal' | 'high';
export type ChecksumAlgorithm = 'sha256' | 'sha1' | 'md5';
export type ChecksumStatus = 'pending' | 'verified' | 'mismatch' | 'none';
export type IpVersion = 'any' | 'ipv4' | 'ipv6';
export type ThemeMode = 'light' | 'dark' | 'system';
/** How speeds are shown: bytes per second (MB/s) or decimal bits per second (Mbit/s), as speed tests quote them. */
export type SpeedUnit = 'bytes' | 'bits';
export type FileCategory =
  | 'video'
  | 'audio'
  | 'documents'
  | 'archives'
  | 'images'
  | 'programs'
  | 'other';

export interface DownloadSegment {
  index: number;
  startByte: number;
  endByte: number | null;
  downloadedBytes: number;
  status: 'pending' | 'active' | 'complete' | 'failed';
}

export interface DownloadRecord {
  id: string;
  kind: DownloadKind;
  url: string;
  finalUrl: string | null;
  fileName: string;
  fileNameExplicit: boolean;
  destinationDir: string;
  destinationExplicit: boolean;
  tlsAllowInsecure: boolean;
  targetPath: string | null;
  tempPath: string | null;
  category: FileCategory;
  queueId: string;
  status: DownloadStatus;
  priority: DownloadPriority;
  totalBytes: number | null;
  downloadedBytes: number;
  resumable: boolean;
  connections: number;
  turboMode?: boolean;
  repeatCount?: number;
  repeatTotal?: number;
  speedLimitBps: number;
  headers: Record<string, string>;
  cookies: string;
  referrer: string;
  mimeType: string;
  etag: string;
  lastModified: string;
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm | '';
  checksumStatus: ChecksumStatus;
  error: string;
  errorCode: string;
  retryCount: number;
  maxRetries: number;
  speedBps: number;
  etaSeconds: number | null;
  segments: DownloadSegment[];
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  autoOpen: boolean;
  autoDelete: boolean;
  mediaFormatJson: string;
  mediaState: string;
  sourcePageUrl: string;
  recordLog: RecordLogEntry[];
}

export interface RecordLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type QueueCompletionAction = 'none' | 'notify' | 'shutdown';

export interface QueueRecord {
  id: string;
  name: string;
  priority: number;
  maxConcurrent: number;
  speedLimitBps: number;
  status: 'active' | 'paused';
  isDefault: boolean;
  onComplete: QueueCompletionAction;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleAction = 'start_queue' | 'stop_queue' | 'start_all' | 'pause_all';

export interface ScheduleRecord {
  id: string;
  name: string;
  queueId: string | null;
  action: ScheduleAction;
  days: number[];
  startTime: string;
  stopTime: string;
  enabled: boolean;
  lastFiredKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchType: 'extension' | 'mime' | 'host';
  pattern: string;
  category: FileCategory;
  destinationDir: string;
  autoOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SiteAction = 'auto' | 'ask' | 'ignore';

export interface SiteRule {
  id: string;
  name: string;
  pattern: string;
  action: SiteAction;
  fileTypes: string[];
  destinationDir: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxySettings {
  mode: 'none' | 'system' | 'manual';
  protocol: 'http' | 'https';
  host: string;
  port: number;
  username: string;
  passwordSet: boolean;
  bypass: string;
}

export interface AppSettings {
  theme: ThemeMode;
  speedUnit: SpeedUnit;
  defaultDownloadDir: string;
  categoryFolders: Record<FileCategory, string>;
  categorizeByType: boolean;
  defaultConnections: number;
  maxConcurrentDownloads: number;
  maxConnectionsPerHost: number;
  /** Add connections during a download until throughput stops rising. */
  turboMode: boolean;
  /** Most connections Turbo may use for one download. */
  turboMaxConnections: number;
  /**
   * Optional speed-test result in Mbit/s; 0 = none (MDM learns each network by itself).
   * A starting point for Turbo only, never a limit.
   */
  lineSpeedMbps: number;
  globalSpeedLimitBps: number;
  defaultSpeedLimitBps: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  maxRedirects: number;
  duplicatePolicy: 'rename' | 'overwrite' | 'skip' | 'allow';
  autoOpenCompleted: boolean;
  autoResumeOnStartup: boolean;
  launchAtStartup: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  notificationsEnabled: boolean;
  notifyOnStart: boolean;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  nativeNotificationsWhenActive: boolean;
  showProgressInTaskbar: boolean;
  proxy: ProxySettings;
  ipVersion: IpVersion;
  userAgentMode: 'default' | 'custom';
  userAgent: string;
  browserIntegrationEnabled: boolean;
  bridgePort: number;
  bridgeToken: string;
  autoShutdownAfterQueue: boolean;
  loggingLevel: 'error' | 'warn' | 'info' | 'debug';
  confirmDestructiveActions: boolean;
  checksumAlgorithm: ChecksumAlgorithm | '';
  showExtensionSetupOnStartup: boolean;
}

export interface SettingsUpdate {
  patch: Partial<AppSettings>;
  proxyPassword?: string;
}

export interface LogRecord {
  id: number;
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  scope: string;
  message: string;
  detail: string;
}

export interface MediaFormat {
  id: string;
  label: string;
  url: string;
  bandwidth: number;
  resolution: string;
  codecs: string;
  mimeType: string;
  language: string;
  protected: boolean;
  type: 'hls' | 'dash' | 'youtube';
  sizeBytes?: number;
  formatSelector?: string;
}

export interface MediaProbeResult {
  kind: DownloadKind;
  title: string;
  formats: MediaFormat[];
  durationSeconds: number | null;
  protected: boolean;
  error: string;
  suggestedFileName: string;
}

export interface AddDownloadRequest {
  url: string;
  destinationDir?: string;
  fileName?: string;
  queueId?: string;
  priority?: DownloadPriority;
  speedLimitBps?: number;
  startNow?: boolean;
  scheduledAt?: string | null;
  checksum?: string;
  checksumAlgorithm?: ChecksumAlgorithm | '';
  headers?: Record<string, string>;
  cookies?: string;
  referrer?: string;
  sourcePageUrl?: string;
  mediaFormatId?: string;
  mediaEngine?: 'yt-dlp';
  tlsAllowInsecure?: boolean;
  autoOpen?: boolean;
  autoDelete?: boolean;
  turboMode?: boolean;
  connections?: number;
  repeatCount?: number;
  /** Internal: size of the whole batch, carried from copy to copy. */
  repeatTotal?: number;
  overrides?: {
    fileName?: string;
    mimeType?: string;
    headers?: Record<string, string>;
  };
}

export interface DownloadListFilter {
  status?: DownloadStatus | 'all';
  queueId?: string;
  search?: string;
  sortBy?: 'created' | 'name' | 'size' | 'progress' | 'speed' | 'status' | 'priority';
  sortDirection?: 'asc' | 'desc';
}

export interface Stats {
  active: number;
  queued: number;
  completed: number;
  failed: number;
  totalBytes: number;
  totalDownloaded: number;
  currentSpeed: number;
}

export interface Snapshot {
  downloads: DownloadRecord[];
  queues: QueueRecord[];
  schedules: ScheduleRecord[];
  rules: CategoryRule[];
  siteRules: SiteRule[];
  settings: AppSettings;
  stats: Stats;
  version: string;
  bridge: { enabled: boolean; port: number; token: string };
}

export interface DownloadProgressEvent {
  id: string;
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSeconds: number | null;
  segments: DownloadSegment[];
  attempts: number;
}

export type DownloadLifecycleState = 'request-received' | 'queued' | 'started' | 'completed' | 'failed' | 'cancelled';

export interface DownloadLifecycleEvent {
  id: string;
  state: DownloadLifecycleState;
  record: DownloadRecord;
  at: string;
  errorCode?: string;
}

export interface DownloadFinishedEvent {
  download: DownloadRecord;
  notification?: { title: string; body: string };
}

export interface BrowserBridgeRequest {
  url: string;
  fileName?: string;
  headers?: Record<string, string>;
  cookies?: string;
  referrer?: string;
  sourcePageUrl?: string;
  queueId?: string;
  autoStart?: boolean;
  mediaFormatId?: string;
  mediaEngine?: 'yt-dlp';
  confirmDownload?: boolean;
  mediaTitle?: string;
  mediaQuality?: string;
}

export interface BrowserDownloadConfirmation {
  request: BrowserBridgeRequest;
  destinationDir: string;
}

export interface ImportExportBundle {
  kind: 'mdm-queue-export';
  version: 1;
  exportedAt: string;
  downloads?: AddDownloadRequest[];
  queues?: Array<Pick<QueueRecord, 'name' | 'priority' | 'maxConcurrent' | 'speedLimitBps' | 'onComplete'> & { id?: string }>;
  schedules?: Array<Pick<ScheduleRecord, 'name' | 'queueId' | 'action' | 'days' | 'startTime' | 'stopTime' | 'enabled'>>;
}

export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface UpdateDownloadOptions {
  fileName?: string;
  destinationDir?: string;
  url?: string;
  speedLimitBps?: number;
  headers?: Record<string, string>;
  cookies?: string;
  referrer?: string;
  checksum?: string;
  checksumAlgorithm?: ChecksumAlgorithm | '';
  autoOpen?: boolean;
  autoDelete?: boolean;
}

export interface AddDownloadResult {
  id: string;
  duplicateOf?: string;
}

export interface QueueInput {
  id?: string;
  name: string;
  priority: number;
  maxConcurrent: number;
  speedLimitBps: number;
  onComplete: QueueCompletionAction;
}

export interface ScheduleInput {
  id?: string;
  name: string;
  queueId: string | null;
  action: ScheduleAction;
  days: number[];
  startTime: string;
  stopTime: string;
  enabled: boolean;
}

export interface RuleInput {
  id?: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchType: 'extension' | 'mime' | 'host';
  pattern: string;
  category: FileCategory;
  destinationDir: string;
  autoOpen: boolean;
}

export interface SiteRuleInput {
  id?: string;
  name: string;
  pattern: string;
  action: SiteAction;
  fileTypes: string[];
  destinationDir: string;
  enabled: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  userDataPath: string;
  downloadsPath: string;
  ffmpegAvailable: boolean;
  ytDlpAvailable: boolean;
  extensionPath: string;
}

export interface IpcApi {
  getSnapshot(): Promise<IpcResult<Snapshot>>;
  getAppInfo(): Promise<IpcResult<AppInfo>>;
  addDownload(request: AddDownloadRequest): Promise<IpcResult<AddDownloadResult>>;
  updateDownload(id: string, update: UpdateDownloadOptions): Promise<IpcResult<DownloadRecord>>;
  pauseDownload(id: string): Promise<IpcResult<void>>;
  resumeDownload(id: string): Promise<IpcResult<void>>;
  cancelDownload(id: string): Promise<IpcResult<void>>;
  retryDownload(id: string): Promise<IpcResult<void>>;
  restartDownload(id: string): Promise<IpcResult<void>>;
  removeDownload(id: string, deleteFile: boolean): Promise<IpcResult<void>>;
  pauseAll(): Promise<IpcResult<void>>;
  resumeAll(): Promise<IpcResult<void>>;
  clearCompleted(): Promise<IpcResult<void>>;
  setPriority(id: string, priority: DownloadPriority): Promise<IpcResult<void>>;
  moveToQueue(ids: string[], queueId: string): Promise<IpcResult<void>>;
  verifyDownload(id: string): Promise<IpcResult<DownloadRecord>>;
  revealFile(id: string): Promise<IpcResult<void>>;
  openFile(id: string): Promise<IpcResult<void>>;
  openFolder(id: string): Promise<IpcResult<void>>;
  probeMedia(url: string, headers?: Record<string, string>, cookies?: string): Promise<IpcResult<MediaProbeResult>>;
  listQueues(): Promise<IpcResult<QueueRecord[]>>;
  saveQueue(input: QueueInput): Promise<IpcResult<QueueRecord>>;
  deleteQueue(id: string): Promise<IpcResult<void>>;
  startQueue(id: string): Promise<IpcResult<void>>;
  stopQueue(id: string): Promise<IpcResult<void>>;
  saveSchedule(input: ScheduleInput): Promise<IpcResult<ScheduleRecord>>;
  deleteSchedule(id: string): Promise<IpcResult<void>>;
  saveRule(input: RuleInput): Promise<IpcResult<CategoryRule>>;
  deleteRule(id: string): Promise<IpcResult<void>>;
  saveSiteRule(input: SiteRuleInput): Promise<IpcResult<SiteRule>>;
  deleteSiteRule(id: string): Promise<IpcResult<void>>;
  updateSettings(update: SettingsUpdate): Promise<IpcResult<AppSettings>>;
  resetSettings(): Promise<IpcResult<AppSettings>>;
  exportSettings(): Promise<IpcResult<string>>;
  importSettings(json: string): Promise<IpcResult<AppSettings>>;
  exportQueue(): Promise<IpcResult<string>>;
  importQueue(json: string): Promise<IpcResult<number>>;
  regenerateBridgeToken(): Promise<IpcResult<string>>;
  getLogs(limit?: number, level?: string): Promise<IpcResult<LogRecord[]>>;
  clearLogs(): Promise<IpcResult<void>>;
  openExternal(url: string): Promise<IpcResult<void>>;
  showItemInFolder(path: string): Promise<IpcResult<void>>;
  chooseFolder(defaultPath?: string): Promise<IpcResult<string | null>>;
  openExtensionFolder(): Promise<IpcResult<void>>;
  openResourcesFolder(): Promise<IpcResult<void>>;
  testBridge(): Promise<IpcResult<{ ok: boolean; message: string }>>;
  testProxy(): Promise<IpcResult<{ ok: boolean; message: string }>>;
  shutdownComputer(): Promise<IpcResult<void>>;
  setBadge(count: number): Promise<IpcResult<void>>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onProgress(listener: (event: DownloadProgressEvent) => void): () => void;
  onDownloadUpdated(listener: (download: DownloadRecord) => void): () => void;
  onDownloadLifecycle(listener: (event: DownloadLifecycleEvent) => void): () => void;
  onFocusDownload(listener: (downloadId: string) => void): () => void;
  onLog(listener: (log: LogRecord) => void): () => void;
  onNavigate(listener: (page: string) => void): () => void;
  onToast(listener: (toast: { type: 'success' | 'warning' | 'error' | 'info'; title: string; message?: string }) => void): () => void;
  onBrowserDownload(listener: (confirmation: BrowserDownloadConfirmation) => void): () => void;
}
