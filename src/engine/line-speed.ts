import { createHash } from 'node:crypto';
import os from 'node:os';

/**
 * What a network has been seen to deliver, so Turbo can start from there.
 *
 * It is a starting point and never a limit. How fast a connection can go
 * depends on the network you are on (a different Wi-Fi, a faster plan, a wired
 * link), so nothing here caps the speed: Turbo uses the figure to jump to the
 * right number of connections quickly, then checks whether more is available.
 * It is learned from Turbo's own measurements, kept separately for each
 * network, and forgotten after a while.
 */
export interface LineSpeedStore {
  load(): string | null;
  save(json: string): void;
}

export interface LineSpeedSource {
  /** Bytes per second this network recently delivered, or undefined if unknown. */
  hint(): number | undefined;
  /** Record a sustained rate measured on this network. */
  observe(bytesPerSecond: number): void;
}

interface Entry {
  rates: number[];
  at: number;
}

const KEEP_RATES = 5;
const KEEP_NETWORKS = 20;
const EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;
/** Below this a figure says more about a tiny or stalled transfer than about the network. */
const MIN_RATE_BPS = 50_000;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * A short identifier for the network this computer is on now: its adapters and
 * their subnets. Connecting to a different network gives a different one.
 * It is not secret and never leaves the machine.
 */
export function networkKey(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const parts: string[] = [];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4') continue;
      parts.push(`${address.mac}|${address.cidr ?? address.address}`);
    }
  }
  if (parts.length === 0) return 'offline';
  return createHash('sha1').update(parts.sort().join(';')).digest('hex').slice(0, 12);
}

export class LineSpeedMemory implements LineSpeedSource {
  constructor(
    private readonly store: LineSpeedStore,
    private readonly key: () => string = () => networkKey(),
    private readonly now: () => number = Date.now
  ) {}

  private read(): Record<string, Entry> {
    try {
      const parsed = JSON.parse(this.store.load() ?? '{}') as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  }

  hint(): number | undefined {
    const entry = this.read()[this.key()];
    if (!entry || !Array.isArray(entry.rates) || entry.rates.length === 0) return undefined;
    if (this.now() - entry.at > EXPIRES_MS) return undefined;
    const valid = entry.rates.filter((rate) => Number.isFinite(rate) && rate >= MIN_RATE_BPS);
    // The median, so one slow server does not drag the figure down and one fast one does not inflate it.
    return valid.length ? Math.round(median(valid)) : undefined;
  }

  observe(bytesPerSecond: number): void {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < MIN_RATE_BPS) return;
    const all = this.read();
    const key = this.key();
    const current = all[key];
    const fresh = current && this.now() - current.at <= EXPIRES_MS;
    const rates = [...(fresh ? current.rates : []), Math.round(bytesPerSecond)].slice(-KEEP_RATES);
    all[key] = { rates, at: this.now() };
    const newest = Object.entries(all)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, KEEP_NETWORKS);
    try {
      this.store.save(JSON.stringify(Object.fromEntries(newest)));
    } catch {
      // Remembering is a convenience; never let it break a download.
    }
  }
}
