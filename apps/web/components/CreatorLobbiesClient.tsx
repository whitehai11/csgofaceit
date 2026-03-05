"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type CreatorLobby = {
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
  players_joined: number;
  status: string;
  match_id: string | null;
  server_id: string | null;
  created_at: string;
};

function prettyMode(mode: string): string {
  if (mode === "ranked") return "Ranked 5v5";
  if (mode === "wingman") return "Wingman 2v2";
  if (mode === "casual") return "Casual 10v10";
  if (mode === "clanwars") return "Clan Wars";
  return mode;
}

export function CreatorLobbiesClient({ initial }: { initial: CreatorLobby[] }) {
  const [lobbies, setLobbies] = useState<CreatorLobby[]>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    mode: "ranked",
    mapPool: "de_mirage,de_inferno,de_dust2,de_nuke,de_overpass",
    maxPlayers: "10"
  });

  async function refresh() {
    const response = await fetch(`${API_BASE_URL}/creator/lobbies`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as CreatorLobby[];
    setLobbies(payload);
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
  }, []);

  async function createLobby() {
    setBusy(true);
    setMessage("");
    try {
      const map_pool = form.mapPool
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      const response = await fetch(`${API_BASE_URL}/creator/lobbies`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: form.mode,
          map_pool,
          max_players: Number(form.maxPlayers)
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; lobby_id?: string };
      if (!response.ok) throw new Error(payload.error ?? "CREATE_LOBBY_FAILED");
      setMessage("Lobby created.");
      if (payload.lobby_id) {
        window.location.href = `/creator/${payload.lobby_id}`;
        return;
      }
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = useMemo(
    () => [...lobbies].sort((a, b) => b.players_joined - a.players_joined || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [lobbies]
  );

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h2 className="text-xl font-semibold">Create Lobby</h2>
        <p className="mt-1 text-sm text-white/70">Creators can host community matches and launch servers directly.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm text-white/80">
            Mode
            <select
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2"
              value={form.mode}
              onChange={(e) => setForm((s) => ({ ...s, mode: e.target.value }))}
            >
              <option value="ranked">Ranked 5v5</option>
              <option value="wingman">Wingman 2v2</option>
              <option value="casual">Casual 10v10</option>
              <option value="clanwars">Clan Wars</option>
            </select>
          </label>
          <label className="text-sm text-white/80">
            Max Players
            <input
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2"
              value={form.maxPlayers}
              onChange={(e) => setForm((s) => ({ ...s, maxPlayers: e.target.value }))}
            />
          </label>
          <label className="text-sm text-white/80">
            Map Pool (comma separated)
            <input
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2"
              value={form.mapPool}
              onChange={(e) => setForm((s) => ({ ...s, mapPool: e.target.value }))}
            />
          </label>
        </div>
        <button type="button" className="btn-primary mt-4" disabled={busy} onClick={() => void createLobby()}>
          {busy ? "Creating..." : "Create Lobby"}
        </button>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {active.map((lobby) => (
          <article key={lobby.id} className="card p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Creator Lobby</p>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/30 text-sm font-semibold">
                {lobby.creator.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="font-semibold">{lobby.creator.name}</p>
                <p className="text-xs text-white/65">{lobby.creator.rank}</p>
              </div>
            </div>
            <div className="mt-4 space-y-1 text-sm text-white/80">
              <p>Mode: {prettyMode(lobby.mode)}</p>
              <p>
                Players: {lobby.players_joined} / {lobby.max_players}
              </p>
              <p>Status: {lobby.status}</p>
            </div>
            <a href={`/creator/${lobby.id}`} className="btn-primary mt-4 inline-flex">
              Join Lobby
            </a>
          </article>
        ))}
        {active.length === 0 && <div className="card p-6 text-sm text-white/70">No active creator lobbies right now.</div>}
      </section>

      {message && <p className="text-sm text-white/75">{message}</p>}
    </div>
  );
}
