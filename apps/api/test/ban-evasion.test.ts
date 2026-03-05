import assert from "node:assert/strict";
import test from "node:test";
import { calculateBanEvasionScore } from "../src/services/banEvasion";

test("ban evasion scoring flags suspicious account", () => {
  const result = calculateBanEvasionScore({
    steamAccountAgeDays: 5,
    sharedIpHash: true,
    sharedHardwareHash: false,
    sharedIpRange: false,
    sameDiscordInviteSource: true,
    playTimeSimilarity: 0.7,
    discordCreationPatternMatch: false
  });
  assert.equal(result.suspicion_score, 9);
  assert.equal(result.status, "blocked");
  assert.equal(result.auto_block, true);
});

test("ban evasion scoring keeps normal account unflagged", () => {
  const result = calculateBanEvasionScore({
    steamAccountAgeDays: 120,
    sharedIpHash: false,
    sharedHardwareHash: false,
    sharedIpRange: false,
    sameDiscordInviteSource: false,
    playTimeSimilarity: 0.2,
    discordCreationPatternMatch: false
  });
  assert.equal(result.suspicion_score, 0);
  assert.equal(result.status, "normal");
  assert.equal(result.auto_block, false);
});
