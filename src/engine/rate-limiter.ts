export class TokenBucket {
  private ratePerSecond: number;
  private capacity: number;
  private tokens: number;
  private lastRefill: number;

  constructor(ratePerSecond = 0) {
    this.ratePerSecond = Math.max(0, ratePerSecond);
    this.capacity = Math.max(64 * 1024, this.ratePerSecond || 1024 * 1024);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  setRate(ratePerSecond: number): void {
    this.ratePerSecond = Math.max(0, ratePerSecond);
    this.capacity = Math.max(64 * 1024, this.ratePerSecond || 1024 * 1024);
    if (this.tokens > this.capacity) this.tokens = this.capacity;
  }

  getRate(): number {
    return this.ratePerSecond;
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.ratePerSecond <= 0 || bytes <= 0) return;
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    let remaining = bytes;
    while (remaining > 0) {
      const amount = Math.min(remaining, this.capacity);
      await this.take(amount, signal);
      remaining -= amount;
    }
  }

  private async take(bytes: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= bytes) break;
      const needed = bytes - this.tokens;
      const waitMs = Math.max(4, Math.ceil((needed / this.ratePerSecond) * 1000));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, Math.min(waitMs, 250));
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    }
    this.tokens -= bytes;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSecond);
      this.lastRefill = now;
    }
  }

}

export class Semaphore {
  private available: number;
  private max: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
    this.available = this.max;
  }

  setMax(max: number): void {
    const newMax = Math.max(1, Math.floor(max));
    const delta = newMax - this.max;
    this.max = newMax;
    this.available += delta;
    while (this.available > 0 && this.queue.length) {
      this.available--;
      this.queue.shift()!();
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    if (this.available > 0) {
      this.available--;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          this.releaseSlot();
          reject(signal.reason ?? new Error('Aborted'));
          return;
        }
        resolve();
      };
      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason ?? new Error('Aborted'));
      };
      this.queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private releaseSlot(): void {
    // Raising `available` first and only then waking waiters lets a lowered
    // limit take effect as existing holders finish: while the active count
    // still exceeds `max`, released slots are absorbed instead of being
    // handed to a queued waiter.
    this.available = Math.min(this.max, this.available + 1);
    while (this.available > 0 && this.queue.length) {
      this.available--;
      this.queue.shift()!();
    }
  }

  get active(): number {
    return this.max - this.available;
  }
}

/** How long a refusal level is remembered. */
const LEARNED_LIMIT_TTL_MS = 10 * 60 * 1000;

export class HostLimiter {
  private readonly hosts = new Map<string, Semaphore>();
  private readonly boosts = new Set<{ limit: number }>();
  private readonly learnedLimits = new Map<string, { limit: number; at: number }>();
  private readonly streams = new Map<string, number>();
  private limit: number;

  constructor(limit = 8) {
    this.limit = Math.max(1, limit);
  }

  private effectiveLimit(): number {
    let effective = this.limit;
    for (const boost of this.boosts) effective = Math.max(effective, boost.limit);
    return effective;
  }

  private applyLimit(): void {
    const effective = this.effectiveLimit();
    for (const semaphore of this.hosts.values()) semaphore.setMax(effective);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.applyLimit();
  }

  /**
   * Temporarily lifts the per-host cap to at least `limit` (Turbo downloads).
   * Call the returned function to hand the cap back; it is safe to call twice.
   */
  boost(limit: number): () => void {
    const lease = { limit: Math.max(1, Math.floor(limit)) };
    this.boosts.add(lease);
    this.applyLimit();
    return () => {
      if (!this.boosts.delete(lease)) return;
      this.applyLimit();
    };
  }

  /**
   * Connections the server has actually accepted and is still streaming, across
   * all downloads. (Not the same as slots held: a connection being refused holds
   * a slot too, so counting those would overstate what the server accepts.)
   */
  streamsOpen(host: string): number {
    return this.streams.get(host) ?? 0;
  }

  /** Call when a connection starts delivering data; call the result when it ends. */
  streamOpened(host: string): () => void {
    this.streams.set(host, (this.streams.get(host) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.streams.get(host) ?? 1) - 1;
      if (remaining <= 0) this.streams.delete(host);
      else this.streams.set(host, remaining);
    };
  }

  /**
   * Remember that a server refused connections once this many were open. Keeps
   * the highest figure seen, since each refusal happens at the limit. It expires,
   * because limits change (and 429 can also mean "too fast", not "too many").
   */
  learn(host: string, limit: number, now = Date.now()): void {
    const known = this.learnedLimits.get(host);
    const fresh = known && now - known.at < LEARNED_LIMIT_TTL_MS;
    const value = Math.max(1, Math.floor(limit));
    this.learnedLimits.set(host, { limit: fresh ? Math.max(known.limit, value) : value, at: now });
  }

  /** How many connections this host was last seen to accept, if known and recent. */
  learned(host: string, now = Date.now()): number | undefined {
    const known = this.learnedLimits.get(host);
    if (!known || now - known.at >= LEARNED_LIMIT_TTL_MS) return undefined;
    return known.limit;
  }

  acquire(host: string, signal?: AbortSignal): Promise<() => void> {
    let semaphore = this.hosts.get(host);
    if (!semaphore) {
      semaphore = new Semaphore(this.effectiveLimit());
      this.hosts.set(host, semaphore);
    }
    return semaphore.acquire(signal);
  }
}

export class SpeedMeter {
  private samples: Array<{ time: number; bytes: number }> = [];
  private readonly windowMs: number;
  private ema: number | null = null;
  private sampledAt = 0;
  private lastAddAt = 0;

  constructor(windowMs = 5_000) {
    this.windowMs = windowMs;
  }

  add(bytes: number): void {
    const now = Date.now();
    this.samples.push({ time: now, bytes });
    this.lastAddAt = now;
    this.prune(now);
  }

  /**
   * Exponentially smoothed transfer rate. The raw windowed rate is recomputed
   * at most twice per second so per-chunk sampling noise does not make the
   * displayed speed and ETA jump around.
   */
  speed(): number {
    const now = Date.now();
    this.prune(now);
    if (now - this.lastAddAt > this.windowMs) {
      this.ema = null;
      return 0;
    }
    if (this.samples.length < 2) return this.ema ?? 0;
    if (now - this.sampledAt < 500) return this.ema ?? 0;
    this.sampledAt = now;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const elapsed = (last.time - first.time) / 1000;
    const raw = elapsed <= 0 ? 0 : Math.max(0, this.samples.slice(1).reduce((sum, sample) => sum + sample.bytes, 0) / elapsed);
    this.ema = this.ema === null ? raw : this.ema * 0.6 + raw * 0.4;
    return this.ema;
  }

  reset(): void {
    this.samples = [];
    this.ema = null;
    this.sampledAt = 0;
    this.lastAddAt = 0;
  }

  private prune(now: number): void {
    while (this.samples.length > 1 && now - this.samples[0]!.time > this.windowMs) {
      this.samples.shift();
    }
  }
}

export function backoffDelay(attempt: number, baseDelayMs: number, retryAfterMs?: number | null): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 120_000);
  const exponential = Math.min(baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), 60_000);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(Math.min(exponential * jitter, 60_000));
}
