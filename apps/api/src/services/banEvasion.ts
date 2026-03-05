export type BanEvasionSignals = {
  steamAccountAgeDays?: number | null;
  sharedIpHash: boolean;
  sharedHardwareHash: boolean;
  sharedIpRange: boolean;
  sameDiscordInviteSource: boolean;
  playTimeSimilarity: number;
  discordCreationPatternMatch: boolean;
};

export type BanEvasionResult = {
  suspicion_score: number;
  status: "normal" | "flagged" | "blocked";
  reasons: string[];
  should_alert: boolean;
  auto_block: boolean;
};

export function calculateBanEvasionScore(input: BanEvasionSignals): BanEvasionResult {
  const reasons: string[] = [];
  let score = 0;

  if (typeof input.steamAccountAgeDays === "number" && input.steamAccountAgeDays < 30) {
    score += 2;
    reasons.push("new steam account (<30 days) (+2)");
  }

  if (input.sharedIpHash) {
    score += 4;
    reasons.push("shared IP hash with banned account (+4)");
  }

  if (input.sharedHardwareHash) {
    score += 5;
    reasons.push("shared hardware hash with banned account (+5)");
  }

  if (input.sharedIpRange) {
    score += 2;
    reasons.push("same IP range as banned account (+2)");
  }

  if (input.sameDiscordInviteSource) {
    score += 1;
    reasons.push("same Discord invite source (+1)");
  }

  if (input.playTimeSimilarity >= 0.6) {
    score += 2;
    reasons.push("similar play-time pattern (+2)");
  }

  if (input.discordCreationPatternMatch) {
    score += 1;
    reasons.push("similar Discord account creation pattern (+1)");
  }

  let status: "normal" | "flagged" | "blocked" = "normal";
  if (score > 8) {
    status = "blocked";
  } else if (score > 5) {
    status = "flagged";
  }

  return {
    suspicion_score: score,
    status,
    reasons,
    should_alert: score > 5,
    auto_block: score > 8
  };
}
