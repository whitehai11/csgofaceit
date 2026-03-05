export const RATE_LIMIT_POLICIES = {
  queueJoin: { max: 2, timeWindow: "10 seconds" },
  report: { max: 3, timeWindow: "1 minute" },
  matchRead: { max: 30, timeWindow: "1 minute" },
  casesRead: { max: 20, timeWindow: "1 minute" },
  casesVote: { max: 10, timeWindow: "1 minute" },
  serversRead: { max: 30, timeWindow: "1 minute" },
  telemetryIngest: { max: 300, timeWindow: "10 seconds" }
} as const;
