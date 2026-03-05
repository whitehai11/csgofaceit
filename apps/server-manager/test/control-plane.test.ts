import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedMap, isAllowedMode, isAuthorizedControlPlaneRequest } from "../src/security";

test("server control plane token auth works", () => {
  assert.equal(isAuthorizedControlPlaneRequest("abc", "abc"), true);
  assert.equal(isAuthorizedControlPlaneRequest("", "abc"), false);
  assert.equal(isAuthorizedControlPlaneRequest("abc", ""), true);
  assert.equal(isAuthorizedControlPlaneRequest("abc", "def"), false);
});

test("server start only accepts allowlisted maps and modes", () => {
  const maps = new Set(["de_mirage", "de_inferno"]);
  const modes = new Set(["ranked", "casual"]);
  assert.equal(isAllowedMap("de_mirage", maps), true);
  assert.equal(isAllowedMap("workshop_123", maps), false);
  assert.equal(isAllowedMode("ranked", modes), true);
  assert.equal(isAllowedMode("zombie", modes), false);
});
