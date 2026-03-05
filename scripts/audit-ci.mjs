#!/usr/bin/env node
import { execSync } from "node:child_process";

function runAudit() {
  try {
    const raw = execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(raw);
  } catch (error) {
    const stdout = String(error?.stdout ?? "").trim();
    if (!stdout) throw error;
    return JSON.parse(stdout);
  }
}

function toNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

const report = runAudit();
const counts = {
  low: toNumber(report?.metadata?.vulnerabilities?.low),
  moderate: toNumber(report?.metadata?.vulnerabilities?.moderate),
  high: toNumber(report?.metadata?.vulnerabilities?.high),
  critical: toNumber(report?.metadata?.vulnerabilities?.critical)
};

console.log(
  `[audit] low=${counts.low} moderate=${counts.moderate} high=${counts.high} critical=${counts.critical}`
);

if (counts.high > 0 || counts.critical > 0) {
  console.error("[audit] blocking: high/critical vulnerabilities detected");
  process.exit(1);
}

if (counts.moderate > 0) {
  console.warn("[audit] warning: moderate vulnerabilities remain (non-blocking)");
}

