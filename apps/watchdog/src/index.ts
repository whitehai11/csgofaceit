import dgram from "node:dgram";
import http from "node:http";
import Docker from "dockerode";
import Redis from "ioredis";
import { db } from "@csgofaceit/db";
import { createServiceLogger } from "@csgofaceit/logger";

type ManagedService = "api" | "discord-bot" | "matchmaker" | "server-manager";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
const logger = createServiceLogger("watchdog");

const apiBaseUrl = process.env.API_BASE_URL ?? "http://api:3001";
const serverManagerBaseUrl = process.env.SERVER_MANAGER_BASE_URL ?? "http://server-manager:3003";
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? "";
const serverManagerApiToken = process.env.SERVER_MANAGER_API_TOKEN ?? "";

const checkIntervalMs = Number(process.env.WATCHDOG_CHECK_INTERVAL_MS ?? 10000);
const serviceGraceMs = Number(process.env.WATCHDOG_SERVICE_UNHEALTHY_GRACE_MS ?? 30000);
const restartWindowMs = Number(process.env.WATCHDOG_RESTART_WINDOW_MS ?? 10 * 60 * 1000);
const maxRestartsPerWindow = Number(process.env.WATCHDOG_MAX_RESTARTS_PER_WINDOW ?? 5);
const backoffBaseMs = Number(process.env.WATCHDOG_BACKOFF_BASE_MS ?? 5000);
const backoffMaxMs = Number(process.env.WATCHDOG_BACKOFF_MAX_MS ?? 5 * 60 * 1000);
const udpTimeoutMs = Number(process.env.WATCHDOG_MATCH_UDP_TIMEOUT_MS ?? 2500);
const recoveryTimeoutMs = Number(process.env.WATCHDOG_MATCH_RECOVERY_TIMEOUT_MS ?? 3 * 60 * 1000);
const incidentCooldownMs = Number(process.env.WATCHDOG_INCIDENT_COOLDOWN_MS ?? 60000);
const watchdogPort = Number(process.env.WATCHDOG_PORT ?? 3005);

const serviceTargets: Array<{ service: ManagedService; container: string; healthUrl: string }> = [
  {
    service: "api",
    container: process.env.WATCHDOG_CONTAINER_API ?? "csgofaceit-api",
    healthUrl: process.env.API_HEALTH_URL ?? "http://api:3001/health"
  },
  {
    service: "discord-bot",
    container: process.env.WATCHDOG_CONTAINER_DISCORD_BOT ?? "csgofaceit-discord-bot",
    healthUrl: process.env.DISCORD_BOT_HEALTH_URL ?? "http://discord-bot:3004/health"
  },
  {
    service: "matchmaker",
    container: process.env.WATCHDOG_CONTAINER_MATCHMAKER ?? "csgofaceit-matchmaker",
    healthUrl: process.env.MATCHMAKER_HEALTH_URL ?? "http://matchmaker:3002/health"
  },
  {
    service: "server-manager",
    container: process.env.WATCHDOG_CONTAINER_SERVER_MANAGER ?? "csgofaceit-server-manager",
    healthUrl: process.env.SERVER_MANAGER_HEALTH_URL ?? "http://server-manager:3003/health"
  }
];

const unhealthySince = new Map<string, number>();
const restartHistory = new Map<string, number[]>();
const nextRestartAllowedAt = new Map<string, number>();
const backoffExponent = new Map<string, number>();
const recoveryTimers = new Map<string, NodeJS.Timeout>();
const matchRecoveryInProgress = new Set<string>();
const incidentLastAt = new Map<string, number>();

function nowIso(): string {
  return new Date().toISOString();
}

