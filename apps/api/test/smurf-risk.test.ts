import test from "node:test";
import assert from "node:assert/strict";
import { computeSmurfScore } from "../src/services/smurfRisk";

test("smurf risk marks normal profile below threshold", () => {
  const result = computeSmurfScore({
    steamAgeDays: 365,
    csHours: 400,
    vacBanCount: 0,
    gameBanCount: 0,
    matchesPlayed: 60,
    wins: 31,
    kd: 1.02,
    adr: 82,
    headshotRate: 44,
    mmrGainPerMatch: 1,
    mmrGainDeltaVsBucket: 0,
    adrDeltaVsBucket: 0,
    hsDeltaVsBucket: 0,
    highHsSustained: false,
    sharedIpWithAny: false,
    sharedIpWithBanned: false,
    sharedDeviceWithAny: false,
    sharedDeviceWithBanned: false,
    reportsAgainst: 1,
    reportAccuracyAgainst: 0
  });
  assert.equal(result.status, "normal");
  assert.ok(result.smurf_score < 40);
});

test("smurf risk marks ban-evasion-likely when shared banned identifiers exist", () => {
  const result = computeSmurfScore({
    steamAgeDays: 10,
    csHours: 12,
    vacBanCount: 0,
    gameBanCount: 0,
    matchesPlayed: 8,
    wins: 8,
    kd: 2.4,
    adr: 130,
    headshotRate: 70,
    mmrGainPerMatch: 25,
    mmrGainDeltaVsBucket: 14,
    adrDeltaVsBucket: 34,
    hsDeltaVsBucket: 22,
    highHsSustained: true,
    sharedIpWithAny: true,
    sharedIpWithBanned: true,
    sharedDeviceWithAny: true,
    sharedDeviceWithBanned: false,
    reportsAgainst: 10,
    reportAccuracyAgainst: 0.8
  });
  assert.equal(result.status, "ban_evasion_likely");
  assert.ok(result.smurf_score >= 90);
});

