/**
 * Turbo mode: find out how many parallel connections it takes to use all the
 * bandwidth that is actually available, without assuming any particular line
 * speed.
 *
 * The controller never looks at a configured or "expected" speed. It only
 * watches measured throughput: add connections, and keep them only if
 * throughput really rises. Whatever limit is binding (a server that caps each
 * connection, the server's total, the ISP line, Wi-Fi, the disk) shows up as
 * "more connections stopped helping", and scaling stops there.
 *
 * It is pure on purpose (no timers, sockets or files) so the algorithm can be
 * tested against simulated links of any speed.
 */

export interface TurboTuning {
  /** How often the engine feeds a throughput sample. */
  sampleMs: number;
  /** Samples ignored after a change while new connections ramp up. */
  settleSamples: number;
  /** Samples averaged to judge a change. */
  measureSamples: number;
  /** Relative throughput gain that justifies keeping the extra connections. */
  minGain: number;
  /** Connections multiply by this per step (at least `minStep` more). */
  growth: number;
  minStep: number;
  /** With a known speed: counts as "reached" at this share of it, and the check for more begins. */
  lineFull: number;
  /** After a known speed is reached, the connections grow by this factor once, to see if there is more. */
  probeGrowth: number;
  /** With a known line speed: aim for this share of it when sizing a jump. */
  lineTarget: number;
  /** With a known line speed: most the connection count may multiply in one jump. */
  maxJump: number;
  /**
   * A step whose speed rose by less than this share of the proportional rise has
   * run into a limit part-way, so the count settles at that point, not at the top of the step.
   * Kept low on purpose: connections just added are still ramping up when they are measured,
   * so a modest shortfall is normal and must not be mistaken for a limit.
   */
  saturation: number;
}

export const DEFAULT_TURBO_TUNING: TurboTuning = {
  sampleMs: 500,
  settleSamples: 2,
  measureSamples: 3,
  minGain: 0.08,
  growth: 1.5,
  minStep: 2,
  lineFull: 0.92,
  probeGrowth: 1.25,
  lineTarget: 0.95,
  maxJump: 3,
  saturation: 0.7
};

export type TurboStopReason =
  /** More connections no longer increase throughput: the link (or server) is full. */
  | 'plateau'
  /** Reached the configured maximum while throughput was still rising. */
  | 'ceiling'
  /** The server pushed back (429/503/resets); keep the last safe count. */
  | 'server-limit'
  /** Not enough unfinished data left to split between more connections. */
  | 'no-work';

export type TurboDecision =
  | { action: 'hold' }
  | { action: 'grow'; target: number; baselineRate: number; /** A check for more than the known speed, not a search. */ probe?: boolean }
  | { action: 'stop'; target: number; reason: TurboStopReason; rate: number };

export interface TurboContext {
  /** True if the server rejected or reset connections since the last sample. */
  pushback: boolean;
  /**
   * How many more connections the unfinished data can really feed. A new
   * connection needs its own range to download, so near the end of a file this
   * drops to zero and adding workers would only make promises nobody can keep.
   */
  headroom: number;
}

/** Errors that mean "too many parallel connections" rather than a one-off glitch. */
export function isServerPushback(error: { code: string; statusCode: number | null }): boolean {
  return (
    error.statusCode === 429 ||
    error.statusCode === 503 ||
    error.code === 'HTTP_429' ||
    error.code === 'NETWORK' ||
    error.code === 'TIMEOUT'
  );
}

type Phase = 'baseline' | 'settling' | 'measuring' | 'done';

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

export class TurboController {
  private phase: Phase = 'baseline';
  private current: number;
  private previous: number;
  private baseline = 0;
  private skipped = 0;
  private window: number[] = [];
  private headroom = 0;
  private probing = false;

  /**
   * @param capacity A speed in bytes per second this network has been seen to
   *   deliver (learned from earlier downloads, or from a speed test the person
   *   typed in). It is a starting point, never a limit: it only lets the search
   *   jump straight to the right number of connections, and once that speed is
   *   reached the controller checks whether the network can do more. A different
   *   network, or a faster plan, is therefore found, not capped.
   */
  constructor(
    base: number,
    private readonly ceiling: number,
    private readonly tuning: TurboTuning = DEFAULT_TURBO_TUNING,
    private capacity?: number
  ) {
    this.current = Math.max(1, Math.floor(base));
    this.previous = this.current;
  }

