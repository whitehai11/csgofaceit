import crypto from "node:crypto";
import os from "node:os";
import Docker from "dockerode";
import Redis from "ioredis";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { createServiceLogger } from "@csgofaceit/logger";
import { isAllowedMap, isAllowedMode, isAuthorizedControlPlaneRequest, isIpAllowed } from "./security";

const app = Fastify({
  logger: true,
  bodyLimit: Number(process.env.SERVER_MANAGER_BODY_LIMIT_BYTES ?? 262144)
});
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const eventLogger = createServiceLogger("server-manager");

const image = process.env.CSGO_IMAGE ?? "cm2network/csgo";
const startPort = Number(process.env.CSGO_START_PORT ?? 27015);
const rconPassword = process.env.CSGO_RCON_PASSWORD ?? "changeme-rcon";
const serverBanner = process.env.CSGO_SERVER_BANNER ?? "Playing ranked on play.maro.run";
const superpowerDefaultEnabled = (process.env.CSGO_SUPERPOWER_DEFAULT_ENABLED ?? "false").toLowerCase() === "true";
const serverManagerApiToken = process.env.SERVER_MANAGER_API_TOKEN ?? "";
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? "";
const internalWebhookSecret = process.env.INTERNAL_WEBHOOK_SECRET ?? "";
const apiBaseUrl = process.env.API_BASE_URL ?? "http://api:3001";
const healthCheckIntervalMs = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 10000);
const unhealthyThresholdMs = Number(process.env.HEALTH_UNHEALTHY_THRESHOLD_MS ?? 30000);
const scalerIntervalMs = Number(process.env.SCALER_INTERVAL_MS ?? 10000);
const scalerThresholdLow = Number(process.env.SCALER_QUEUE_THRESHOLD_LOW ?? 20);
const scalerThresholdHigh = Number(process.env.SCALER_QUEUE_THRESHOLD_HIGH ?? 40);
const scalerSpawnLow = Number(process.env.SCALER_SPAWN_LOW ?? 2);
const scalerSpawnHigh = Number(process.env.SCALER_SPAWN_HIGH ?? 4);
const minIdleServers = Number(process.env.SCALER_MIN_IDLE_SERVERS ?? 2);
const idleServerTtlMs = Number(process.env.IDLE_SERVER_TTL_MS ?? 10 * 60 * 1000);
const allowedMaps = new Set(
  (process.env.CSGO_ALLOWED_MAPS ?? "de_mirage,de_inferno,de_dust2,de_overpass,de_ancient,de_nuke,de_vertigo")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);
