"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type LobbyPlayer = {
  player_id: string;
  steam_id: string;
  display_name: string;
  rank: string;
  joined_at: string;
};

type LobbyDetail = {
  id: string;
  creator: {
    player_id: string;
    steam_id: string;
    name: string;
    rank: string;
  };
  mode: string;
  map_pool: string[];
  max_players: number;
  status: string;
  match_id: string | null;
  server_id: string | null;
  created_at: string;
  players: LobbyPlayer[];
};

function prettyMode(mode: string): string {
  if (mode === "ranked") return "Ranked 5v5";
  if (mode === "wingman") return "Wingman 2v2";
  if (mode === "casual") return "Casual 10v10";
  if (mode === "clanwars") return "Clan Wars";
  return mode;
}

export function CreatorLobbyClient({ initial, canStart }: { initial: LobbyDetail; canStart: boolean }) {
  const [lobby, setLobby] = useState<LobbyDetail>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connectCommand, setConnectCommand] = useState("");

  async function refresh() {
    const response = await fetch(`${API_BASE_URL}/creator/lobbies/${lobby.id}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as LobbyDetail;
    setLobby(payload);
  }

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("queue:update", () => {
      void refresh().catch(() => undefined);
    });
    socket.on("match:update", () => {
      void refresh().catch(() => undefined);
    });
    const poll = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 8_000);
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [lobby.id]);

  async function join() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/creator/lobbies/${lobby.id}/join`, {
        method: "POST",
        credentials: "include"
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "JOIN_FAILED");
      setMessage("Joined lobby.");
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/creator/lobbies/${lobby.id}/leave`, {
        method: "POST",
        credentials: "include"
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "LEAVE_FAILED");
      setMessage("Left lobby.");
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startMatch() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/creator/lobbies/${lobby.id}/start`, {
        method: "POST",
        credentials: "include"
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; connect_command?: string; match_id?: string };
      if (!response.ok) throw new Error(payload.error ?? "START_FAILED");
      if (payload.connect_command) setConnectCommand(payload.connect_command);
      setMessage(payload.match_id ? `Match started: ${payload.match_id}` : "Match started.");
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const slots = useMemo(() => {
    const max = Math.max(0, lobby.max_players);
    return Array.from({ length: max }, (_, index) => lobby.players[index] ?? null);
  }, [lobby.max_players, lobby.players]);

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">{lobby.creator.name} Lobby</h1>
        <p className="mt-1 text-sm text-white/70">
          Mode: {prettyMode(lobby.mode)} | Players: {lobby.players.length} / {lobby.max_players}
        </p>
        <p className="mt-1 text-sm text-white/70">Map Pool: {lobby.map_pool.join(", ")}</p>
        <p className="mt-1 text-sm text-white/70">Status: {lobby.status}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void join()}>
            Join Lobby
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void leave()}>
            Leave Lobby
          </button>
          {canStart && (
            <button type="button" className="btn bg-emerald-600 hover:bg-emerald-500" disabled={busy || lobby.status !== "open"} onClick={() => void startMatch()}>
              Start Match
            </button>
          )}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-semibold">Player Slots</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {slots.map((player, index) => (
            <div key={`${index}-${player?.player_id ?? "empty"}`} className="rounded-xl border border-white/10 bg-white/5 p-3">
              <p className="text-xs text-white/60">Slot {index + 1}</p>
              {player ? (
                <>
                  <p className="mt-1 font-semibold">{player.display_name}</p>
                  <p className="text-xs text-white/65">{player.rank}</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-white/45">Open Slot</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {connectCommand && (
        <section className="card p-6">
          <h2 className="text-lg font-semibold">Server Join</h2>
          <code className="mt-3 block rounded-lg bg-black/30 px-3 py-2 text-xs text-white/85">{connectCommand}</code>
        </section>
      )}

      {message && <p className="text-sm text-white/75">{message}</p>}
    </div>
  );
}