  /** Number of connections the engine should currently be running. */
  get target(): number {
    return this.current;
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  /** Feed one throughput sample in bytes per second. */
  sample(rate: number, context: TurboContext): TurboDecision {
    if (this.phase === 'done') return { action: 'hold' };
    if (context.pushback) {
      // Anything added since the last accepted step is what the server objected to.
      return this.stop(this.phase === 'baseline' ? this.current : this.previous, 'server-limit', this.baseline || rate);
    }
    this.headroom = Math.max(0, Math.floor(context.headroom));
    if (this.headroom < 1) return this.stop(this.current, 'no-work', rate);

    switch (this.phase) {
      case 'baseline': {
        if (this.skipped < this.tuning.settleSamples) {
          this.skipped += 1;
          return { action: 'hold' };
        }
        this.window.push(rate);
        if (this.window.length < this.tuning.measureSamples) return { action: 'hold' };
        this.baseline = mean(this.window);
        this.dropStaleCapacity(this.baseline);
        // Already at the known speed: check once whether there is more, instead of assuming there is not.
        if (this.reached(this.baseline)) this.beginProbe();
        return this.grow();
      }
      case 'settling': {
        this.skipped += 1;
        if (this.skipped >= this.tuning.settleSamples) {
          this.phase = 'measuring';
          this.window = [];
        }
        return { action: 'hold' };
      }
      case 'measuring': {
        this.window.push(rate);
        if (this.window.length < this.tuning.measureSamples) return { action: 'hold' };
        const measured = mean(this.window);
        const before = this.baseline;
        const gain = (measured - before) / Math.max(before, 1);
        if (gain < this.tuning.minGain) {
          // The extra connections did not help: give them back.
          return this.stop(this.previous, 'plateau', this.baseline);
        }
        this.baseline = measured;
        this.dropStaleCapacity(measured);
        // If the speed did not rise in proportion to the connections added, a limit was hit
        // part-way up the step. Where: previous x (measured / before), plus one for safety.
        const proportional = before * (this.current / this.previous);
        const saturated = measured < proportional * this.tuning.saturation;
        const settled = saturated
          ? Math.min(this.current, Math.max(this.previous + 1, Math.ceil((this.previous * measured) / Math.max(before, 1)) + 1))
          : this.current;
        if (saturated) return this.stop(settled, 'plateau', measured);
        if (this.reached(measured)) this.beginProbe();
        if (this.current >= this.ceiling) return this.stop(this.current, 'ceiling', measured);
        return this.grow();
      }
    }
  }

  /** The known speed has been matched: forget it as a target and look for what lies beyond it. */
  private beginProbe(): void {
    this.capacity = undefined;
    this.probing = true;
  }

  private reached(rate: number): boolean {
    return this.capacity !== undefined && rate >= this.capacity * this.tuning.lineFull;
  }

  /** A measurement well above the stated line speed means the figure is stale or wrong: ignore it. */
  private dropStaleCapacity(rate: number): void {
    if (this.capacity !== undefined && rate > this.capacity * 1.15) this.capacity = undefined;
  }

  /** How many connections to run next. */
  private nextCount(): number {
    if (this.probing) return Math.max(this.current + this.tuning.minStep, Math.ceil(this.current * this.tuning.probeGrowth));
    const geometric = Math.max(this.current + this.tuning.minStep, Math.ceil(this.current * this.tuning.growth));
    if (this.capacity === undefined || this.baseline <= 0) return geometric;
    // Per-connection speed is about baseline / current, so the connections the
    // line needs is about capacity / that. Jump straight there instead of feeling the way.
    const wanted = (this.capacity * this.tuning.lineTarget) / this.baseline;
    const predicted = Math.ceil(this.current * Math.min(wanted, this.tuning.maxJump));
    return Math.max(this.current + this.tuning.minStep, predicted);
  }

  private grow(): TurboDecision {
    const room = Math.min(this.ceiling, this.current + this.headroom);
    const next = Math.min(room, this.nextCount());
    if (next <= this.current) return this.stop(this.current, room <= this.current && this.current < this.ceiling ? 'no-work' : 'ceiling', this.baseline);
    const probe = this.probing;
    this.probing = false;
    this.previous = this.current;
    this.current = next;
    this.phase = 'settling';
    this.skipped = 0;
    this.window = [];
    return { action: 'grow', target: next, baselineRate: this.baseline, probe };
  }

  private stop(target: number, reason: TurboStopReason, rate: number): TurboDecision {
    this.current = target;
    this.phase = 'done';
    return { action: 'stop', target, reason, rate };
  }
}
