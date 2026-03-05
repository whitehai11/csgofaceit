export interface CheatMetrics {
  headshot_rate: number;
  reaction_time: number;
  wallbang_kills: number;
  prefire_kills: number;
  adr: number;
  kd: number;
  reports_received: number;
}

export interface SuspicionResult {
  suspicion_score: number;
  status: "normal" | "flagged" | "overwatch" | "discord_alert";
  reasons: string[];
}

export function calculateSuspicionScore(metrics: CheatMetrics): SuspicionResult {
  let score = 0;
  const reasons: string[] = [];

  if (metrics.headshot_rate > 65) {
    score += 2;
    reasons.push("headshot_rate > 65% (+2)");
  }

  if (metrics.reaction_time < 120) {
    score += 3;
    reasons.push("reaction_time < 120ms (+3)");
  }

  if (metrics.wallbang_kills > 5) {
    score += 2;
    reasons.push("wallbang_kills > 5 (+2)");
  }

  if (metrics.prefire_kills > 7) {
    score += 2;
    reasons.push("prefire_kills > 7 (+2)");
  }

  if (metrics.adr > 130) {
    score += 1;
    reasons.push("ADR > 130 (+1)");
  }

  if (metrics.kd > 2.2) {
    score += 2;
    reasons.push("K/D > 2.2 (+2)");
  }

  if (metrics.reports_received > 3) {
    score += 3;
    reasons.push("reports_received > 3 (+3)");
  }

  let status: SuspicionResult["status"] = "normal";
  if (score > 12) {
    status = "discord_alert";
  } else if (score > 8) {
    status = "overwatch";
  } else if (score >= 5) {
    status = "flagged";
  }

  return {
    suspicion_score: score,
    status,
    reasons
  };
}
