import { afterEach, describe, expect, it } from 'vitest';
import { formatBitRate, formatSpeed, setSpeedUnit } from '../src/shared/format';

afterEach(() => setSpeedUnit('bytes'));

describe('formatSpeed', () => {
  it('keeps the file-size style by default', () => {
    expect(formatSpeed(4_000_000)).toBe('3.8 MB/s');
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(null)).toBe('—');
  });

  it('shows what a speed test shows when asked for Mbit/s', () => {
    setSpeedUnit('bits');
    // A 32 Mbit/s line moves 4,000,000 bytes per second.
    expect(formatSpeed(4_000_000)).toBe('32.0 Mbit/s');
    expect(formatSpeed(12_500_000)).toBe('100 Mbit/s');
    expect(formatSpeed(125_000_000)).toBe('1.00 Gbit/s');
    expect(formatSpeed(50_000)).toBe('400 Kbit/s');
    expect(formatSpeed(0)).toBe('—');
  });

  it('uses decimal bits, not powers of 1024', () => {
    expect(formatBitRate(1_000_000)).toBe('8.0 Mbit/s');
    expect(formatBitRate(1_048_576)).toBe('8.4 Mbit/s');
  });
});