type GameMode = "ranked" | "wingman" | "casual" | "superpower" | "gungame" | "zombie" | "clanwars";
const allowedModes = new Set<GameMode>(["ranked", "wingman", "casual", "superpower", "gungame", "zombie", "clanwars"]);
const managerAllowedIps = (process.env.SERVER_MANAGER_ALLOWED_IPS ?? process.env.TRUSTED_NETWORKS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const metrics = {
  blocked_requests: 0,
  rate_limit_hits: 0,
  service_unhealthy_count: 0,
  game_server_crash_count: 0,
  active_servers: 0,
  active_matches: 0,
  queue_size: 0
};

let currentPort = startPort;
const serviceUnhealthySince = new Map<string, number>();
const serviceAlertCooldownUntil = new Map<string, number>();
const gameUnhealthySince = new Map<string, number>();
const gameAlertCooldownUntil = new Map<string, number>();
let lastScalingStatusPostAt = 0;
let lastScalingSignature = "";
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const recoveryCancelTimers = new Map<string, NodeJS.Timeout>();

function assertStrongRuntimeSecret(name: string, value: string): void {
  const lowered = value.toLowerCase();
  const placeholder =
    !value ||
    value.length < 32 ||
    lowered.includes("change-me") ||
    lowered.includes("changeme") ||
    lowered.includes("replace") ||
    lowered === "placeholder" ||
    lowered === "example";
  if (placeholder) {
    eventLogger.error("startup_secret_invalid", { secret_name: name, reason: "missing_or_weak" });
    throw new Error(`${name} must be set to a strong value (>=32 chars, non-placeholder)`);
  }
}

assertStrongRuntimeSecret("SERVER_MANAGER_API_TOKEN", serverManagerApiToken);
assertStrongRuntimeSecret("INTERNAL_API_TOKEN", internalApiToken);
assertStrongRuntimeSecret("INTERNAL_WEBHOOK_SECRET", internalWebhookSecret);

function allocatePort(): number {
  const port = currentPort;
  currentPort += 1;
  return port;
}

function randomPassword(prefix: string): string {
  return `${prefix}${crypto.randomBytes(3).toString("hex")}`;
}

function validateManagerToken(request: any, reply: any): boolean {
  const token = String(request.headers["x-server-manager-token"] ?? request.headers["x-internal-token"] ?? "");
  if (!isAuthorizedControlPlaneRequest(token, serverManagerApiToken)) {
    metrics.blocked_requests += 1;
    void reply.code(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function hostIp(): string {
  const envIp = process.env.SERVER_PUBLIC_IP;
  if (envIp) return envIp;

  const interfaces = os.networkInterfaces();
  for (const ni of Object.values(interfaces)) {
    if (!ni) continue;
    const found = ni.find((x) => x.family === "IPv4" && !x.internal);
    if (found?.address) return found.address;
  }

  return "127.0.0.1";
}

function buildMatchConfig(map: string, serverPassword: string, spectatorPassword: string): string {
  return [
    `hostname "${serverBanner}"`,
    `map ${map}`,
    `sv_password ${serverPassword}`,
    `tv_password ${spectatorPassword}`,
    "tv_enable 1",
    "tv_autorecord 1"
  ].join("\n");
}

function buildLaunchArgs(
  map: string,
  serverPassword: string,
  spectatorPassword: string,
  mode: GameMode,
  matchId: string | undefined,
  introModeLabel: string
): string[] {
  const superpowerMode = mode === "superpower";
  const gunGameMode = mode === "gungame";
  const zombieMode = mode === "zombie";
  const whitelistApiBase = apiBaseUrl.replace(/\/+$/, "");
  return [
    "+hostname",
    superpowerMode ? `${serverBanner} | Superpower Mode (Unranked)` : serverBanner,
    "+map",
    map,
    "+sv_password",
    serverPassword,
    "+tv_password",
    spectatorPassword,
    "+tv_enable",
    "1",
    "+tv_autorecord",
    "1",
    "+sm_superpower_enabled",
    superpowerMode ? "1" : "0",
    "+sm_gungame_enabled",
    gunGameMode ? "1" : "0",
    "+sm_zombie_enabled",
    zombieMode ? "1" : "0",
    "+sm_fraghub_match_intro_mode",
    introModeLabel,
    "+sm_fraghub_comp_match_id",
    matchId ?? "unknown",
    "+sm_fraghub_whitelist_match_id",
    matchId ?? "unknown",
    "+sm_fraghub_whitelist_api_base",
    whitelistApiBase,
    "+sm_fraghub_whitelist_api_token",
    internalApiToken
  ];
}

async function listManagedServers() {
  const containers = await docker.listContainers({ all: true, filters: { label: ["csgofaceit.managed=true"] } });
  return containers.map((c) => {
    const labels = c.Labels ?? {};
    const ip = labels["csgofaceit.server_ip"] ?? "";
    const port = Number(labels["csgofaceit.server_port"] ?? "0");
    const serverPassword = labels["csgofaceit.server_password"] ?? "";
    const spectatorPassword = labels["csgofaceit.spectator_password"] ?? "";

    return {
      server_id: c.Id,
      container_name: c.Names?.[0] ?? null,
      state: c.State,
      status: c.Status,
      map: labels["csgofaceit.map"] ?? null,
      mode: labels["csgofaceit.mode"] ?? "ranked",
      unranked: labels["csgofaceit.unranked"] === "true",
      server_ip: ip,
      port,
      connect_string: ip && port ? `connect ${ip}:${port}; password ${serverPassword}` : null,
      spectator_connect_string: ip && port ? `connect ${ip}:${port}; password ${spectatorPassword}` : null
    };
  });
}

app.get("/health", async () => ({ status: "ok", ok: true }));

async function postInternal(path: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(internalApiToken ? { "x-internal-token": internalApiToken } : {})
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    eventLogger.error("internal_post_failed", { path, error: String((error as any)?.message ?? error) });
  }
}

async function getInternal<T = any>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        ...(internalApiToken ? { "x-internal-token": internalApiToken } : {})
      }
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const startBodySchema = z.object({
  match_id: z.string().optional(),
  map: z.string().default("de_mirage"),
  server_password: z.string().min(3).max(64).optional(),
  spectator_password: z.string().min(3).max(64).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  mode: z.enum(["ranked", "wingman", "casual", "superpower", "gungame", "zombie", "clanwars"]).default(superpowerDefaultEnabled ? "superpower" : "ranked"),
  pool: z.boolean().optional()
});

async function startServer(request: any, reply: any) {
  if (!validateManagerToken(request, reply)) return;
  const body = startBodySchema.parse(request.body ?? {});
  if (!isAllowedMode(body.mode, allowedModes)) {
    return reply.code(400).send({ error: "Unsupported mode" });
  }
  if (!isAllowedMap(body.map, allowedMaps)) {
    return reply.code(400).send({ error: "Unsupported map" });
  }

  const gamePort = body.port ?? allocatePort();
  const tvPort = gamePort + 5;
  const serverPassword = body.server_password ?? randomPassword("match");
  const spectatorPassword = body.spectator_password ?? randomPassword("spec");
  const mode = body.mode as GameMode;
  const pool = Boolean(body.pool);
  const unranked = mode === "casual" || mode === "superpower" || mode === "gungame" || mode === "zombie";

  const name = pool ? `csgo-pool-${Date.now()}-${crypto.randomBytes(2).toString("hex")}` : `csgo-match-${body.match_id ?? Date.now()}`;
  const ip = hostIp();
  const connectString = `connect ${ip}:${gamePort}; password ${serverPassword}`;
  const spectatorConnectString = `connect ${ip}:${gamePort}; password ${spectatorPassword}`;
  const matchConfig = buildMatchConfig(body.map, serverPassword, spectatorPassword);
  let introModeLabel =
    mode === "clanwars"
      ? "Clan War Match"
      : mode === "wingman"
      ? "Wingman 2v2"
      : mode === "ranked"
      ? "Ranked 5v5"
      : mode;
  if (mode === "clanwars" && body.match_id) {
    const clans = await getInternal<{ clan_a_tag?: string; clan_b_tag?: string }>(`/internal/clan/match/${body.match_id}/teams`);
    if (clans?.clan_a_tag && clans?.clan_b_tag) {
      introModeLabel = `Clan War Match [${clans.clan_a_tag}] vs [${clans.clan_b_tag}]`;
    }
  }

  try {
    const container = await docker.createContainer({
      Image: image,
      name,
      Env: [
        "SRCDS_TOKEN=",
        "SRCDS_MAXPLAYERS=10",
        "SRCDS_GAME=csgo",
        "SRCDS_GAMETYPE=0",
        "SRCDS_GAMEMODE=1",
        "SRCDS_MAPGROUP=mg_active",
        `SRCDS_STARTMAP=${body.map}`,
        `RCON_PASSWORD=${rconPassword}`,
        `SRCDS_HOSTNAME=${unranked ? `${serverBanner} | ${mode.toUpperCase()} (Unranked)` : `${serverBanner} | ${mode.toUpperCase()}`}`,
        `SERVER_PASSWORD=${serverPassword}`,
        `TV_PASSWORD=${spectatorPassword}`,
        `CSGO_MATCH_MODE=${mode}`,
        // Generated per-match config metadata for observability.
        `CSGO_MATCH_CONFIG=${Buffer.from(matchConfig).toString("base64")}`
      ],
      Cmd: buildLaunchArgs(body.map, serverPassword, spectatorPassword, mode, body.match_id, introModeLabel),
      ExposedPorts: {
        "27015/udp": {},
        "27020/udp": {}
      },
      Labels: {
        "csgofaceit.managed": "true",
        "csgofaceit.match_id": body.match_id ?? "",
        "csgofaceit.map": body.map,
        "csgofaceit.server_ip": ip,
        "csgofaceit.server_port": String(gamePort),
        "csgofaceit.server_password": serverPassword,
        "csgofaceit.spectator_password": spectatorPassword,
        "csgofaceit.mode": mode,
        "csgofaceit.unranked": unranked ? "true" : "false",
        "csgofaceit.pool": pool ? "true" : "false",
        "csgofaceit.created_at": new Date().toISOString()
      },
      HostConfig: {
        PortBindings: {
          "27015/udp": [{ HostPort: String(gamePort) }],
          "27020/udp": [{ HostPort: String(tvPort) }]
        },
        AutoRemove: false,
        RestartPolicy: {
          Name: "always"
        },
        Memory: Number(process.env.CSGO_CONTAINER_MEMORY_BYTES ?? 2147483648),
        NanoCpus: Number(process.env.CSGO_CONTAINER_NANO_CPUS ?? 2000000000),
        PidsLimit: Number(process.env.CSGO_CONTAINER_PIDS_LIMIT ?? 512),
        SecurityOpt: ["no-new-privileges:true"],
        NetworkMode: process.env.CSGO_DOCKER_NETWORK ?? "bridge"
      }
    });

    await container.start();
    eventLogger.info("server_spawning", {
      status: "started",
      server_id: container.id,
      match_id: body.match_id ?? null,
      map: body.map,
      mode,
      unranked,
      pool,
      server_ip: ip,
      port: gamePort
    });

    return reply.send({
      server_id: container.id,
      serverId: container.id,
      match_id: body.match_id ?? null,
      map: body.map,
      server_ip: ip,
      ip,
      port: gamePort,
      mode,
      unranked,
      pool,
      password: serverPassword,
      server_password: serverPassword,
      spectator_password: spectatorPassword,
      connect_string: connectString,
      spectator_connect_string: spectatorConnectString,
      connectString,
      spectatorConnectString,
      match_config: matchConfig
    });
  } catch (error: any) {
    eventLogger.error("server_spawning", {
      status: "failed",
      match_id: body.match_id ?? null,
      map: body.map,
      mode,
      port: gamePort,
      error: String(error?.message ?? error)
    });
    request.log.error(error);
    return reply.code(500).send({ error: "Failed to start server" });
  }
}

const stopBodySchema = z.object({
  server_id: z.string().min(8)
});

async function stopServer(request: any, reply: any) {
  if (!validateManagerToken(request, reply)) return;
  const body = stopBodySchema.parse(request.body ?? {});

  try {
    const container = docker.getContainer(body.server_id);
    await container.stop({ t: 5 });
    await container.remove({ force: true });
    eventLogger.info("server_stop", { server_id: body.server_id, status: "stopped" });
    return reply.send({ ok: true, server_id: body.server_id });
  } catch (error: any) {
    eventLogger.error("server_stop", { server_id: body.server_id, error: String(error?.message ?? error) });
    request.log.error(error);
    return reply.code(500).send({ error: "Failed to stop server" });
  }
}

async function emitServiceUnhealthy(service: string, reason: string): Promise<void> {
  metrics.service_unhealthy_count += 1;
  await postInternal("/internal/server-crashes", {
    server_id: service,
    reason,
    status: "restarting"
  });
}

async function queueSizeTotal(): Promise<number> {
  const keys = [
    "queue:ranked:order",
    "queue:ranked:smurf:order",
    "queue:wingman:order",
    "queue:wingman:smurf:order",
    "queue:casual:order",
    "queue:casual:smurf:order",
    "queue:superpower:order",
    "queue:superpower:smurf:order",
    "queue:gungame:order",
    "queue:gungame:smurf:order",
    "queue:zombie:order",
    "queue:zombie:smurf:order"
  ];
  const counts = await Promise.all(keys.map((k) => redis.zcard(k).catch(() => 0)));
  return counts.reduce((sum, value) => sum + Number(value ?? 0), 0);
}

async function activeMatchServerIds(): Promise<Set<string>> {
  try {
    const response = await fetch(`${apiBaseUrl}/matches/live`);
    if (!response.ok) return new Set();
    const rows = (await response.json()) as any[];
    const ids = rows
      .map((m) => String(m.server_id ?? ""))
      .filter(Boolean);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

async function startPoolServer(): Promise<void> {
  const req: any = {
    headers: { "x-server-manager-token": serverManagerApiToken || "" },
    body: { map: "de_mirage", mode: "casual", pool: true }
  };
  const replyCapture: any = {
    statusCode: 200,
    payload: null,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    send(v: any) {
      this.payload = v;
      return v;
    }
  };
  await startServer(req, replyCapture);
}

async function stopContainerById(serverId: string): Promise<void> {
  try {
    const container = docker.getContainer(serverId);
    await container.stop({ t: 5 }).catch(() => null);
    await container.remove({ force: true });
  } catch {
    // best effort
  }
}

async function runAutoScaler(now: number): Promise<void> {
  const queueSize = await queueSizeTotal();
  const activeServers = await listManagedServers();
  const activeMatchIds = await activeMatchServerIds();
  const runningServers = activeServers.filter((s) => s.state === "running");
  metrics.active_servers = runningServers.length;
  metrics.active_matches = activeMatchIds.size;
  metrics.queue_size = queueSize;

  const extra = queueSize > scalerThresholdHigh ? scalerSpawnHigh : queueSize > scalerThresholdLow ? scalerSpawnLow : 0;
  const desiredIdlePool = Math.max(minIdleServers, extra);

  const raw = await docker.listContainers({ all: true, filters: { label: ["csgofaceit.managed=true"] } });
  const poolRunning = raw.filter((c) => c.State === "running" && (c.Labels?.["csgofaceit.pool"] === "true"));

  if (poolRunning.length < desiredIdlePool) {
    const missing = desiredIdlePool - poolRunning.length;
    for (let i = 0; i < missing; i += 1) {
      await startPoolServer();
    }
  }

  const stale = raw
    .filter((c) => c.State === "running")
    .map((c) => {
      const labels = c.Labels ?? {};
      const serverId = String(c.Id);
      const matchId = String(labels["csgofaceit.match_id"] ?? "");
      const isPool = labels["csgofaceit.pool"] === "true";
      const createdSec = Number(c.Created ?? 0);
      const ageMs = createdSec > 0 ? now - createdSec * 1000 : 0;
      const active = matchId ? activeMatchIds.has(serverId) : false;
      return { serverId, isPool, ageMs, active };
    })
    .filter((x) => !x.active && x.ageMs >= idleServerTtlMs)
    .sort((a, b) => b.ageMs - a.ageMs);

  let poolKept = raw.filter((c) => c.State === "running" && (c.Labels?.["csgofaceit.pool"] === "true")).length;
  for (const idle of stale) {
    if (idle.isPool && poolKept <= minIdleServers) continue;
    await stopContainerById(idle.serverId);
    if (idle.isPool) poolKept -= 1;
  }

  const signature = `${metrics.active_servers}:${metrics.active_matches}:${metrics.queue_size}`;
  if (signature !== lastScalingSignature || now - lastScalingStatusPostAt >= 60000) {
    lastScalingSignature = signature;
    lastScalingStatusPostAt = now;
    await redis.publish(
      "security-events",
      JSON.stringify({
        type: "server_scaling_status",
        active_servers: metrics.active_servers,
        active_matches: metrics.active_matches,
        queue_size: metrics.queue_size
      })
    );
  }
}

async function restoreAndReactivateMatch(matchId: string, server: {
  serverId: string;
  ip: string;
  port: number;
  serverPassword: string;
  spectatorPassword: string;
  connectString: string;
}, fallbackMap: string): Promise<void> {
  const recovery = await getInternal<any>(`/internal/matches/${matchId}/recovery`);
  const selectedMap = String(recovery?.map ?? fallbackMap ?? "de_mirage");
  await postInternal("/internal/matches/activate", {
    match_id: matchId,
    map: selectedMap,
    server
  });
}

function scheduleRecoveryCancel(matchId: string): void {
  if (recoveryCancelTimers.has(matchId)) return;
  const timer = setTimeout(async () => {
    recoveryCancelTimers.delete(matchId);
    const recovery = await getInternal<any>(`/internal/matches/${matchId}/recovery`);
    const status = String(recovery?.status ?? "");
    if (status && status !== "live" && status !== "finished" && status !== "canceled") {
      await postInternal(`/internal/matches/${matchId}/cancel-recovery`, {
        reason: "Recovery timeout exceeded (3 minutes)"
      });
    }
  }, 3 * 60 * 1000);
  timer.unref();
  recoveryCancelTimers.set(matchId, timer);
}

function clearRecoveryCancel(matchId: string): void {
  const timer = recoveryCancelTimers.get(matchId);
  if (!timer) return;
  clearTimeout(timer);
  recoveryCancelTimers.delete(matchId);
}

async function monitorServicesAndGames(): Promise<void> {
  const targets: Array<{ name: string; url: string }> = [
    { name: "api", url: process.env.API_HEALTH_URL ?? "http://api:3001/health" },
    { name: "discord-bot", url: process.env.DISCORD_BOT_HEALTH_URL ?? "http://discord-bot:3004/health" },
    { name: "matchmaker", url: process.env.MATCHMAKER_HEALTH_URL ?? "http://matchmaker:3002/health" },
    { name: "server-manager", url: process.env.SERVER_MANAGER_HEALTH_URL ?? "http://server-manager:3003/health" }
  ];

  while (true) {
    const now = Date.now();
    for (const target of targets) {
      let healthy = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const response = await fetch(target.url, { signal: ctrl.signal });
        clearTimeout(timer);
        healthy = response.ok;
      } catch {
        healthy = false;
      }
      if (healthy) {
        serviceUnhealthySince.delete(target.name);
      } else {
        const since = serviceUnhealthySince.get(target.name) ?? now;
        serviceUnhealthySince.set(target.name, since);
        const cooldown = serviceAlertCooldownUntil.get(target.name) ?? 0;
        if (now - since >= unhealthyThresholdMs && now >= cooldown) {
          serviceAlertCooldownUntil.set(target.name, now + unhealthyThresholdMs);
          await emitServiceUnhealthy(target.name, `Health endpoint failed for > ${Math.floor(unhealthyThresholdMs / 1000)}s`);
        }
      }
    }

    try {
      const containers = await docker.listContainers({ all: true, filters: { label: ["csgofaceit.managed=true"] } });
      for (const c of containers) {
        const serverId = c.Id;
        const labels = c.Labels ?? {};
        const state = String(c.State ?? "");
        const matchId = String(labels["csgofaceit.match_id"] ?? "");
        if (state === "running") {
          gameUnhealthySince.delete(serverId);
          continue;
        }
        const since = gameUnhealthySince.get(serverId) ?? now;
        gameUnhealthySince.set(serverId, since);
        const cooldown = gameAlertCooldownUntil.get(serverId) ?? 0;
        if (now - since < unhealthyThresholdMs || now < cooldown) continue;

        gameAlertCooldownUntil.set(serverId, now + unhealthyThresholdMs);
        metrics.game_server_crash_count += 1;
        const map = String(labels["csgofaceit.map"] ?? "de_mirage");
        const mode = String(labels["csgofaceit.mode"] ?? "ranked") as GameMode;
        const port = Number(labels["csgofaceit.server_port"] ?? "0") || allocatePort();
        const serverPassword = String(labels["csgofaceit.server_password"] ?? randomPassword("match"));
        const spectatorPassword = String(labels["csgofaceit.spectator_password"] ?? randomPassword("spec"));
        const ip = String(labels["csgofaceit.server_ip"] ?? hostIp());
        const connectString = `connect ${ip}:${port}; password ${serverPassword}`;

        await postInternal("/internal/server-crashes", {
          server_id: `match-${matchId || serverId.slice(0, 12)}`,
          match_id: matchId || undefined,
          map,
          reason: `Container state=${state}`,
          status: "restarting"
        });
        if (matchId) {
          await postInternal(`/internal/matches/${matchId}/interrupted`, {
            reason: `Server crash detected (state=${state})`
          });
          scheduleRecoveryCancel(matchId);
        }

        try {
          const container = docker.getContainer(serverId);
          await container.remove({ force: true });
        } catch {
          // ignore if already removed
        }

        try {
          const restartReq = {
            headers: { "x-server-manager-token": serverManagerApiToken },
            body: {
              match_id: matchId || undefined,
              map,
              mode,
              server_password: serverPassword,
              spectator_password: spectatorPassword,
              port
            }
          };
          const fakeReply: any = {
            code: (_c: number) => fakeReply,
            send: (v: any) => v
          };
          const started: any = await startServer(restartReq, fakeReply);
          if (matchId && started?.server_id) {
            await restoreAndReactivateMatch(matchId, {
              serverId: String(started.server_id),
              ip: String(started.server_ip ?? ip),
              port: Number(started.port ?? port),
              serverPassword,
              spectatorPassword,
              connectString: String(started.connect_string ?? connectString)
            }, map);
            clearRecoveryCancel(matchId);
          }
        } catch (error) {
          eventLogger.error("game_server_restart_failed", {
            server_id: serverId,
            match_id: matchId || null,
            map,
            error: String((error as any)?.message ?? error)
          });
        }
      }
    } catch (error) {
      eventLogger.error("game_server_monitor_failed", { error: String((error as any)?.message ?? error) });
    }

    if (scalerIntervalMs > 0) {
      try {
        await runAutoScaler(now);
      } catch (error) {
        eventLogger.error("scaler_failed", { error: String((error as any)?.message ?? error) });
      }
    }

    const sleepMs = scalerIntervalMs > 0 ? Math.min(healthCheckIntervalMs, scalerIntervalMs) : healthCheckIntervalMs;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, sleepMs)));
  }
}

