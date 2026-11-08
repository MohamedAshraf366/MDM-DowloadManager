import { describe, expect, it } from 'vitest';
import { DEFAULT_TURBO_TUNING, TurboController } from '../src/engine/turbo';

const MBIT = 125_000; // bytes per second in one megabit per second

/** Deterministic noise so the tests never flake. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Link {
  /** Total capacity of the line, bytes/s. */
  line: number;
  /** What a single connection can get from the server, bytes/s. */
  perConnection: number;
}

function simulate(link: Link, base: number, ceiling: number, noise = 0, seed = 1, capacity?: number) {
  const controller = new TurboController(base, ceiling, DEFAULT_TURBO_TUNING, capacity);
  const random = prng(seed);
  let connections = base;
  let samples = 0;
  let peak = base;
  let stop: { reason: string; rate: number } | null = null;
  let firstJump = 0;
  for (; samples < 200 && !controller.done; samples += 1) {
    const ideal = Math.min(connections * link.perConnection, link.line);
    const rate = ideal * (1 + (random() * 2 - 1) * noise);
    const decision = controller.sample(rate, { pushback: false, headroom: 1000 });
    if (decision.action === 'grow' && firstJump === 0) firstJump = decision.target;
    if (decision.action === 'grow' || decision.action === 'stop') connections = decision.target;
    if (decision.action === 'stop') stop = { reason: decision.reason, rate: decision.rate };
    peak = Math.max(peak, connections);
  }
  return { final: controller.target, samples, peak, stop, firstJump, achieved: Math.min(controller.target * link.perConnection, link.line) };
}

describe('TurboController finds the capacity of any link', () => {
  // The same rule has to work whatever the line speed is. In each case a plain
  // 8-connection download leaves part of the line unused.
  const lines = [
    { name: '5 Mbit/s', line: 5 * MBIT, perConnection: 0.2 * MBIT },
    { name: '30 Mbit/s', line: 30 * MBIT, perConnection: 2 * MBIT },
    { name: '100 Mbit/s', line: 100 * MBIT, perConnection: 5 * MBIT },
    { name: '500 Mbit/s', line: 500 * MBIT, perConnection: 20 * MBIT }
  ];
  for (const link of lines) {
    it(`reaches at least 95% of a ${link.name} line`, () => {
      const run = simulate(link, 8, 64);
      expect(run.achieved / link.line).toBeGreaterThanOrEqual(0.95);
      expect(run.stop?.reason).toBe('plateau');
      // And it does not keep piling on connections beyond what it needed.
      const needed = Math.ceil(link.line / link.perConnection);
      expect(run.final).toBeLessThanOrEqual(Math.ceil(needed * DEFAULT_TURBO_TUNING.growth) + 1);
    });
  }

  it('does nothing when the line is already full with the starting connections', () => {
    const run = simulate({ line: 8 * MBIT, perConnection: 4 * MBIT }, 8, 64);
    expect(run.final).toBe(8);
    expect(run.stop?.reason).toBe('plateau');
  });

  it('never exceeds the configured ceiling', () => {
    const run = simulate({ line: 1000 * MBIT, perConnection: 1 * MBIT }, 8, 20);
    expect(run.peak).toBeLessThanOrEqual(20);
    expect(run.final).toBe(20);
    expect(run.stop?.reason).toBe('ceiling');
  });

  it('is not fooled by throughput noise when the line is already full', () => {
    let grew = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const run = simulate({ line: 30 * MBIT, perConnection: 5 * MBIT }, 8, 64, 0.1, seed);
      if (run.final > 8) grew += 1;
    }
    // 10% random jitter on every sample must not make it grow in most runs.
    expect(grew).toBeLessThan(30);
  });

  it('still finds the capacity through noise when there is room to grow', () => {
    let good = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const link = { line: 30 * MBIT, perConnection: 2 * MBIT };
      const run = simulate(link, 8, 64, 0.1, seed);
      if (run.achieved / link.line >= 0.9) good += 1;
    }
    expect(good).toBeGreaterThan(170);
  });
});

