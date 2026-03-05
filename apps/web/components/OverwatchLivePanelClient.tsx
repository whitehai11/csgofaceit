"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type LiveAlert = {
  alert_id: string;
  match_id: string;
  map: string;
  reports_count: number;
  players_count: number;
  suspect: {
    steam_id: string;
    player_id: string | null;
    name: string;
  };
  match_status: string;
  alert_status: string;
  case_id: string | null;
  score: number;
  created_at: string;
  spectate_command: string | null;
};

type ActionState = {
  busyId: string | null;
  message: string;
};

function prettyMapName(raw: string): string {
  return raw.replace(/^de_/, "").replace(/_/g, " ").replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());
}

export function OverwatchLivePanelClient({
  initial,
  canAdminTools
}: {
  initial: LiveAlert[];
  canAdminTools: boolean;
}) {
  const [alerts, setAlerts] = useState<LiveAlert[]>(initial);
  const [state, setState] = useState<ActionState>({ busyId: null, message: "" });

  async function refresh() {
    const response = await fetch(`${API_BASE_URL}/overwatch/live?min_reports=4&limit=100`, {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) return;
    const payload = (await response.json()) as LiveAlert[];
    setAlerts(payload);
  }

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("match:update", () => {
      void refresh().catch(() => undefined);
    });
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

  const sorted = useMemo(
    () => [...alerts].sort((a, b) => b.reports_count - a.reports_count || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [alerts]
  );

  async function runAction(
    id: string,
    path: string,
    init?: { method?: "POST"; body?: Record<string, unknown> }
  ) {
    setState({ busyId: id, message: "" });
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: init?.method ?? "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(init?.body ?? {})
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; case_id?: string; connect_command?: string };
      if (!response.ok) throw new Error(payload.error ?? "ACTION_FAILED");
      if (payload.connect_command) {
        await navigator.clipboard.writeText(payload.connect_command);
        setState({ busyId: null, message: "Spectator command copied." });
      } else if (payload.case_id) {
        setState({ busyId: null, message: `Case ready: ${payload.case_id}` });
      } else {
        setState({ busyId: null, message: "Action completed." });
      }
      await refresh();
    } catch (error) {
      setState({ busyId: null, message: (error as Error).message });
    }
  }

  return (
    <div className="space-y-4">
      {sorted.map((item) => (
        <section key={item.alert_id} className="card p-5">
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Match ID</p>
              <p className="mt-1 font-mono text-xs">{item.match_id}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Map</p>
              <p className="mt-1">{prettyMapName(item.map ?? "Unknown")}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Reports</p>
              <p className="mt-1 text-lg font-semibold text-red-300">{item.reports_count}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Players</p>
              <p className="mt-1">{item.players_count}</p>
            </div>
          </div>

          <div className="mt-3 text-sm text-white/75">
            Suspect: <span className="font-semibold text-white">{item.suspect.name}</span> ({item.suspect.steam_id})
          </div>

          {item.spectate_command && (
            <code className="mt-3 block rounded-lg bg-black/30 px-3 py-2 text-xs text-white/85">{item.spectate_command}</code>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={state.busyId === item.alert_id}
              onClick={() => void runAction(item.alert_id, `/overwatch/live/${item.alert_id}/watch`)}
            >
              Watch Live Match
            </button>
            <button
              type="button"
              className="btn bg-orange-600 hover:bg-orange-500"
              disabled={state.busyId === item.alert_id}
              onClick={() =>
                void runAction(item.alert_id, `/overwatch/live/${item.alert_id}/timeout-suspect`, {
                  body: { reason: "Reviewer intervention from live panel" }
                })
              }
            >
              Timeout Suspect
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={state.busyId === item.alert_id}
              onClick={() => void runAction(item.alert_id, `/overwatch/live/${item.alert_id}/open-case`)}
            >
              Open Full Case
            </button>
            {item.case_id && (
              <Link href={`/overwatch/case/${item.case_id}`} className="btn-secondary">
                Review Case
              </Link>
            )}
          </div>

          {canAdminTools && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4">
              <button
                type="button"
                className="btn-secondary"
                disabled={state.busyId === item.alert_id}
                onClick={() => void runAction(item.alert_id, `/overwatch/live/${item.alert_id}/cancel-timeout`)}
              >
                Cancel Timeout
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={state.busyId === item.alert_id}
                onClick={() => void runAction(item.alert_id, `/overwatch/live/${item.match_id}/resume`)}
              >
                Resume Match
              </button>
              {item.case_id && (
                <button
                  type="button"
                  className="btn bg-red-700 hover:bg-red-600"
                  disabled={state.busyId === item.alert_id}
                  onClick={() =>
                    void runAction(item.alert_id, `/overwatch/live/${item.case_id}/force-ban`, {
                      body: { reason: "Admin override from live panel" }
                    })
                  }
                >
                  Force Ban
                </button>
              )}
            </div>
          )}
        </section>
      ))}

      {sorted.length === 0 && <div className="card p-6 text-sm text-white/70">No live matches currently exceed the cheat-report threshold.</div>}
      {state.message && <p className="text-sm text-white/75">{state.message}</p>}
    </div>
  );
}

