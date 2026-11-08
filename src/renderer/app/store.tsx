import { setSpeedUnit } from '../../shared/format';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type {
  AppInfo,
  BrowserDownloadConfirmation,
  DownloadProgressEvent,
  DownloadRecord,
  IpcResult,
  LogRecord,
  Snapshot
} from '../../shared/types';
import { downloadLifecycleToast } from './download-toasts';
import type { Toast, ToastKind, ToastOptions } from './toast-types';

export type Page = 'downloads' | 'queues' | 'schedule' | 'rules' | 'browser' | 'settings' | 'logs';
export type { Toast, ToastKind, ToastAction, ToastOptions } from './toast-types';

export interface FocusTarget {
  id: string;
  openDetails: boolean;
  nonce: number;
}

interface AppContextValue {
  snapshot: Snapshot | null;
  appInfo: AppInfo | null;
  loading: boolean;
  fatalError: string;
  page: Page;
  navigate: (page: Page | 'add') => void;
  selected: Set<string>;
  toggleSelected: (id: string, selected?: boolean) => void;
  setSelected: (ids: string[]) => void;
  clearSelection: () => void;
  addDialogOpen: boolean;
  openAddDialog: () => void;
  closeAddDialog: () => void;
  browserDownload: BrowserDownloadConfirmation | null;
  closeBrowserDownload: () => void;
  focusTarget: FocusTarget | null;
  focusDownload: (id: string, openDetails?: boolean) => void;
  clearFocusTarget: (nonce: number) => void;
  toasts: Toast[];
  notify: (type: ToastKind, title: string, message?: string, options?: ToastOptions) => void;
  dismissToast: (id: string) => void;
  call: <T>(operation: Promise<IpcResult<T>>, successMessage?: string) => Promise<T | null>;
  refresh: () => Promise<void>;
  logs: LogRecord[];
  refreshLogs: () => Promise<void>;
  clearLogs: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // Idempotent and cheap: done during render so every speed drawn below uses the same unit.
  setSpeedUnit(snapshot?.settings.speedUnit ?? 'bytes');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState('');
  const [page, setPage] = useState<Page>('downloads');
  const [selected, setSelectedState] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [browserDownloads, setBrowserDownloads] = useState<BrowserDownloadConfirmation[]>([]);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const toastTimers = useRef(new Map<string, number>());
  const toastDedupe = useRef(new Map<string, string>());
  const toastCounter = useRef(0);
  const focusCounter = useRef(0);
  const pendingProgress = useRef(new Map<string, DownloadProgressEvent>());
  const progressTimer = useRef(0);

