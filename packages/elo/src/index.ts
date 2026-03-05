export type RankName =
  | "Silver"
  | "Gold Nova"
  | "Master Guardian"
  | "Distinguished Master Guardian"
  | "Legendary Eagle"
  | "Supreme"
  | "Global Elite";

export type MatchResult = "win" | "loss";

export interface PlayerPerformance {
  adr: number;
  mvps: number;
  kd: number;
}

export interface PlayerRatingState {
  mmr: number;
  winStreak: number;
}

export interface RatingUpdateInput {
  state: PlayerRatingState;
  result: MatchResult;
  performance: PlayerPerformance;
}

export interface RatingUpdateResult {
  mmrBefore: number;
  mmrAfter: number;
  mmrDelta: number;
  streakBefore: number;
  streakAfter: number;
  rank: RankName;
}

export const STARTING_MMR = 1000;
export const BASE_WIN_DELTA = 25;
export const BASE_LOSS_DELTA = -25;

export function rankFromMmr(mmr: number): RankName {
  if (mmr < 900) return "Silver";
  if (mmr < 1100) return "Gold Nova";
  if (mmr < 1300) return "Master Guardian";
  if (mmr < 1500) return "Distinguished Master Guardian";
  if (mmr < 1700) return "Legendary Eagle";
  if (mmr < 1900) return "Supreme";
  return "Global Elite";
}

export function winStreakBonus(streakAfterMatch: number): number {
  if (streakAfterMatch >= 5) return 20;
  if (streakAfterMatch >= 3) return 10;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function performanceModifier(perf: PlayerPerformance): number {
  const adrScore = clamp((perf.adr - 80) / 20, -2, 2);
  const mvpScore = clamp((perf.mvps - 1) * 0.75, -1.5, 1.5);
  const kdScore = clamp((perf.kd - 1) * 2, -2, 2);
  return Math.round(clamp(adrScore + mvpScore + kdScore, -5, 5));
}

export function calculateMmrDelta(input: RatingUpdateInput): number {
  const streakAfter = input.result === "win" ? input.state.winStreak + 1 : 0;
  const base = input.result === "win" ? BASE_WIN_DELTA : BASE_LOSS_DELTA;
  const streak = input.result === "win" ? winStreakBonus(streakAfter) : 0;
  const perf = performanceModifier(input.performance);
  return base + streak + perf;
}

export function applyMatchResult(input: RatingUpdateInput): RatingUpdateResult {
  const mmrBefore = input.state.mmr;
  const streakBefore = input.state.winStreak;
  const streakAfter = input.result === "win" ? streakBefore + 1 : 0;
  const mmrDelta = calculateMmrDelta(input);
  const mmrAfter = Math.max(0, mmrBefore + mmrDelta);

  return {
    mmrBefore,
    mmrAfter,
    mmrDelta,
    streakBefore,
    streakAfter,
    rank: rankFromMmr(mmrAfter)
  };
}
