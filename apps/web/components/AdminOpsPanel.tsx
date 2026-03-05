"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type ServerRow = {
  server_id?: string;
  id?: string;
  map?: string;
  mode?: string;
  server_ip?: string;
  port?: number;
  players?: number;
  max_players?: number;
  status?: string;
};

type ReportsPayload = {
  reports: unknown[];
  bans: unknown[];
};

export function AdminOpsPanel() {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [queue, setQueue] = useState<Record<string, number>>({});
  const [reports, setReports] = useState<ReportsPayload>({ reports: [], bans: [] });
  const [error, setError] = useState("");

  async function loadServers() {
    const response = await fetch(`${API_BASE_URL}/admin/servers`, { credentials: "include", cache: "no-store" });
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; servers?: ServerRow[]; error?: string };
    if (!response.ok || !data.success) throw new Error(data.error ?? "SERVERS_UNAVAILABLE");
    setServers(Array.isArray(data.servers) ? data.servers : []);
  }

  async function loadQueue() {
    const response = await fetch(`${API_BASE_URL}/admin/queue`, { credentials: "include", cache: "no-store" });
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; queue?: Record<string, number>; error?: string };
    if (!response.ok || !data.success) throw new Error(data.error ?? "QUEUE_UNAVAILABLE");
    setQueue(data.queue ?? {});
  }

  async function loadReports() {
    const response = await fetch(`${API_BASE_URL}/admin/reports`, { credentials: "include", cache: "no-store" });
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; reports?: unknown[]; bans?: unknown[]; error?: string };
    if (!response.ok || !data.success) throw new Error(data.error ?? "REPORTS_UNAVAILABLE");
    setReports({ reports: data.reports ?? [], bans: data.bans ?? [] });
  }

  async function loadAll() {
    setError("");
    try {
      await Promise.all([loadServers(), loadQueue(), loadReports()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadAll();
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("servers:update", () => {
      void loadServers().catch(() => undefined);
    });
    socket.on("queue:update", () => {
      void loadQueue().catch(() => undefined);
    });

    const poll = setInterval(() => {
      void loadAll();
    }, 12_000);

    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, []);

  const totals = useMemo(() => {
    const online = servers.filter((server) => String(server.status ?? "online").toLowerCase() !== "offline").length;
    const offline = Math.max(0, servers.length - online);
    const queued = Object.values(queue).reduce((sum, value) => sum + Number(value ?? 0), 0);
    return {
      online,
      offline,
      queued,
      reports: reports.reports.length,
      bans: reports.bans.length
    };
  }, [servers, queue, reports]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Servers Online</p>
          <p className="mt-2 text-2xl font-black">{totals.online}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Servers Offline</p>
          <p className="mt-2 text-2xl font-black">{totals.offline}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Queued Players</p>
          <p className="mt-2 text-2xl font-black">{totals.queued}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Reports / Bans</p>
          <p className="mt-2 text-2xl font-black">{totals.reports} / {totals.bans}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Server Monitor</h2>
          <div className="mt-3 space-y-2 text-sm">
            {servers.map((server, index) => {
              const label = String(server.server_id ?? server.id ?? `Server ${index + 1}`);
              const status = String(server.status ?? "online");
              const players = Number(server.players ?? 0);
              const maxPlayers = Number(server.max_players ?? 10);

              return (
                <div key={`${label}-${index}`} className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{label}</p>
                    <span className={`rounded px-2 py-1 text-xs ${status === "offline" ? "bg-red-500/20 text-red-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                      {status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-white/70">{server.map ?? "Unknown map"} � {server.mode ?? "mode"}</p>
                  <p className="mt-1 text-xs text-white/70">Players: {players} / {maxPlayers}</p>
                </div>
              );
            })}
            {servers.length === 0 && <p className="text-white/70">No server data available.</p>}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="text-lg font-semibold">Queue Monitor</h2>
          <div className="mt-3 space-y-2 text-sm">
            {Object.entries(queue).map(([mode, count]) => (
              <div key={mode} className="rounded-lg border border-white/10 bg-white/5 p-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium uppercase tracking-[0.12em] text-white/80">{mode}</p>
                  <p className="font-semibold">{count}</p>
                </div>
              </div>
            ))}
            {Object.keys(queue).length === 0 && <p className="text-white/70">No queue data available.</p>}
          </div>
        </section>
      </div>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Moderation Snapshot</h2>
        <p className="mt-1 text-sm text-white/70">User management, bans and reports are loaded from admin APIs.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">Open reports: {totals.reports}</div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">Recent ban logs: {totals.bans}</div>
        </div>
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
