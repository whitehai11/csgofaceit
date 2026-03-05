"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";
import { RankBadge } from "@/components/RankBadge";
import { MapVotePanel } from "@/components/MapVotePanel";
import { MatchJoinButton } from "@/components/MatchJoinButton";

type LobbyPlayer = {
  id: string;
  display_name: string;
  player_rank: string;
  team: "A" | "B";
};

type LobbyMatch = {
  id: string;
  status: string;
  mode: string;
  map: string;
  created_at?: string;
  players: LobbyPlayer[];
  connection_data?: { server_ip?: string | null; port?: number | null };
};

function modeLabel(mode: string): string {
  if (mode === "ranked") return "Ranked 5v5";
  if (mode === "wingman") return "Wingman 2v2";
  if (mode === "casual") return "Casual 10v10";
  if (mode === "clanwars") return "Clan Wars";
  return mode;
}

function teamCard(players: LobbyPlayer[]) {
  return players.map((player) => {
    const initial = player.display_name.slice(0, 1).toUpperCase();
    return (
      <div key={player.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/10 text-xs font-semibold">
            {initial}
          </span>
          <p className="text-sm font-medium">{player.display_name}</p>
        </div>
        <RankBadge rank={player.player_rank} />
      </div>
    );
  });
}

export function MatchLobbyClient({ initial }: { initial: LobbyMatch }) {
  const [match, setMatch] = useState<LobbyMatch>(initial);
  const [readyCount, setReadyCount] = useState(0);
  const [required, setRequired] = useState(Math.max(1, initial.players.length || 10));
  const [readyBusy, setReadyBusy] = useState(false);
  const [readyError, setReadyError] = useState("");
  const [isCanceled, setIsCanceled] = useState(false);

  const [remaining, setRemaining] = useState(30);

  const teamA = useMemo(() => match.players.filter((player) => player.team === "A"), [match.players]);
  const teamB = useMemo(() => match.players.filter((player) => player.team === "B"), [match.players]);

  const progress = useMemo(() => {
    const percent = Math.max(0, Math.min(100, Math.round((readyCount / Math.max(1, required)) * 100)));
    const blocks = Math.round((percent / 100) * 10);
    return { percent, visual: `${"#".repeat(blocks)}${"-".repeat(10 - blocks)}` };
  }, [readyCount, required]);

  const joinCommand = useMemo(() => {
    const ip = match.connection_data?.server_ip;
    const port = match.connection_data?.port;
    if (!ip || !port) return "Server not ready";
    return `connect ${ip}:${port}; password PASSWORD`;
  }, [match.connection_data?.port, match.connection_data?.server_ip]);

  const serverReady = Boolean(match.connection_data?.server_ip && match.connection_data?.port);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (readyCount < required) setIsCanceled(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);

    return () => clearInterval(timer);
  }, [readyCount, required]);

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/matches/${match.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as LobbyMatch;
        setMatch((prev) => ({ ...prev, ...payload }));
      } catch {
        // noop
      }
    }, 5_000);

    return () => clearInterval(poll);
  }, [match.id]);

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });

    socket.on("match:update", (payload: { type?: string; match_id?: string; ready_count?: number; required?: number; all_ready?: boolean }) => {
      if (!payload || payload.match_id !== match.id) return;

      if (payload.type === "ready") {
        const nextReady = Number(payload.ready_count ?? readyCount);
        const nextRequired = Number(payload.required ?? required);
        setReadyCount(nextReady);
        setRequired(nextRequired);
        if (payload.all_ready) {
          setRemaining(0);
          setIsCanceled(false);
        }
      }

      if (payload.type === "match_live") {
        setMatch((prev) => ({ ...prev, status: "live" }));
      }
    });

    socket.on("match:mapvote", (payload: { match_id?: string; state?: { final_map?: string | null } }) => {
      if (!payload || payload.match_id !== match.id) return;
      if (payload.state?.final_map) {
        setMatch((prev) => ({ ...prev, map: String(payload.state?.final_map ?? prev.map) }));
      }
    });

    return () => {
      socket.close();
    };
  }, [match.id, readyCount, required]);

  async function readyUp() {
    setReadyBusy(true);
    setReadyError("");
    try {
      const response = await fetch(`${API_BASE_URL}/match/${match.id}/ready`, {
        method: "POST",
        credentials: "include"
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ready_count?: number;
        required?: number;
        all_ready?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "READY_FAILED");
      }
      setReadyCount(Number(payload.ready_count ?? readyCount));
      setRequired(Number(payload.required ?? required));
      if (payload.all_ready) {
        setRemaining(0);
        setIsCanceled(false);
      }
    } catch (error) {
      setReadyError((error as Error).message);
    } finally {
      setReadyBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Match Lobby</h1>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Mode</p>
            <p className="mt-2 font-semibold">{modeLabel(match.mode)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Match ID</p>
            <p className="mt-2 truncate font-mono text-xs">{match.id}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Region</p>
            <p className="mt-2 font-semibold">Frankfurt</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Status</p>
            <p className="mt-2 font-semibold capitalize">{match.status}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-lg font-semibold">Team A</h2>
          <div className="space-y-2">{teamCard(teamA)}</div>
        </div>
        <div className="card p-4">
          <h2 className="mb-3 text-lg font-semibold">Team B</h2>
          <div className="space-y-2">{teamCard(teamB)}</div>
        </div>
      </section>

      <section className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Ready Check</h2>
            <p className="mt-1 text-sm text-white/70">Players Ready: {readyCount} / {required}</p>
          </div>
          <button type="button" className="btn-primary" onClick={() => void readyUp()} disabled={readyBusy || isCanceled}>
            {readyBusy ? "Submitting..." : "Ready"}
          </button>
        </div>

        <div className="mt-4 h-2 w-full overflow-hidden rounded bg-white/10">
          <motion.div
            className="h-full bg-brand"
            initial={false}
            animate={{ width: `${progress.percent}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
        <p className="mt-2 font-mono text-sm text-white/80">{progress.visual}</p>

        {!isCanceled && remaining > 0 && (
          <p className="mt-2 text-sm text-white/80">Match starting in {remaining} seconds</p>
        )}
        {isCanceled && readyCount < required && (
          <p className="mt-2 text-sm font-semibold text-red-300">Match canceled: not all players readied in time.</p>
        )}
        {readyError && <p className="mt-2 text-sm text-red-400">{readyError}</p>}
      </section>

      <MapVotePanel matchId={match.id} />

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Server Join</h2>
        <p className="mt-1 text-sm text-white/70">Region: Frankfurt � Map: {match.map}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <MatchJoinButton command={joinCommand} />
          <code className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/80">{joinCommand}</code>
        </div>
        {!serverReady && <p className="mt-2 text-sm text-white/65">Server is not ready yet. Waiting for allocation...</p>}
      </section>
    </div>
  );
}
