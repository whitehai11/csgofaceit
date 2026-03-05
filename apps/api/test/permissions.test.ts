import test from "node:test";
import assert from "node:assert/strict";
import { hasPrivilegedRole, normalizeSafeRelativePath } from "../src/security";

test("moderation routes allow moderator and admin roles", () => {
  assert.equal(hasPrivilegedRole("moderator"), true);
  assert.equal(hasPrivilegedRole("admin"), true);
  assert.equal(hasPrivilegedRole("player"), false);
});

test("safe redirect helper blocks unsafe redirect targets", () => {
  assert.equal(normalizeSafeRelativePath("/auth/callback"), "/auth/callback");
  assert.equal(normalizeSafeRelativePath("https://evil.example"), "/");
  assert.equal(normalizeSafeRelativePath("//evil.example"), "/");
  assert.equal(normalizeSafeRelativePath("\\\\evil"), "/");
});