async function postInternal(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(internalApiToken ? { "x-internal-token": internalApiToken } : {})
      },
      body: JSON.stringify(body)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function getInternal<T>(path: string): Promise<T | null> {
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

async function postServerManager(path: string, body: unknown): Promise<any | null> {
  try {
    const response = await fetch(`${serverManagerBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(serverManagerApiToken ? { "x-server-manager-token": serverManagerApiToken } : {})
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function createIncident(service: string, type: string, details: Record<string, unknown>): Promise<void> {
  const key = `${service}:${type}:${String(details.match_id ?? "global")}`;
  const now = Date.now();
  const lastAt = incidentLastAt.get(key) ?? 0;
  if (now - lastAt < incidentCooldownMs) {
    return;
  }
  incidentLastAt.set(key, now);

  try {
    await db.query(
      `INSERT INTO watchdog_incidents (service, type, details_json, created_at)
       VALUES ($1, $2, $3::jsonb, NOW())`,
      [service, type, JSON.stringify(details)]
    );
  } catch (error) {
    logger.error("watchdog_incident_insert_failed", { service, type, error: String(error) });
  }

  await redis.publish(
    "moderation-events",
    JSON.stringify({
      type: "moderation_log",
      action:
        type === "service_unhealthy"
          ? "watchdog_alert"
          : type === "restart_attempt"
            ? "watchdog_restart_attempt"
            : "watchdog_recovery_failed",
      reason: `service=${service}; reason=${String(details.reason ?? "n/a")}; restart_count=${String(details.restart_count ?? 0)}; ts=${String(details.timestamp ?? nowIso())}`,
      match_id: details.match_id ?? null,
      timestamp: nowIso(),
      metadata: { service, ...details }
    })
  );
}

async function checkHttpHealth(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const response = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!response.ok) return { ok: false, reason: `status=${response.status}` };
    const body = (await response.json().catch(() => ({}))) as any;
    if (body && (body.status === "ok" || body.ok === true)) return { ok: true };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `http error: ${String(error)}` };
  }
}

async function canRestart(service: string, at: number): Promise<{ allowed: boolean; count: number; reason?: string }> {
  const history = restartHistory.get(service) ?? [];
  const filtered = history.filter((t) => at - t <= restartWindowMs);
  restartHistory.set(service, filtered);
  const nextAllowed = nextRestartAllowedAt.get(service) ?? 0;
  if (at < nextAllowed) {
    return { allowed: false, count: filtered.length, reason: "backoff_active" };
  }
  if (filtered.length >= maxRestartsPerWindow) {
    return { allowed: false, count: filtered.length, reason: "restart_limit_exceeded" };
  }
  return { allowed: true, count: filtered.length };
}

async function restartContainer(containerName: string): Promise<boolean> {
  try {
    const container = docker.getContainer(containerName);
    await container.restart({ t: 10 });
    return true;
  } catch {
    return false;
  }
}

function recordRestart(service: string, at: number): number {
  const history = restartHistory.get(service) ?? [];
  history.push(at);
  const filtered = history.filter((t) => at - t <= restartWindowMs);
  restartHistory.set(service, filtered);

  const exp = (backoffExponent.get(service) ?? 0) + 1;
  backoffExponent.set(service, exp);
  const delay = Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.max(0, exp - 1)));
  nextRestartAllowedAt.set(service, at + delay);
  return filtered.length;
}

function clearServiceFailureState(service: string): void {
  unhealthySince.delete(service);
  backoffExponent.set(service, 0);
  nextRestartAllowedAt.delete(service);
}

async function monitorManagedServices(): Promise<void> {
  const now = Date.now();
  for (const target of serviceTargets) {
    const health = await checkHttpHealth(target.healthUrl);
    if (health.ok) {
      clearServiceFailureState(target.service);
      continue;
    }

    const since = unhealthySince.get(target.service) ?? now;
    unhealthySince.set(target.service, since);
    if (now - since < serviceGraceMs) continue;

    await createIncident(target.service, "service_unhealthy", {
      reason: health.reason ?? "healthcheck_failed",
      timestamp: nowIso()
    });

    const restartAllowance = await canRestart(target.service, now);
    if (!restartAllowance.allowed) {
      await createIncident(target.service, "recovery_failed", {
        reason: restartAllowance.reason ?? "restart_not_allowed",
        restart_count: restartAllowance.count,
        timestamp: nowIso()
      });
      continue;
    }

    const restartOk = await restartContainer(target.container);
    const count = recordRestart(target.service, now);
    await createIncident(target.service, "restart_attempt", {
      reason: restartOk ? "docker_restart_triggered" : "docker_restart_failed",
      restart_count: count,
      timestamp: nowIso()
    });
    if (!restartOk) {
      await createIncident(target.service, "recovery_failed", {
        reason: "container_restart_failed",
        restart_count: count,
        timestamp: nowIso()
      });
    }
  }
}

async function monitorDataStores(): Promise<void> {
  try {
    await db.query("SELECT 1");
  } catch (error) {
    await createIncident("postgres", "service_unhealthy", {
      reason: `db_connectivity_failed: ${String(error)}`,
      timestamp: nowIso()
    });
  }

  try {
    await redis.ping();
  } catch (error) {
    await createIncident("redis", "service_unhealthy", {
      reason: `redis_connectivity_failed: ${String(error)}`,
      timestamp: nowIso()
    });
  }
}

async function pingSourceServer(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  if (!ip || !Number.isFinite(port) || port <= 0) return false;
  return new Promise<boolean>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        resolve(false);
      }
    }, timeoutMs);

    socket.once("message", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve(true);
    });
    socket.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve(false);
    });

    const payload = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from("Source Engine Query\0")]);
    socket.send(payload, port, ip, (error) => {
      if (error && !settled) {
        settled = true;
        clearTimeout(timeout);
        socket.close();
        resolve(false);
      }
    });
  });
}

function scheduleRecoveryTimeout(matchId: string): void {
  if (recoveryTimers.has(matchId)) return;
  const timer = setTimeout(async () => {
    recoveryTimers.delete(matchId);
    const state = await getInternal<{ status?: string }>(`/internal/matches/${matchId}/recovery`);
    const status = String(state?.status ?? "");
    if (!status || !["live", "finished", "canceled"].includes(status)) {
      await postInternal(`/internal/matches/${matchId}/cancel-recovery`, {
        reason: "Watchdog recovery timeout exceeded"
      });
      await createIncident("match-server", "recovery_failed", {
        match_id: matchId,
        reason: "recovery_timeout_exceeded",
        timestamp: nowIso()
      });
    }
  }, recoveryTimeoutMs);
  timer.unref();
  recoveryTimers.set(matchId, timer);
}

async function recoverMatchContainer(container: Docker.ContainerInfo): Promise<void> {
  const labels = container.Labels ?? {};
  const matchId = String(labels["csgofaceit.match_id"] ?? "");
  const map = String(labels["csgofaceit.map"] ?? "de_mirage");
  const mode = String(labels["csgofaceit.mode"] ?? "ranked");
  const serverPassword = String(labels["csgofaceit.server_password"] ?? "");
  const spectatorPassword = String(labels["csgofaceit.spectator_password"] ?? "");
  const serverId = String(container.Id);

  if (!matchId || matchRecoveryInProgress.has(matchId)) return;
  matchRecoveryInProgress.add(matchId);

  try {
    await createIncident("match-server", "service_unhealthy", {
      match_id: matchId,
      server_id: serverId,
      reason: "running_container_unresponsive",
      timestamp: nowIso()
    });

    await postInternal("/internal/server-crashes", {
      server_id: `match-${matchId}`,
      match_id: matchId,
      map,
      reason: "Watchdog detected unresponsive match server",
      status: "recovering"
    });
    await postInternal(`/internal/matches/${matchId}/interrupted`, {
      reason: "Watchdog detected unresponsive match server"
    });

    try {
      const c = docker.getContainer(serverId);
      await c.remove({ force: true });
    } catch {
      // best effort
    }

    const started = await postServerManager("/server/start", {
      match_id: matchId,
      map,
      mode,
      server_password: serverPassword || undefined,
      spectator_password: spectatorPassword || undefined
    });

    if (!started) {
      await createIncident("match-server", "recovery_failed", {
        match_id: matchId,
        server_id: serverId,
        reason: "replacement_server_start_failed",
        timestamp: nowIso()
      });
      scheduleRecoveryTimeout(matchId);
      return;
    }

    const server = {
      serverId: String(started.server_id ?? started.serverId ?? ""),
      ip: String(started.server_ip ?? started.ip ?? ""),
      port: Number(started.port ?? 0),
      serverPassword: String(started.password ?? started.server_password ?? ""),
      spectatorPassword: String(started.spectator_password ?? ""),
      connectString: String(started.connect_string ?? started.connectString ?? "")
    };

    const activated = await postInternal("/internal/matches/activate", {
      match_id: matchId,
      map,
      server
    });
    await createIncident("match-server", "restart_attempt", {
      match_id: matchId,
      server_id: server.serverId,
      reason: activated ? "replacement_server_activated" : "match_activate_failed",
      timestamp: nowIso()
    });
    scheduleRecoveryTimeout(matchId);
  } finally {
    matchRecoveryInProgress.delete(matchId);
  }
}

async function monitorMatchServers(): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: { label: ["csgofaceit.managed=true"] } });
  for (const container of containers) {
    if (String(container.State) !== "running") {
      const labels = container.Labels ?? {};
      const matchId = String(labels["csgofaceit.match_id"] ?? "");
      if (matchId) {
        await recoverMatchContainer(container);
      }
      continue;
    }

    const labels = container.Labels ?? {};
    const matchId = String(labels["csgofaceit.match_id"] ?? "");
    if (!matchId) continue;
    const ip = String(labels["csgofaceit.server_ip"] ?? "");
    const port = Number(labels["csgofaceit.server_port"] ?? 0);
    const healthy = await pingSourceServer(ip, port, udpTimeoutMs);
    if (!healthy) {
      await recoverMatchContainer(container);
    }
  }
}

async function runLoop(): Promise<void> {
  logger.info("watchdog_start", {
    check_interval_ms: checkIntervalMs,
    service_grace_ms: serviceGraceMs,
    restart_window_ms: restartWindowMs,
    max_restarts_per_window: maxRestartsPerWindow
  });
  while (true) {
    const loopStarted = Date.now();
    try {
      await monitorManagedServices();
      await monitorDataStores();
      await monitorMatchServers();
    } catch (error) {
      logger.error("watchdog_loop_error", { error: String(error) });
    }
    const elapsed = Date.now() - loopStarted;
    const sleepMs = Math.max(1000, checkIntervalMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ok: true }));
  })
  .listen(watchdogPort, "0.0.0.0");

runLoop().catch((error) => {
  logger.error("watchdog_fatal", { error: String(error) });
  process.exit(1);
});
