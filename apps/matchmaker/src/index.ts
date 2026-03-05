import crypto from "node:crypto";
import http from "node:http";
import Redis from "ioredis";
import { fetch } from "undici";
import { MAP_POOL } from "@csgofaceit/shared";
import { createServiceLogger } from "@csgofaceit/logger";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const apiBaseUrl = process.env.API_BASE_URL ?? "http://api:3001";
const eventLogger = createServiceLogger("matchmaker");
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? "";
const antiCheatProcessIntervalMs = Number(process.env.ANTI_CHEAT_PROCESS_INTERVAL_MS ?? 5000);
const smurfRiskProcessIntervalMs = Number(process.env.SMURF_RISK_PROCESS_INTERVAL_MS ?? 10000);

type QueueEntry = {
  player_id: string;
  elo: number;
  mode: "ranked" | "wingman" | "casual" | "superpower" | "gungame" | "zombie" | "clanwars";
  smurf_pool?: boolean;
  clan_id?: string | null;
  clan_tag?: string | null;
  region: string;
  timestamp: string;
};

const modeConfig: Record<QueueEntry["mode"], { playersPerMatch: number; teamSize: number; unranked: boolean }> = {
  ranked: { playersPerMatch: 10, teamSize: 5, unranked: false },
  wingman: { playersPerMatch: 4, teamSize: 2, unranked: false },
  casual: { playersPerMatch: 20, teamSize: 10, unranked: true },
  superpower: { playersPerMatch: 20, teamSize: 10, unranked: true },
  gungame: { playersPerMatch: 20, teamSize: 10, unranked: true },
  zombie: { playersPerMatch: 20, teamSize: 10, unranked: true },
  clanwars: { playersPerMatch: 10, teamSize: 5, unranked: false }
};

const popCountLua = `
local orderKey = KEYS[1]
local entriesKey = KEYS[2]
local count = tonumber(ARGV[1])
if redis.call('ZCARD', orderKey) < count then
  return {}
end
local ids = redis.call('ZRANGE', orderKey, 0, count - 1)
local players = {}
for i = 1, #ids do
  local p = redis.call('HGET', entriesKey, ids[i])
  if p then
    table.insert(players, p)
  end
end
redis.call('ZREM', orderKey, unpack(ids))
redis.call('HDEL', entriesKey, unpack(ids))
return players
`;

function balanceTeamsByElo(players: QueueEntry[], teamSize: number): { teamA: QueueEntry[]; teamB: QueueEntry[] } {
  const ordered = [...players].sort((a, b) => b.elo - a.elo);
  const teamA: QueueEntry[] = [];
  const teamB: QueueEntry[] = [];
  let eloA = 0;
  let eloB = 0;

  for (const player of ordered) {
    const canJoinA = teamA.length < teamSize;
    const canJoinB = teamB.length < teamSize;
    if (canJoinA && (!canJoinB || eloA <= eloB)) {
      teamA.push(player);
      eloA += player.elo;
    } else {
      teamB.push(player);
      eloB += player.elo;
    }
  }

  return { teamA, teamB };
}

async function getDailyMapPool(): Promise<string[]> {
  try {
    const response = await fetch(`${apiBaseUrl}/maps/today`);
    if (!response.ok) {
      return [...MAP_POOL];
    }
    const data = (await response.json()) as { maps?: string[] };
    if (!Array.isArray(data.maps) || data.maps.length === 0) {
      return [...MAP_POOL];
    }
    return data.maps;
  } catch {
    return [...MAP_POOL];
  }
}

async function runAntiCheatLoop(): Promise<void> {
  while (true) {
    try {
      const response = await fetch(`${apiBaseUrl}/internal/anti-cheat/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(internalApiToken ? { "x-internal-token": internalApiToken } : {})
        },
        body: JSON.stringify({ limit: 10 })
      });
      if (!response.ok) {
        eventLogger.info("anti_cheat_worker_request_failed", { status: response.status });
      } else {
        const payloadUnknown = await response.json().catch(() => ({}));
        const payload = (payloadUnknown && typeof payloadUnknown === "object"
          ? payloadUnknown
          : {}) as { processed_matches?: number };
        if (Number(payload.processed_matches ?? 0) > 0) {
          eventLogger.info("anti_cheat_worker_processed", payload as Record<string, unknown>);
        }
      }
    } catch (error) {
      eventLogger.error("anti_cheat_worker_error", { error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, antiCheatProcessIntervalMs));
  }
}

async function runSmurfRiskLoop(): Promise<void> {
  while (true) {
    try {
      const response = await fetch(`${apiBaseUrl}/internal/risk/smurf/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(internalApiToken ? { "x-internal-token": internalApiToken } : {})
        },
        body: JSON.stringify({ limit: 100 })
      });
      if (!response.ok) {
        eventLogger.info("smurf_worker_request_failed", { status: response.status });
      } else {
        const payloadUnknown = await response.json().catch(() => ({}));
        const payload = (payloadUnknown && typeof payloadUnknown === "object"
          ? payloadUnknown
          : {}) as { processed?: number };
        if (Number(payload.processed ?? 0) > 0) {
          eventLogger.info("smurf_worker_processed", payload as Record<string, unknown>);
        }
      }
    } catch (error) {
      eventLogger.error("smurf_worker_error", { error: String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, smurfRiskProcessIntervalMs));
  }
}

