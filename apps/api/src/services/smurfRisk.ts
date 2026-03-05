export type SmurfRiskInput = {
  steamAgeDays: number | null;
  csHours: number | null;
  vacBanCount: number;
  gameBanCount: number;
  matchesPlayed: number;
  wins: number;
  kd: number;
  adr: number;
  headshotRate: number;
  mmrGainPerMatch: number;
  mmrGainDeltaVsBucket: number;
  adrDeltaVsBucket: number;
  hsDeltaVsBucket: number;
  highHsSustained: boolean;
  sharedIpWithAny: boolean;
  sharedIpWithBanned: boolean;
  sharedDeviceWithAny: boolean;
  sharedDeviceWithBanned: boolean;
  reportsAgainst: number;
  reportAccuracyAgainst: number;
};

export type SmurfRiskWeights = {
  steamAgeLt30: number;
  csHoursLt50: number;
  lowMatchesHighAdr: number;
  highWinrateAfter15: number;
  highMmrGain: number;
  sustainedHighHs: number;
  sharedIp: number;
  sharedIpBanned: number;
  sharedDevice: number;
  sharedDeviceBanned: number;
  reportPressure: number;
  reportAccuracyPressure: number;
};

export type SmurfRiskResult = {
  smurf_score: number;
  status: "normal" | "suspected_smurf" | "high_suspicion" | "ban_evasion_likely";
  reasons: string[];
};

export const DEFAULT_SMURF_WEIGHTS: SmurfRiskWeights = {
  steamAgeLt30: 25,
  csHoursLt50: 15,
  lowMatchesHighAdr: 15,
  highWinrateAfter15: 10,
  highMmrGain: 10,
  sustainedHighHs: 10,
  sharedIp: 20,
  sharedIpBanned: 40,
  sharedDevice: 20,
  sharedDeviceBanned: 40,
  reportPressure: 5,
  reportAccuracyPressure: 5
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeSmurfScore(input: SmurfRiskInput, weights: SmurfRiskWeights = DEFAULT_SMURF_WEIGHTS): SmurfRiskResult {
  let score = 0;
  const reasons: string[] = [];

  if ((input.steamAgeDays ?? 9999) < 30) {
    score += weights.steamAgeLt30;
    reasons.push(`steam age < 30d (+${weights.steamAgeLt30})`);
  }
  if ((input.csHours ?? 999999) < 50) {
    score += weights.csHoursLt50;
    reasons.push(`CS hours < 50 (+${weights.csHoursLt50})`);
  }
  if (input.matchesPlayed < 10 && (input.adr > 110 || input.adrDeltaVsBucket > 20)) {
    score += weights.lowMatchesHighAdr;
    reasons.push(`low matches + high ADR (+${weights.lowMatchesHighAdr})`);
  }
  const winRate = input.matchesPlayed > 0 ? (input.wins / input.matchesPlayed) * 100 : 0;
  if (input.matchesPlayed >= 15 && winRate > 75) {
    score += weights.highWinrateAfter15;
    reasons.push(`winrate > 75% after 15 matches (+${weights.highWinrateAfter15})`);
  }
  if (input.mmrGainPerMatch > 22 || input.mmrGainDeltaVsBucket > 8) {
    score += weights.highMmrGain;
    reasons.push(`MMR gain per match high (+${weights.highMmrGain})`);
  }
  if (input.highHsSustained && (input.headshotRate > 65 || input.hsDeltaVsBucket > 10)) {
    score += weights.sustainedHighHs;
    reasons.push(`sustained high headshot rate (+${weights.sustainedHighHs})`);
  }
  if (input.sharedIpWithAny) {
    score += weights.sharedIp;
    reasons.push(`shared ip hash with another account (+${weights.sharedIp})`);
  }
  if (input.sharedIpWithBanned) {
    score += weights.sharedIpBanned;
    reasons.push(`shared ip hash with banned account (+${weights.sharedIpBanned})`);
  }
  if (input.sharedDeviceWithAny) {
    score += weights.sharedDevice;
    reasons.push(`shared device hash with another account (+${weights.sharedDevice})`);
  }
  if (input.sharedDeviceWithBanned) {
    score += weights.sharedDeviceBanned;
    reasons.push(`shared device hash with banned account (+${weights.sharedDeviceBanned})`);
  }
  if (input.reportsAgainst > 8) {
    score += weights.reportPressure;
    reasons.push(`high report volume against player (+${weights.reportPressure})`);
  }
  if (input.reportAccuracyAgainst > 0.6 && input.reportsAgainst > 4) {
    score += weights.reportAccuracyPressure;
    reasons.push(`high report accuracy against player (+${weights.reportAccuracyPressure})`);
  }

  const smurfScore = clamp(Math.round(score), 0, 100);
  if (smurfScore >= 90) {
    return { smurf_score: smurfScore, status: "ban_evasion_likely", reasons };
  }
  if (smurfScore >= 70) {
    return { smurf_score: smurfScore, status: "high_suspicion", reasons };
  }
  if (smurfScore >= 40) {
    return { smurf_score: smurfScore, status: "suspected_smurf", reasons };
  }
  return { smurf_score: smurfScore, status: "normal", reasons };
}