describe('TurboController backs off', () => {
  it('returns to the last safe count when the server pushes back', () => {
    const controller = new TurboController(8, 64);
    let result = controller.sample(10, { pushback: false, headroom: 1000 });
    for (let i = 0; i < 20 && result.action !== 'grow'; i += 1) {
      result = controller.sample(10 * MBIT, { pushback: false, headroom: 1000 });
    }
    expect(result).toMatchObject({ action: 'grow', target: 12 });
    const stopped = controller.sample(10 * MBIT, { pushback: true, headroom: 1000 });
    expect(stopped).toMatchObject({ action: 'stop', reason: 'server-limit', target: 8 });
    expect(controller.sample(10 * MBIT, { pushback: false, headroom: 1000 })).toEqual({ action: 'hold' });
  });

  it('only grows by what the remaining data can feed', () => {
    const controller = new TurboController(8, 64);
    let result = controller.sample(10 * MBIT, { pushback: false, headroom: 3 });
    for (let i = 0; i < 20 && result.action !== 'grow'; i += 1) {
      result = controller.sample(10 * MBIT, { pushback: false, headroom: 3 });
    }
    // The normal step would be 8 -> 12, but only 3 more connections can be fed.
    expect(result).toMatchObject({ action: 'grow', target: 11 });
  });

  it('stops growing when there is nothing left to split', () => {
    const controller = new TurboController(8, 64);
    const stopped = controller.sample(10 * MBIT, { pushback: false, headroom: 0 });
    expect(stopped).toMatchObject({ action: 'stop', reason: 'no-work', target: 8 });
  });
});

describe('TurboController with a known speed for the network (a starting point, never a limit)', () => {
  const lines = [
    { name: '5 Mbit/s', line: 5 * MBIT, perConnection: 0.2 * MBIT },
    { name: '30 Mbit/s', line: 30 * MBIT, perConnection: 2 * MBIT },
    { name: '100 Mbit/s', line: 100 * MBIT, perConnection: 5 * MBIT },
    { name: '500 Mbit/s', line: 500 * MBIT, perConnection: 20 * MBIT }
  ];
  for (const link of lines) {
    it(`reaches a ${link.name} line faster than searching blindly`, () => {
      const blind = simulate(link, 8, 64);
      const told = simulate(link, 8, 64, 0, 1, link.line);
      expect(told.achieved / link.line).toBeGreaterThanOrEqual(0.95);
      expect(told.samples).toBeLessThan(blind.samples);
    });

    it(`is not held back by a speed learned on a much slower network (now on ${link.name})`, () => {
      // The remembered figure is a quarter of what this network can do.
      const run = simulate(link, 8, 64, 0, 1, link.line / 4);
      expect(run.achieved / link.line).toBeGreaterThanOrEqual(0.95);
    });
  }

  it('finds a faster network instead of stopping at the old number', () => {
    // 32 Mbit/s was the speed before; this network does 100.
    const link = { line: 100 * MBIT, perConnection: 5 * MBIT };
    const run = simulate(link, 8, 64, 0, 1, 32 * MBIT);
    expect(run.achieved / link.line).toBeGreaterThanOrEqual(0.95);
    expect(run.final).toBeGreaterThan(8);
  });

  it('checks once for more when the starting connections already reach the known speed, then settles', () => {
    const run = simulate({ line: 8 * MBIT, perConnection: 4 * MBIT }, 8, 64, 0, 1, 8 * MBIT);
    expect(run.final).toBe(8);
    expect(run.stop?.reason).toBe('plateau');
    // The check is a small step (about a quarter more), not a search.
    expect(run.peak).toBeLessThanOrEqual(10);
  });

  it('does not overshoot badly when the remembered speed is higher than this network can give', () => {
    // Remembered 100 Mbit/s, but this server only ever gives 20 in total.
    const link = { line: 20 * MBIT, perConnection: 2 * MBIT };
    const run = simulate(link, 8, 64, 0, 1, 100 * MBIT);
    expect(run.stop?.reason).toBe('plateau');
    expect(run.achieved / link.line).toBeGreaterThanOrEqual(0.95);
    expect(run.final).toBeLessThanOrEqual(12);
  });

  it('never multiplies the connections by more than the jump limit in one step', () => {
    const run = simulate({ line: 500 * MBIT, perConnection: 1 * MBIT }, 4, 64, 0, 1, 500 * MBIT);
    expect(run.firstJump).toBeLessThanOrEqual(4 * DEFAULT_TURBO_TUNING.maxJump);
  });

  it('still behaves through throughput noise', () => {
    let good = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const link = { line: 30 * MBIT, perConnection: 2 * MBIT };
      const run = simulate(link, 8, 64, 0.1, seed, link.line);
      if (run.achieved / link.line >= 0.9) good += 1;
    }
    expect(good).toBeGreaterThan(170);
  });
});