async function runLoop(): Promise<void> {
  while (true) {
    try {
      for (const mode of Object.keys(modeConfig) as QueueEntry["mode"][]) {
        const cfg = modeConfig[mode];
        const pools = mode === "clanwars" ? (["normal"] as const) : (["normal", "smurf"] as const);
        for (const pool of pools) {
          const orderKey = pool === "smurf" ? `queue:${mode}:smurf:order` : `queue:${mode}:order`;
          const entriesKey = pool === "smurf" ? `queue:${mode}:smurf:entries` : `queue:${mode}:entries`;
          let players: QueueEntry[] = [];

          if (mode === "clanwars") {
            const raw = await redis.hgetall(entriesKey);
            const parsed = Object.values(raw)
              .map((entry) => {
                try {
                  return JSON.parse(String(entry)) as QueueEntry;
                } catch {
                  return null;
                }
              })
              .filter((x): x is QueueEntry => Boolean(x?.player_id));
            const clanBuckets = new Map<string, QueueEntry[]>();
            for (const p of parsed) {
              const clanId = String(p.clan_id ?? "");
              if (!clanId) continue;
              const bucket = clanBuckets.get(clanId) ?? [];
              bucket.push(p);
              clanBuckets.set(clanId, bucket);
            }
            const fullTeams = Array.from(clanBuckets.entries())
              .map(([clanId, members]) => ({
                clanId,
                members: members.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).slice(0, 5),
                oldest: Math.min(...members.map((m) => new Date(m.timestamp).getTime()))
              }))
              .filter((x) => x.members.length === 5)
              .sort((a, b) => a.oldest - b.oldest);

            if (fullTeams.length >= 2) {
              const clanA = fullTeams[0];
              const clanB = fullTeams[1];
              players = [...clanA.members, ...clanB.members];
              const idsToRemove = players.map((p) => p.player_id);
              await redis.multi().zrem(orderKey, ...idsToRemove).hdel(entriesKey, ...idsToRemove).exec();
            }
          } else {
            const popped = await redis.eval(popCountLua, 2, orderKey, entriesKey, cfg.playersPerMatch);
            players = (Array.isArray(popped) ? popped : []).map((entry) => JSON.parse(String(entry)) as QueueEntry);
          }

          if (players.length !== cfg.playersPerMatch) {
            continue;
          }

          const dailyMapPool = await getDailyMapPool();
          const { teamA, teamB } =
            mode === "clanwars"
              ? {
                  teamA: players.slice(0, cfg.teamSize),
                  teamB: players.slice(cfg.teamSize, cfg.playersPerMatch)
                }
              : balanceTeamsByElo(players, cfg.teamSize);
          const matchId = crypto.randomUUID();
          const smurfPool = pool === "smurf";
          eventLogger.info("match_creation", {
            match_id: matchId,
            mode,
            smurf_pool: smurfPool,
            players: players.map((p) => p.player_id),
            team_a_avg_elo: Math.round(teamA.reduce((sum, p) => sum + p.elo, 0) / teamA.length),
            team_b_avg_elo: Math.round(teamB.reduce((sum, p) => sum + p.elo, 0) / teamB.length),
            map_pool: dailyMapPool
          });

          await redis.publish(
            "match-events",
            JSON.stringify({
              type: "match_found",
              mode,
              smurf_pool: smurfPool,
              unranked: cfg.unranked,
              matchId,
              players: players.map((p) => p.player_id),
              daily_map_pool: dailyMapPool,
              team_a: teamA,
              team_b: teamB
            })
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      eventLogger.error("loop_error", { error: String(error) });
      console.error("matchmaker loop error", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

Promise.all([runLoop(), runAntiCheatLoop(), runSmurfRiskLoop()]).catch((error) => {
  console.error(error);
  process.exit(1);
});

const healthPort = Number(process.env.MATCHMAKER_PORT ?? 3002);
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ok: true }));
  })
  .listen(healthPort, "0.0.0.0");
