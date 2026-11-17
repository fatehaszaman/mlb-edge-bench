import { describe, it, expect } from 'vitest';
import { winProbability, extractSnapshot } from '../src/snapshot';

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

describe('extractSnapshot for finished games', () => {
  const feed = (state: string, inningHalf: string, home: number, away: number) => ({
    gameData: {
      status: { abstractGameState: state, detailedState: state },
      teams: { home: { name: 'Home' }, away: { name: 'Away' } },
    },
    liveData: {
      linescore: {
        currentInning: 9,
        inningHalf,
        outs: 3,
        offense: {},
        teams: { home: { runs: home }, away: { runs: away } },
      },
    },
  });

  it('a home win ending in the top of the 9th is 1', () => {
    expect(extractSnapshot('1', feed('Final', 'Top', 3, 2), 'IAD', 0)?.homeWinProbability).toBe(1);
  });

  it('a home loss is 0', () => {
    expect(extractSnapshot('1', feed('Final', 'Bottom', 1, 4), 'IAD', 0)?.homeWinProbability).toBe(0);
  });

  it('a live game still uses the in-game model', () => {
    const wp = extractSnapshot('1', feed('Live', 'Top', 3, 2), 'IAD', 0)?.homeWinProbability;
    expect(wp).toBeGreaterThan(0.5);
    expect(wp).toBeLessThan(1);
  });
});
