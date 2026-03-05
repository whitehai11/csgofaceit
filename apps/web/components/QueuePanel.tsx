"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type QueueModeId = "ranked" | "wingman" | "casual" | "clanwars";
type QueueStatusEntry = { size: number; needed: number; average_rank?: string };
type QueueStatusResponse = { modes: Record<QueueModeId, QueueStatusEntry> };
type StatsResponse = { live_matches: number; servers_online: number; players_online: number; players_queued: number };
type MeResponse = { id?: string | null };
type LiveMatch = { match_id: string; mode?: string; players?: Array<{ id?: string; team?: "A" | "B"; display_name?: string }> };

const MODES: Array<{ id: QueueModeId; label: string; maxPlayers: number; accent: string; description: string }> = [
  { id: "ranked", label: "Ranked 5v5", maxPlayers: 10, accent: "from-rose-500/25 to-brand/10", description: "Competitive ranked matches" },
  { id: "wingman", label: "Wingman 2v2", maxPlayers: 4, accent: "from-cyan-500/25 to-brand/10", description: "Short tactical matches" },
  { id: "casual", label: "Casual 10v10", maxPlayers: 20, accent: "from-amber-500/25 to-brand/10", description: "Fast unranked warmup games" },
  { id: "clanwars", label: "Clan Wars", maxPlayers: 10, accent: "from-emerald-500/25 to-brand/10", description: "Team based clan battles" }
];

const SEARCH_FRAMES = ["█░░░░░░░░░", "██░░░░░░░░", "███░░░░░░░", "████░░░░░░"] as const;
const BAR_LENGTH = 10;

