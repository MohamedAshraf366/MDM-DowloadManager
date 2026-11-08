import type { AppSettings, CategoryRule, FileCategory } from './types';

export const DEFAULT_CATEGORY_FOLDERS: Record<FileCategory, string> = {
  video: 'Video',
  audio: 'Music',
  documents: 'Documents',
  archives: 'Archives',
  images: 'Images',
  programs: 'Programs',
  other: 'Other'
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  speedUnit: 'bytes',
  defaultDownloadDir: '',
  categoryFolders: { ...DEFAULT_CATEGORY_FOLDERS },
  categorizeByType: true,
  defaultConnections: 32,
  maxConcurrentDownloads: 3,
  maxConnectionsPerHost: 32,
  turboMode: true,
  turboMaxConnections: 32,
  lineSpeedMbps: 0,
  globalSpeedLimitBps: 0,
  defaultSpeedLimitBps: 0,
  connectTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxRetries: 5,
  retryBaseDelayMs: 1_000,
  maxRedirects: 10,
  duplicatePolicy: 'rename',
  autoOpenCompleted: false,
  autoResumeOnStartup: true,
  launchAtStartup: false,
  minimizeToTray: false,
  closeToTray: true,
  notificationsEnabled: true,
  notifyOnStart: true,
  notifyOnComplete: true,
  notifyOnFailure: true,
  nativeNotificationsWhenActive: false,
  showProgressInTaskbar: true,
  proxy: {
    mode: 'none',
    protocol: 'http',
    host: '',
    port: 8080,
    username: '',
    passwordSet: false,
    bypass: 'localhost,127.0.0.1,::1'
  },
  ipVersion: 'any',
  userAgentMode: 'default',
  userAgent: '',
  browserIntegrationEnabled: true,
  bridgePort: 41731,
  bridgeToken: '',
  autoShutdownAfterQueue: false,
  loggingLevel: 'info',
  confirmDestructiveActions: true,
  checksumAlgorithm: '',
  showExtensionSetupOnStartup: true
};

export const DEFAULT_RULES: Array<Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'Videos',
    enabled: true,
    priority: 100,
    matchType: 'extension',
    pattern: 'mp4,mkv,avi,mov,wmv,webm,flv,m4v,ts,mpg,mpeg,3gp',
    category: 'video',
    destinationDir: '',
    autoOpen: false
  },
  {
    name: 'Audio',
    enabled: true,
    priority: 90,
    matchType: 'extension',
    pattern: 'mp3,flac,wav,aac,m4a,ogg,opus,wma,alac',
    category: 'audio',
    destinationDir: '',
    autoOpen: false
  },
  {
    name: 'Documents',
    enabled: true,
    priority: 80,
    matchType: 'extension',
    pattern: 'pdf,doc,docx,xls,xlsx,ppt,pptx,txt,rtf,csv,epub,mobi,odt',
    category: 'documents',
    destinationDir: '',
    autoOpen: false
  },
  {
    name: 'Archives',
    enabled: true,
    priority: 70,
    matchType: 'extension',
    pattern: 'zip,rar,7z,tar,gz,bz2,xz,iso,cab',
    category: 'archives',
    destinationDir: '',
    autoOpen: false
  },
  {
    name: 'Images',
    enabled: true,
    priority: 60,
    matchType: 'extension',
    pattern: 'jpg,jpeg,png,gif,bmp,webp,svg,tif,tiff,heic,avif',
    category: 'images',
    destinationDir: '',
    autoOpen: false
  },
  {
    name: 'Programs',
    enabled: true,
    priority: 50,
    matchType: 'extension',
    pattern: 'exe,msi,msix,appx,apk,dmg,pkg,deb,rpm',
    category: 'programs',
    destinationDir: '',
    autoOpen: false
  }
];

export const APP_NAME = 'MDM - Mohamed Download Manager';
export const APP_SHORT_NAME = 'MDM';
export const APP_VERSION = '2.6';
export const BRIDGE_DEFAULT_PORT = 41731;
export const MAX_REDIRECTS = 10;
/** Small files finish faster over one warm connection than several cold ones. */
export const MIN_CONNECTION_FILE_SIZE = 2 * 1024 * 1024;
export const SEGMENT_WRITE_HIGH_WATER = 1024 * 1024;
export const SEGMENT_SPLIT_THRESHOLD = 4 * 1024 * 1024;
/**
 * Covers one buffered batch plus the write that may still be in flight. Each
 * can overshoot the high-water mark by one network chunk, hence the headroom.
 */
export const RESUME_SAFETY_MARGIN_BYTES = 2 * SEGMENT_WRITE_HIGH_WATER + 256 * 1024;
export const PROGRESS_INTERVAL_MS = 400;
export const CHECKPOINT_INTERVAL_MS = 3_000;
