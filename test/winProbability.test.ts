import { describe, it, expect } from 'vitest';
import { winProbability } from '../src/snapshot';

describe('winProbability', () => {
  it('home lead in the bottom of the 9th is a decided win', () => {
    expect(winProbability('B', 9, 0, '000', 1)).toBe(1.0);
  });

  it('home trailing in the top of an extra inning is not decided', () => {
    const wp = winProbability('T', 10, 0, '000', -1);
    expect(wp).toBeGreaterThan(0.01);
    expect(wp).toBeLessThan(0.5);
  });

  it('stays inside [0.01, 0.99] for every non-decided state', () => {
    for (const half of ['T', 'B'] as const)
      for (let inning = 1; inning <= 12; inning++)
        for (let outs = 0; outs <= 2; outs++)
          for (let rd = -5; rd <= 5; rd++) {
            const wp = winProbability(half, inning, outs, '101', rd);
            if (wp !== 1.0) {
              expect(wp).toBeGreaterThanOrEqual(0.01);
              expect(wp).toBeLessThanOrEqual(0.99);
            }
          }
  });

  it('is monotonic in run differential', () => {
    for (let rd = -5; rd < 5; rd++) {
      expect(winProbability('T', 5, 1, '000', rd + 1))
        .toBeGreaterThanOrEqual(winProbability('T', 5, 1, '000', rd));
    }
  });

  it('an out helps the fielding team', () => {
    expect(winProbability('T', 5, 2, '000', 0))
      .toBeGreaterThan(winProbability('T', 5, 0, '000', 0));
    expect(winProbability('B', 5, 2, '000', 0))
      .toBeLessThan(winProbability('B', 5, 0, '000', 0));
  });
});
