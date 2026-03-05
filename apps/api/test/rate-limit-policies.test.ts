import test from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_POLICIES } from "../src/rateLimitPolicies";

test("rate-limit policies enforce strict queue/report throttles", () => {
  assert.equal(RATE_LIMIT_POLICIES.queueJoin.max, 2);
  assert.equal(RATE_LIMIT_POLICIES.queueJoin.timeWindow, "10 seconds");
  assert.equal(RATE_LIMIT_POLICIES.report.max, 3);
  assert.equal(RATE_LIMIT_POLICIES.report.timeWindow, "1 minute");
  assert.equal(RATE_LIMIT_POLICIES.telemetryIngest.max, 300);
  assert.equal(RATE_LIMIT_POLICIES.telemetryIngest.timeWindow, "10 seconds");
});
