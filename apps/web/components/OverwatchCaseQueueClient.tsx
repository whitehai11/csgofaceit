"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type OverwatchCase = {
  case_id: string;
  player_id: string;
  reported_player_name?: string;
  match_id: string;
  map?: string;
  reports_count?: number;
  status: string;
  consensus?: {
    required: number;
    max_votes: number;
    total_votes: number;
    cheating_votes: number;
    clean_votes: number;
  };
};

export function OverwatchCaseQueueClient({ initial }: { initial: OverwatchCase[] }) {
  const [cases, setCases] = useState<OverwatchCase[]>(initial);

  async function refresh() {
    const response = await fetch(`${API_BASE_URL}/cases`, { credentials: "include", cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as OverwatchCase[];
    setCases(payload);
  }

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("servers:update", () => {
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

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cases.map((item) => (
        <div key={item.case_id} className="card p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">Case</p>
          <p className="mt-1 truncate font-mono text-xs text-white/80">{item.case_id}</p>
          <p className="mt-3 text-sm text-white/80">Match #{item.match_id.slice(0, 8)}</p>
          <p className="text-sm text-white/80">Player: {item.reported_player_name ?? item.player_id}</p>
          <p className="text-sm text-white/80">Reports Count: {Number(item.reports_count ?? 0)}</p>
          <p className="text-sm text-white/80">Map: {item.map ?? "Unknown"}</p>
          <p className="mt-1 text-xs text-white/65">Status: {item.status}</p>
          <div className="mt-3">
            <Link href={`/overwatch/case/${item.case_id}`} className="btn-primary">
              Review Case
            </Link>
          </div>
        </div>
      ))}
      {cases.length === 0 && <div className="card p-6 text-sm text-white/70">No open cases available.</div>}
    </section>
  );
}
