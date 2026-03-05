"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type VoteState = {
  maps: string[];
  final_map: string | null;
  turn?: "A" | "B";
  history?: Array<{ removed_map: string; by_team?: "A" | "B" }>;
};

const MAPS = ["de_dust2", "de_mirage", "de_inferno", "de_nuke", "de_overpass"];

function prettyMapName(raw: string): string {
  return raw.replace(/^de_/, "").replace(/_/g, " ").replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());
}

function mapTone(map: string): string {
  if (map.includes("mirage")) return "from-orange-600/35 to-amber-500/15";
  if (map.includes("inferno")) return "from-red-600/35 to-rose-500/15";
  if (map.includes("nuke")) return "from-cyan-600/35 to-sky-500/15";
  if (map.includes("overpass")) return "from-emerald-600/35 to-teal-500/15";
  return "from-yellow-600/35 to-amber-500/15";
}

export function MapVotePanel({ matchId }: { matchId: string }) {
  const [state, setState] = useState<VoteState>({ maps: MAPS, final_map: null, history: [] });
  const [error, setError] = useState("");
  const [pendingMap, setPendingMap] = useState<string | null>(null);

  const vetoedMaps = useMemo(() => {
    const alive = new Set(state.maps);
    return MAPS.filter((map) => !alive.has(map));
  }, [state.maps]);

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("match:mapvote", (payload: { match_id?: string; state?: VoteState }) => {
      if (!payload || payload.match_id !== matchId || !payload.state) return;
      setState(payload.state);
    });

    return () => {
      socket.close();
    };
  }, [matchId]);

  async function veto(map: string) {
    setError("");
    setPendingMap(map);
    try {
      const response = await fetch(`${API_BASE_URL}/match/${matchId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ map })
      });
      const data = (await response.json()) as { success?: boolean; error?: string; state?: VoteState };
      if (!response.ok) {
        setError(data.error ?? "MAP_VOTE_FAILED");
        return;
      }
      if (data.state) setState(data.state);
    } finally {
      setPendingMap(null);
    }
  }

  return (
    <div className="card p-4">
      <h3 className="text-lg font-semibold">Map Veto</h3>
      <p className="mt-1 text-sm text-white/70">Click a map card to veto it. Last map wins.</p>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {MAPS.map((map) => {
          const isActive = state.maps.includes(map);
          const isFinal = state.final_map === map;
          const disabled = !isActive || Boolean(state.final_map) || pendingMap !== null;

          return (
            <motion.button
              key={map}
              type="button"
              layout
              initial={{ opacity: 0.8, scale: 0.98 }}
              animate={{
                opacity: isActive ? 1 : 0.38,
                scale: isFinal ? 1.03 : 1,
                filter: isActive ? "grayscale(0)" : "grayscale(1)"
              }}
              whileHover={disabled ? undefined : { scale: 1.02 }}
              transition={{ duration: 0.2 }}
              className={`rounded-xl border p-3 text-left ${
                isFinal ? "border-emerald-400/70 bg-emerald-500/10" : "border-white/10"
              } ${isActive ? `bg-gradient-to-br ${mapTone(map)}` : "bg-white/5"}`}
              onClick={() => void veto(map)}
              disabled={disabled}
            >
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Map</p>
              <p className="mt-2 text-sm font-semibold">{prettyMapName(map)}</p>
              <p className="mt-3 text-xs text-white/70">{isFinal ? "Selected" : isActive ? "Available" : "Vetoed"}</p>
            </motion.button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs text-white/70">
        <span className="rounded border border-white/10 bg-black/25 px-2 py-1">Current Turn: Team {state.turn ?? "A"}</span>
        <span className="rounded border border-white/10 bg-black/25 px-2 py-1">Vetoed: {vetoedMaps.length}</span>
      </div>

      {state.final_map && <p className="mt-3 text-sm font-semibold text-emerald-300">Final map: {prettyMapName(state.final_map)}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}
