"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { SOCKET_URL } from "@/lib/config";

type LiveMatch = {
  match_id: string;
  map: string;
  map_display?: string;
  mode?: string;
  team_a_score?: number;
  team_b_score?: number;
  score?: string;
  server_ip?: string | null;
  server_port?: number | null;
  players: Array<{ id?: string; display_name?: string; team?: "A" | "B" }>;
};

export function LiveMatchGrid({ initial }: { initial: LiveMatch[] }) {
  const [matches, setMatches] = useState<LiveMatch[]>(initial);

  function mapBackdrop(map: string): string {
    const key = map.toLowerCase();
    if (key.includes("mirage")) return "from-orange-600/70 via-amber-500/30 to-black/20";
    if (key.includes("inferno")) return "from-red-700/70 via-rose-500/30 to-black/20";
    if (key.includes("nuke")) return "from-cyan-600/70 via-sky-500/30 to-black/20";
    if (key.includes("overpass")) return "from-emerald-600/70 via-teal-500/30 to-black/20";
    if (key.includes("dust2") || key.includes("dust")) return "from-yellow-600/70 via-amber-500/30 to-black/20";
    return "from-violet-600/70 via-indigo-500/30 to-black/20";
  }

  function modeLabel(mode: string | undefined): string {
    if (mode === "ranked") return "Ranked 5v5";
    if (mode === "wingman") return "Wingman 2v2";
    if (mode === "casual") return "Casual 10v10";
    if (mode === "clanwars") return "Clan Wars";
    return "Match";
  }

  function serverRegion(match: LiveMatch): string {
    if (match.server_ip) return "Frankfurt";
    return "Unknown";
  }

  useEffect(() => {
    const socket: Socket = io(SOCKET_URL, { transports: ["websocket"] });
    socket.on("match:update", async () => {
      try {
        const res = await fetch(`${SOCKET_URL}/matches/live`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as LiveMatch[];
        setMatches(data);
      } catch {
        // noop
      }
    });
    return () => {
      socket.close();
    };
  }, []);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {matches.map((match) => {
        const teamA = (Array.isArray(match.players) ? match.players : []).filter((player) => player.team === "A");
        const teamB = (Array.isArray(match.players) ? match.players : []).filter((player) => player.team === "B");
        const scoreA = Number(match.team_a_score ?? String(match.score ?? "0-0").split("-")[0] ?? 0);
        const scoreB = Number(match.team_b_score ?? String(match.score ?? "0-0").split("-")[1] ?? 0);

        return (
          <Link
            key={match.match_id}
            href={`/match/${match.match_id}`}
            className="card group overflow-hidden p-0 transition hover:-translate-y-0.5 hover:border-brand/60"
          >
            <div className={`relative h-28 bg-gradient-to-br ${mapBackdrop(match.map_display ?? match.map)} p-4`}>
              <p className="text-xs uppercase tracking-[0.24em] text-white/80">{modeLabel(match.mode)}</p>
              <p className="mt-2 text-2xl font-black">{match.map_display ?? match.map}</p>
              <div className="absolute inset-0 bg-black/20 opacity-35 transition-opacity group-hover:opacity-20" />
            </div>
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <p className="text-sm font-semibold text-white/90">Team A</p>
                <p className="text-base font-black text-brand">{scoreA}</p>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <p className="text-sm font-semibold text-white/90">Team B</p>
                <p className="text-base font-black text-brand">{scoreB}</p>
              </div>

              <div className="flex items-center gap-2">
                {[...teamA.slice(0, 3), ...teamB.slice(0, 3)].map((player, index) => {
                  const initial = String(player.display_name ?? "?").slice(0, 1).toUpperCase();
                  return (
                    <span
                      key={`${player.id ?? player.display_name ?? "player"}-${index}`}
                      title={player.display_name ?? "Player"}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 text-xs font-semibold"
                    >
                      {initial}
                    </span>
                  );
                })}
                <p className="ml-auto text-xs text-white/65">{match.players.length} players</p>
              </div>
              <p className="text-xs text-white/70">
                {(match.players ?? [])
                  .slice(0, 5)
                  .map((player) => String(player.display_name ?? "Player"))
                  .join(" | ") || "No players listed"}
              </p>

              <p className="text-xs text-white/60">Server region: {serverRegion(match)}</p>
            </div>
          </Link>
        );
      })}
      {matches.length === 0 && <div className="card p-6 text-sm text-white/70">No live matches right now.</div>}
    </div>
  );
}