app.register(helmet, {
  global: true,
  contentSecurityPolicy: false
});
app.register(rateLimit, {
  max: Number(process.env.SERVER_MANAGER_RATE_LIMIT_MAX ?? 120),
  timeWindow: process.env.SERVER_MANAGER_RATE_LIMIT_WINDOW ?? "1 minute",
  allowList: ["127.0.0.1"],
  onExceeding: (request) => {
    metrics.rate_limit_hits += 1;
    eventLogger.info("request_rate_limit_exceeded", { route: request.routeOptions.url, ip: request.ip });
  }
});
app.addHook("preHandler", async (request, reply) => {
  const routePath = request.routeOptions.url ?? "";
  if (routePath === "/health") return;
  if (!isIpAllowed(request.ip, managerAllowedIps)) {
    metrics.blocked_requests += 1;
    await reply.code(403).send({ error: "Forbidden network" });
    return;
  }
});
app.setErrorHandler(async (error, request, reply) => {
  const statusCode = typeof (error as any).statusCode === "number" ? Number((error as any).statusCode) : 500;
  request.log.error({ err: error, route: request.routeOptions.url }, "request_failed");
  if (statusCode >= 500) {
    return reply.code(500).send({ error: "Internal server error" });
  }
  return reply.code(statusCode).send({ error: (error as any).message ?? "Request failed" });
});

app.post("/server/start", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, startServer);
app.post("/server/stop", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, stopServer);
app.get("/servers", {
  config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
}, async (request, reply) => {
  if (!validateManagerToken(request, reply)) return;
  return listManagedServers();
});
app.get("/internal/metrics", async (request, reply) => {
  if (!validateManagerToken(request, reply)) return;
  return { ok: true, metrics, timestamp: new Date().toISOString() };
});

// Compatibility aliases for existing internal callers.
app.post("/servers/start", startServer);
app.post("/servers/stop/:containerId", async (request, reply) => {
  const params = z.object({ containerId: z.string() }).parse(request.params);
  return stopServer({ ...request, body: { server_id: params.containerId } }, reply);
});

const port = Number(process.env.SERVER_MANAGER_PORT ?? 3003);
app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

monitorServicesAndGames().catch((error) => {
  app.log.error(error);
});