function computeProgressBar(size: number, max: number): string {
  const clamped = Math.max(0, Math.min(max, size));
  const filled = Math.round((clamped / Math.max(1, max)) * BAR_LENGTH);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, BAR_LENGTH - filled))}`;
}

export function QueuePanel({ redirectOnMatchFound = false }: { redirectOnMatchFound?: boolean }) {
  const [statuses, setStatuses] = useState<Record<QueueModeId, QueueStatusEntry>>({
    ranked: { size: 0, needed: 10, average_rank: "Silver Elite" },
    wingman: { size: 0, needed: 4, average_rank: "Silver Elite" },
    casual: { size: 0, needed: 20, average_rank: "-" },
    clanwars: { size: 0, needed: 10, average_rank: "Silver Elite" }
  });
  const [stats, setStats] = useState<StatsResponse>({
    live_matches: 0,
    servers_online: 0,
    players_online: 0,
    players_queued: 0
  });
  const [activeMode, setActiveMode] = useState<QueueModeId | null>(null);
  const [searching, setSearching] = useState(false);
  const [frame, setFrame] = useState(0);
  const [busyMode, setBusyMode] = useState<QueueModeId | null>(null);
  const [error, setError] = useState("");
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);

  async function refreshStatuses() {
    const response = await fetch(`${API_BASE_URL}/queue/status`, { cache: "no-store" });
    if (!response.ok) throw new Error("QUEUE_STATUS_FAILED");
    const payload = (await response.json()) as QueueStatusResponse;
    if (payload?.modes) setStatuses(payload.modes);
  }

  async function refreshStats() {
    const response = await fetch(`${API_BASE_URL}/stats`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as StatsResponse;
    setStats(payload);
  }

  async function refreshCurrentPlayer() {
    const response = await fetch(`${API_BASE_URL}/me`, { cache: "no-store", credentials: "include" });
    if (!response.ok) return;
    const payload = (await response.json()) as MeResponse;
    if (payload?.id) setCurrentPlayerId(String(payload.id));
  }

  async function checkMatchFound() {
    if (!redirectOnMatchFound || !searching || !activeMode || !currentPlayerId) return;
    const response = await fetch(`${API_BASE_URL}/matches/live`, { cache: "no-store" });
    if (!response.ok) return;
    const matches = (await response.json()) as LiveMatch[];
    const found = matches.find((match) => {
      const mode = String(match.mode ?? "ranked");
      if (mode !== activeMode) return false;
      return Array.isArray(match.players) && match.players.some((p) => String(p.id ?? "") === currentPlayerId);
    });
    if (found?.match_id) {
      window.location.href = `/match/${found.match_id}/lobby`;
    }
  }

  useEffect(() => {
    void refreshStatuses().catch(() => undefined);
    void refreshStats().catch(() => undefined);
    void refreshCurrentPlayer().catch(() => undefined);

    const poll = setInterval(() => {
      void Promise.all([refreshStatuses(), refreshStats(), checkMatchFound()]).catch(() => undefined);
      setFrame((prev) => (prev + 1) % SEARCH_FRAMES.length);
    }, 5_000);

    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("queue:update", () => {
      void refreshStatuses().catch(() => undefined);
    });
    socket.on("stats:update", () => {
      void refreshStats().catch(() => undefined);
    });
    socket.on("match:update", () => {
      void checkMatchFound().catch(() => undefined);
    });

    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [searching, activeMode, currentPlayerId, redirectOnMatchFound]);

  const activeStatus = useMemo(() => {
    if (!activeMode) return null;
    return statuses[activeMode] ?? null;
  }, [activeMode, statuses]);

  const activeModeMax = useMemo(() => {
    if (!activeMode) return 10;
    return MODES.find((mode) => mode.id === activeMode)?.maxPlayers ?? 10;
  }, [activeMode]);

  const etaSeconds = useMemo(() => {
    if (!activeStatus) return 20;
    return Math.max(8, Number(activeStatus.needed ?? 0) * 6);
  }, [activeStatus]);

  async function joinQueue(mode: QueueModeId) {
    setBusyMode(mode);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/queue/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "QUEUE_JOIN_FAILED");
      setActiveMode(mode);
      setSearching(true);
      await refreshStatuses();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyMode(null);
    }
  }

  async function leaveQueue() {
    if (!activeMode) return;
    setBusyMode(activeMode);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/queue/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: activeMode })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "QUEUE_LEAVE_FAILED");
      setSearching(false);
      setActiveMode(null);
      await refreshStatuses();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyMode(null);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-xl font-bold">FragHub Matchmaking</h2>
      <p className="mt-1 text-sm text-white/70">Competitive queue with live updates.</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Live Matches</p>
          <p className="mt-2 text-xl font-bold">{stats.live_matches}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Servers Online</p>
          <p className="mt-2 text-xl font-bold">{stats.servers_online}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Players in Queue</p>
          <p className="mt-2 text-xl font-bold">{stats.players_queued}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {MODES.map((mode) => {
          const status = statuses[mode.id] ?? { size: 0, needed: mode.maxPlayers, average_rank: "-" };
          const progressPercent = Math.max(0, Math.min(100, Math.round((status.size / Math.max(1, mode.maxPlayers)) * 100)));
          return (
            <div key={mode.id} className={`rounded-xl border border-white/10 bg-gradient-to-r ${mode.accent} p-4`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{mode.label}</p>
                  <p className="mt-1 text-xs text-white/75">{mode.description}</p>
                  <p className="mt-2 text-xs text-white/70">Players: {status.size} / {mode.maxPlayers}</p>
                  <p className="text-xs text-white/70">Average rank: {status.average_rank ?? "-"}</p>
                  <div className="mt-2 h-1.5 w-44 overflow-hidden rounded bg-white/15">
                    <motion.div
                      className="h-full bg-brand"
                      initial={false}
                      animate={{ width: `${progressPercent}%` }}
                      transition={{ duration: 0.35 }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void joinQueue(mode.id)}
                  disabled={busyMode === mode.id}
                  className="btn-primary"
                >
                  Join Queue
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {searching && activeMode && activeStatus && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 rounded-xl border border-brand/35 bg-brand/10 p-4"
        >
          <p className="text-sm font-semibold">Searching for players...</p>
          <p className="mt-2 font-mono text-sm text-white/90">{SEARCH_FRAMES[frame]}</p>
          <p className="mt-2 text-xs text-white/80">Mode: {MODES.find((m) => m.id === activeMode)?.label}</p>
          <p className="text-xs text-white/80">Players Found: {activeStatus.size} / {activeModeMax}</p>
          <p className="text-xs text-white/80">Estimated Time: ~{etaSeconds} seconds</p>
          <p className="mt-2 font-mono text-sm text-white/90">{computeProgressBar(activeStatus.size, activeModeMax)}</p>
          <button type="button" className="btn mt-3 bg-red-600 hover:bg-red-500" onClick={() => void leaveQueue()} disabled={busyMode !== null}>
            Leave Queue
          </button>
        </motion.div>
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
