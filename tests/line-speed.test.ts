import { describe, expect, it } from 'vitest';
import { LineSpeedMemory, networkKey, type LineSpeedStore } from '../src/engine/line-speed';

const MBIT = 125_000;
const DAY = 24 * 60 * 60 * 1000;

function memoryStore(): LineSpeedStore & { json: string | null } {
  const store = {
    json: null as string | null,
    load: () => store.json,
    save: (json: string) => {
      store.json = json;
    }
  };
  return store;
}

describe('LineSpeedMemory', () => {
  it('knows nothing until it has measured something', () => {
    expect(new LineSpeedMemory(memoryStore(), () => 'home').hint()).toBeUndefined();
  });

  it('uses the median of what a network recently delivered, so one slow server does not drag it down', () => {
    const memory = new LineSpeedMemory(memoryStore(), () => 'home');
    for (const rate of [30, 32, 5, 31, 33]) memory.observe(rate * MBIT);
    expect(memory.hint()).toBe(31 * MBIT);
  });

  it('keeps each network separate, so a faster or slower one starts fresh', () => {
    const store = memoryStore();
    let where = 'home';
    const memory = new LineSpeedMemory(store, () => where);
    memory.observe(32 * MBIT);
    where = 'office';
    expect(memory.hint()).toBeUndefined();
    memory.observe(500 * MBIT);
    expect(memory.hint()).toBe(500 * MBIT);
    where = 'home';
    expect(memory.hint()).toBe(32 * MBIT);
  });

  it('only remembers the last few measurements, so it follows a changing network', () => {
    const memory = new LineSpeedMemory(memoryStore(), () => 'home');
    for (let i = 0; i < 5; i += 1) memory.observe(32 * MBIT);
    for (let i = 0; i < 5; i += 1) memory.observe(100 * MBIT); // the plan was upgraded
    expect(memory.hint()).toBe(100 * MBIT);
  });

  it('forgets a network after a month', () => {
    let now = 1_000_000;
    const memory = new LineSpeedMemory(memoryStore(), () => 'home', () => now);
    memory.observe(32 * MBIT);
    now += 29 * DAY;
    expect(memory.hint()).toBe(32 * MBIT);
    now += 2 * DAY;
    expect(memory.hint()).toBeUndefined();
  });

  it('ignores figures that say nothing about the network', () => {
    const memory = new LineSpeedMemory(memoryStore(), () => 'home');
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1000]) memory.observe(bad);
    expect(memory.hint()).toBeUndefined();
  });

  it('survives damaged or unwritable storage', () => {
    const broken: LineSpeedStore = {
      load: () => '{not json',
      save: () => {
        throw new Error('disk full');
      }
    };
    const memory = new LineSpeedMemory(broken, () => 'home');
    expect(memory.hint()).toBeUndefined();
    expect(() => memory.observe(32 * MBIT)).not.toThrow();
  });

  it('keeps only the most recently used networks', () => {
    const store = memoryStore();
    let now = 1_000_000;
    let where = 'n0';
    const memory = new LineSpeedMemory(store, () => where, () => now);
    for (let i = 0; i < 30; i += 1) {
      where = `n${i}`;
      now += 1000;
      memory.observe(32 * MBIT);
    }
    expect(Object.keys(JSON.parse(store.json!)).length).toBe(20);
  });
});

describe('networkKey', () => {
  const adapter = (mac: string, cidr: string, extra: Record<string, unknown> = {}) =>
    ({ address: cidr.split('/')[0], netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr, ...extra }) as never;

  it('is the same on the same network and different on another', () => {
    const home = { Ethernet: [adapter('aa:bb:cc:00:00:01', '192.168.1.20/24')] };
    const office = { Ethernet: [adapter('aa:bb:cc:00:00:01', '10.20.30.40/24')] };
    expect(networkKey(home)).toBe(networkKey({ Ethernet: [adapter('aa:bb:cc:00:00:01', '192.168.1.20/24')] }));
    expect(networkKey(home)).not.toBe(networkKey(office));
  });

  it('ignores loopback and IPv6, and the order of adapters', () => {
    const a = adapter('aa:bb:cc:00:00:01', '192.168.1.20/24');
    const b = adapter('aa:bb:cc:00:00:02', '172.16.0.5/24');
    const loopback = adapter('00:00:00:00:00:00', '127.0.0.1/8', { internal: true });
    const v6 = adapter('aa:bb:cc:00:00:01', 'fe80::1/64', { family: 'IPv6' });
    expect(networkKey({ one: [a, loopback, v6], two: [b] })).toBe(networkKey({ two: [b], one: [a] }));
  });

  it('says offline when there is no network', () => {
    expect(networkKey({})).toBe('offline');
  });
});