  const flushProgress = useCallback(() => {
    progressTimer.current = 0;
    if (!pendingProgress.current.size) return;
    const events = new Map(pendingProgress.current);
    pendingProgress.current.clear();
    setSnapshot((current) => {
      if (!current) return current;
      let changed = false;
      const downloads = current.downloads.map((record) => {
        const event = events.get(record.id);
        if (!event) return record;
        const next = applyProgress(record, event);
        if (next !== record) changed = true;
        return next;
      });
      return changed ? { ...current, downloads } : current;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    toastTimers.current.delete(id);
    for (const [key, value] of toastDedupe.current) {
      if (value === id) toastDedupe.current.delete(key);
    }
  }, []);

  const scheduleToastDismiss = useCallback(
    (id: string, type: ToastKind, options: ToastOptions) => {
      const existing = toastTimers.current.get(id);
      if (existing) window.clearTimeout(existing);
      const duration =
        options.durationMs ??
        (type === 'error' ? 12_000 : options.actions?.length ? 10_000 : type === 'warning' ? 8_000 : 5_000);
      toastTimers.current.set(
        id,
        window.setTimeout(() => dismissToast(id), Math.max(3_000, duration))
      );
    },
    [dismissToast]
  );

  const notify = useCallback(
    (type: ToastKind, title: string, message?: string, options: ToastOptions = {}) => {
      const key = options.dedupeKey;
      if (key) {
        const existing = toastDedupe.current.get(key);
        if (existing) {
          setToasts((current) =>
            current.map((toast) =>
              toast.id === existing ? { ...toast, type, title, message, actions: options.actions } : toast
            )
          );
          scheduleToastDismiss(existing, type, options);
          return;
        }
      }
      const id = `toast-${++toastCounter.current}`;
      const toast: Toast = { id, type, title, message, actions: options.actions };
      setToasts((current) => {
        const next = [...current, toast];
        while (next.length > 5) {
          const removed = next.shift();
          if (removed) {
            const timer = toastTimers.current.get(removed.id);
            if (timer) window.clearTimeout(timer);
            toastTimers.current.delete(removed.id);
            for (const [key, value] of toastDedupe.current) {
              if (value === removed.id) toastDedupe.current.delete(key);
            }
          }
        }
        return next;
      });
      if (key) toastDedupe.current.set(key, id);
      scheduleToastDismiss(id, type, options);
    },
    [scheduleToastDismiss]
  );

  const refresh = useCallback(async () => {
    const [snapshotResult, infoResult] = await Promise.all([
      window.mdm.getSnapshot(),
      window.mdm.getAppInfo()
    ]);
    if (snapshotResult.ok && snapshotResult.data) setSnapshot(snapshotResult.data);
    if (infoResult.ok && infoResult.data) setAppInfo(infoResult.data);
    if (!snapshotResult.ok) {
      setFatalError(snapshotResult.error ?? 'The application could not load its data.');
    } else {
      setFatalError('');
    }
    setLoading(false);
  }, []);

  const call = useCallback(
    async <T,>(operation: Promise<IpcResult<T>>, successMessage?: string): Promise<T | null> => {
      try {
        const result = await operation;
        if (!result.ok) throw new Error(result.error ?? 'The request could not be completed.');
        if (successMessage) notify('success', successMessage);
        return (result.data ?? null) as T | null;
      } catch (error) {
        notify('error', 'Something went wrong', (error as Error).message);
        return null;
      }
    },
    [notify]
  );

  const refreshLogs = useCallback(async () => {
    const result = await window.mdm.getLogs(600);
    if (result.ok && result.data) setLogs(result.data);
  }, []);

  const clearLogs = useCallback(async () => {
    const result = await window.mdm.clearLogs();
    if (!result.ok) {
      notify('error', 'Could not clear logs', result.error);
      return;
    }
    setLogs([]);
    notify('success', 'Activity log cleared');
  }, [notify]);

  const focusDownload = useCallback((id: string, openDetails = false) => {
    setPage('downloads');
    setSelectedState(new Set([id]));
    setFocusTarget({ id, openDetails, nonce: ++focusCounter.current });
  }, []);

  const clearFocusTarget = useCallback((nonce: number) => {
    setFocusTarget((current) => (current?.nonce === nonce ? null : current));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const disposers = [
      window.mdm.onSnapshot((next) => setSnapshot((current) => mergeSnapshot(current, next))),
      window.mdm.onDownloadUpdated((record) => {
        setSnapshot((current) => {
          if (!current) return current;
          const downloads = current.downloads.some((item) => item.id === record.id)
            ? current.downloads.map((item) => (item.id === record.id ? record : item))
            : [record, ...current.downloads];
          return { ...current, downloads };
        });
      }),
      window.mdm.onDownloadLifecycle((event) => {
        const toast = downloadLifecycleToast(event);
        if (toast) {
          notify(toast.type, toast.title, toast.message, {
            dedupeKey: toast.dedupeKey,
            actions: toast.actions
          });
        }
      }),
      window.mdm.onFocusDownload((downloadId) => focusDownload(downloadId)),
      window.mdm.onProgress((event) => {
        pendingProgress.current.set(event.id, event);
        if (!progressTimer.current) progressTimer.current = window.setTimeout(flushProgress, 50);
      }),
      window.mdm.onLog((log) => setLogs((current) => [log, ...current].slice(0, 800))),
      window.mdm.onNavigate((target) => {
        if (target === 'add') {
          setAddDialogOpen(true);
          setPage('downloads');
        } else if (isPage(target)) {
          setPage(target);
        }
      }),
      window.mdm.onToast((toast) => notify(toast.type, toast.title, toast.message)),
      window.mdm.onBrowserDownload((confirmation) => {
        setBrowserDownloads((current) => [...current, confirmation]);
      })
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [notify, flushProgress, focusDownload]);

  useEffect(
    () => () => {
      if (progressTimer.current) window.clearTimeout(progressTimer.current);
    },
    []
  );

  useEffect(() => {
    const ids = new Set(snapshot?.downloads.map((record) => record.id) ?? []);
    setSelectedState((current) => {
      const next = new Set(Array.from(current).filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [snapshot?.downloads]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const preference = snapshot?.settings.theme ?? 'system';
      const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [snapshot?.settings.theme]);

  useEffect(() => {
    if (!appInfo) return;
    document.documentElement.dataset.platform = appInfo.platform.split(' ')[0] ?? 'win32';
    document.documentElement.dataset.platformName = appInfo.platform;
  }, [appInfo]);

  useEffect(() => {
    if (page === 'logs') void refreshLogs();
  }, [page, refreshLogs]);

  useEffect(
    () => () => {
      for (const timer of toastTimers.current.values()) window.clearTimeout(timer);
      toastTimers.current.clear();
      toastDedupe.current.clear();
    },
    []
  );

  const toggleSelected = useCallback((id: string, value?: boolean) => {
    setSelectedState((current) => {
      const next = new Set(current);
      const shouldSelect = value ?? !next.has(id);
      if (shouldSelect) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setSelected = useCallback((ids: string[]) => setSelectedState(new Set(ids)), []);
  const clearSelection = useCallback(() => setSelectedState(new Set()), []);
  const closeBrowserDownload = useCallback(() => {
    setBrowserDownloads((current) => current.slice(1));
  }, []);

  const navigate = useCallback((target: Page | 'add') => {
    if (target === 'add') {
      setAddDialogOpen(true);
      setPage('downloads');
      return;
    }
    setPage(target);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      snapshot,
      appInfo,
      loading,
      fatalError,
      page,
      navigate,
      selected,
      toggleSelected,
      setSelected,
      clearSelection,
      addDialogOpen,
      openAddDialog: () => setAddDialogOpen(true),
      closeAddDialog: () => setAddDialogOpen(false),
      browserDownload: browserDownloads[0] ?? null,
      closeBrowserDownload,
      focusTarget,
      focusDownload,
      clearFocusTarget,
      toasts,
      notify,
      dismissToast,
      call,
      refresh,
      logs,
      refreshLogs,
      clearLogs
    }),
    [
      snapshot,
      appInfo,
      loading,
      fatalError,
      page,
      navigate,
      selected,
      toggleSelected,
      setSelected,
      clearSelection,
      addDialogOpen,
      browserDownloads,
      closeBrowserDownload,
      focusTarget,
      focusDownload,
      clearFocusTarget,
      toasts,
      notify,
      dismissToast,
      call,
      refresh,
      logs,
      refreshLogs,
      clearLogs
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider.');
  return context;
}

function isPage(value: string): value is Page {
  return ['downloads', 'queues', 'schedule', 'rules', 'browser', 'settings', 'logs'].includes(value);
}

function applyProgress(record: DownloadRecord, event: DownloadProgressEvent): DownloadRecord {
  if (record.status === 'paused' && event.status === 'downloading') return record;
  return {
    ...record,
    status: event.status,
    downloadedBytes: event.downloadedBytes,
    totalBytes: event.totalBytes ?? record.totalBytes,
    speedBps: event.speedBps,
    etaSeconds: event.etaSeconds,
    segments: event.segments,
    retryCount: Math.max(record.retryCount, event.attempts)
  };
}

function mergeSnapshot(current: Snapshot | null, next: Snapshot): Snapshot {
  if (!current) return next;
  const previous = new Map(current.downloads.map((record) => [record.id, record]));
  const downloads = next.downloads.map((record) => {
    const existing = previous.get(record.id);
    return existing && recordsMatch(existing, record) ? existing : record;
  });
  const unchanged =
    downloads.length === current.downloads.length &&
    downloads.every((record, index) => record === current.downloads[index]);
  return unchanged ? { ...next, downloads: current.downloads } : { ...next, downloads };
}

function recordsMatch(left: DownloadRecord, right: DownloadRecord): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.downloadedBytes === right.downloadedBytes &&
    left.totalBytes === right.totalBytes &&
    left.speedBps === right.speedBps &&
    left.etaSeconds === right.etaSeconds &&
    left.error === right.error &&
    left.retryCount === right.retryCount &&
    left.checksumStatus === right.checksumStatus &&
    left.scheduledAt === right.scheduledAt &&
    left.completedAt === right.completedAt &&
    left.recordLog.length === right.recordLog.length &&
    left.segments.length === right.segments.length
  );
}
