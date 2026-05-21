// Pure functions for extracting a slimmed snapshot from MLB's GUMBO feed and
// computing an in-edge win probability. Kept separate so the DO and the Phase 1
// fallback path can share the same logic.

export interface GameSnapshot {
  gameId: string;
  status: string;
  inning: number;
  halfInning: 'T' | 'B';
  outs: number;
  baseState: string;        // 3-char string of '0'/'1' for 1B/2B/3B occupancy
  homeScore: number;
  awayScore: number;
  homeTeam: string;
  awayTeam: string;
  homeWinProbability: number;
  fetchedAt: string;
  edgeRegion: string;
  edgeLatencyMs: number;
}

export function extractSnapshot(
  gameId: string,
  raw: any,
  colo: string,
  latencyMs: number
): GameSnapshot | null {
  const linescore = raw?.liveData?.linescore;
  const teams = raw?.gameData?.teams;
  if (!linescore || !teams) return null;

  const inning = linescore.currentInning ?? 1;
  const halfInning: 'T' | 'B' =
    (linescore.inningHalf ?? 'Top') === 'Top' ? 'T' : 'B';
  const outs = linescore.outs ?? 0;
  const homeScore = linescore.teams?.home?.runs ?? 0;
  const awayScore = linescore.teams?.away?.runs ?? 0;
  const offense = linescore.offense ?? {};
  const baseState =
    (offense.first ? '1' : '0') +
    (offense.second ? '1' : '0') +
    (offense.third ? '1' : '0');

  const runDiff = Math.max(-5, Math.min(5, homeScore - awayScore));
  const homeWP = winProbability(halfInning, inning, outs, baseState, runDiff);

  return {
    gameId,
    status: raw?.gameData?.status?.detailedState ?? 'Unknown',
    inning,
    halfInning,
    outs,
    baseState,
    homeScore,
    awayScore,
    homeTeam: teams.home?.name ?? 'Home',
    awayTeam: teams.away?.name ?? 'Away',
    homeWinProbability: Number(homeWP.toFixed(4)),
    fetchedAt: new Date().toISOString(),
    edgeRegion: colo,
    edgeLatencyMs: latencyMs,
  };
}

// Closed-form win probability approximation. Intentionally simple — the
// centerpiece of this project is the delivery layer, not the model. Structured
// so a Retrosheet-fitted lookup can swap in without touching the Worker or DO.
export function winProbability(
  half: 'T' | 'B',
  inning: number,
  outs: number,
  baseState: string,
  runDiff: number
): number {
  // Walk-off / mathematically decided edge cases.
  if (inning >= 9 && half === 'B' && runDiff > 0) return 1.0;
  if (inning > 9 && half === 'T' && runDiff < 0) return 0.0;

  const inningWeight = Math.min(1, inning / 9);
  const runValue = 0.08 + inningWeight * 0.12;

  let wp = 0.5 + runDiff * runValue;
  wp += (outs - 1) * 0.02 * Math.sign(runDiff);

  const runners = baseState.split('').filter((b) => b === '1').length;
  const battingBoost = runners * 0.03;
  wp += half === 'T' ? -battingBoost : battingBoost;

  return Math.max(0.01, Math.min(0.99, wp));
}

// Structural diff between two snapshots. Used by the SSE stream so each push
// is just the fields that changed since the last sample.
export function computeDiff(
  prev: Record<string, any>,
  curr: Record<string, any>
): Record<string, any> {
  const diff: Record<string, any> = {};
  for (const key of Object.keys(curr)) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(curr[key])) {
      diff[key] = curr[key];
    }
  }
  return diff;
}
