export type Role = "player" | "moderator" | "admin";

export interface PlayerProfile {
  id: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  rank: string;
  reportScore: number;
  role: Role;
  createdAt: string;
}

export interface MatchPlayer {
  playerId: string;
  team: "A" | "B";
}

export interface Match {
  id: string;
  map: string;
  status: "pending" | "live" | "finished";
  serverIp: string | null;
  serverPort: number | null;
  serverPassword: string | null;
  spectatorPassword: string | null;
  connectString: string | null;
  demoUrl: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface ReportInput {
  reporterId: string;
  reportedPlayerId: string;
  matchId: string;
  reason: string;
}

export interface OverwatchCase {
  id: string;
  reportedPlayerId: string;
  matchId: string;
  status: "open" | "resolved";
  demoUrl: string | null;
  createdAt: string;
  resolvedBy: string | null;
  resolution: string | null;
}

export const MAP_POOL = ["de_mirage", "de_inferno", "de_nuke", "de_ancient", "de_anubis"];
