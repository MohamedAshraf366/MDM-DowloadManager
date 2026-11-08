import type { SpeedUnit } from './types';

export function formatBytes(bytes: number | null | undefined, precision = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : precision;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

let speedUnit: SpeedUnit = 'bytes';

/** Chosen in Settings; the renderer sets it before drawing, so every speed on screen agrees. */
export function setSpeedUnit(unit: SpeedUnit): void {
  speedUnit = unit === 'bits' ? 'bits' : 'bytes';
}

/**
 * Decimal bits per second, the way speed tests and internet plans quote it.
 * (formatBytes counts in powers of 1024, so a 32 Mbit/s line would show as
 * 3.8 "MB/s", which looks nothing like the 32 on the speed test.)
 */
export function formatBitRate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbit/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(bits >= 1e8 ? 0 : 1)} Mbit/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} Kbit/s`;
  return `${bits.toFixed(0)} bit/s`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  return speedUnit === 'bits' ? formatBitRate(bytesPerSecond) : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '< 1s';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatPercent(downloaded: number, total: number | null): string {
  if (!total || total <= 0) return '—';
  return `${Math.min(100, (downloaded / total) * 100).toFixed(1)}%`;
}

export function progressRatio(downloaded: number, total: number | null): number {
  if (!total || total <= 0) return 0;
  return Math.min(1, Math.max(0, downloaded / total));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleString(undefined, {
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDuration(seconds: number | null): string {
  return formatEta(seconds);
}

export function parseByteSize(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit] ?? 1;
  return Math.floor(value * multiplier);
}

export function formatTime12(time: string): string {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return time;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function daysLabel(days: number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.length === 0) return 'Never';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdays = [1, 2, 3, 4, 5];
  if (days.length === 5 && weekdays.every((d) => days.includes(d))) return 'Weekdays';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => names[d] ?? '?')
    .join(', ');
}
