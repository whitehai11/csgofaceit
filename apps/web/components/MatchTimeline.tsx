"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type TimelineEvent = {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function prettyType(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function describeEvent(event: TimelineEvent): string {
  const payload = event.payload ?? {};
  const round = Number(payload.round ?? payload.round_number ?? NaN);
  if (event.event_type === "round_end") {
    const winner = String(payload.winner ?? payload.winning_team ?? "Team");
    if (Number.isFinite(round)) return `Round ${round}: ${winner} wins`;
    return `${winner} wins the round`;
  }
  if (event.event_type === "kill" || event.event_type === "player_kill") {
    const killer = String(payload.killer_name ?? payload.killer ?? "Player");
    return `${killer} secured a kill`;
  }
  if (event.event_type === "ace") {
    return `${String(payload.player_name ?? "Player")} got an ace`;
  }
  if (event.event_type === "clutch") {
    return `${String(payload.player_name ?? "Player")} won a clutch`;
  }
  return prettyType(event.event_type);
}

export function MatchTimeline({ matchId, initial }: { matchId: string; initial: TimelineEvent[] }) {
  const [events, setEvents] = useState<TimelineEvent[]>(initial);

  async function refreshTimeline() {
    const res = await fetch(`${API_BASE_URL}/match/${matchId}/timeline`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { events: TimelineEvent[] };
    setEvents(data.events ?? []);
  }

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("match:timeline", (payload: { match_id?: string }) => {
      if (!payload || payload.match_id !== matchId) return;
      void refreshTimeline().catch(() => undefined);
    });
    return () => {
      socket.close();
    };
  }, [matchId]);

  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [events]);

  return (
    <div className="card p-4">
      <h3 className="text-lg font-semibold">Match Timeline</h3>
      <div className="mt-4 max-h-80 space-y-4 overflow-auto pr-2">
        {sortedEvents.map((event, index) => (
          <div key={event.id} className="relative pl-6">
            <span className="absolute left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-brand" />
            {index < sortedEvents.length - 1 && <span className="absolute left-[10px] top-4 h-full w-px bg-white/15" />}
            <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
              <p className="font-medium text-white/90">{describeEvent(event)}</p>
              <p className="mt-1 text-xs text-white/55">{new Date(event.created_at).toLocaleString()}</p>
            </div>
          </div>
        ))}
        {sortedEvents.length === 0 && <p className="text-sm text-white/70">No timeline events yet.</p>}
      </div>
    </div>
  );
}
