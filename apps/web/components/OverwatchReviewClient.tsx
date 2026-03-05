"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type CaseVote = {
  case_id: string;
  moderator_id: string;
  vote: string;
  created_at: string;
  reviewer_name?: string | null;
};

type OverwatchCaseDetail = {
  case_id: string;
  player_id: string;
  reported_player_name: string;
  reported_player_steam_id?: string;
  match_id: string;
  map: string;
  match_status: string;
  match_created_at?: string;
  reports_count: number;
  reports?: unknown;
  demo_url?: string | null;
  spectate_command?: string | null;
  status: string;
  consensus: {
    required: number;
    max_votes: number;
    total_votes: number;
    cheating_votes: number;
    clean_votes: number;
  };
  votes: CaseVote[];
};

type TimelineEvent = {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function prettyMapName(raw: string): string {
  return raw.replace(/^de_/, "").replace(/_/g, " ").replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());
}

function parseRound(event: TimelineEvent): number | null {
  const payload = event.payload ?? {};
  const round = Number(payload.round ?? payload.round_number ?? NaN);
  return Number.isFinite(round) ? round : null;
}

export function OverwatchReviewClient({
  initialCase,
  initialTimeline,
  canAdminTools
}: {
  initialCase: OverwatchCaseDetail;
  initialTimeline: TimelineEvent[];
  canAdminTools: boolean;
}) {
  const [caseData, setCaseData] = useState<OverwatchCaseDetail>(initialCase);
  const [timeline] = useState<TimelineEvent[]>(initialTimeline);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const rounds = useMemo(() => {
    const list = timeline.map(parseRound).filter((x): x is number => x !== null);
    return Array.from(new Set(list)).sort((a, b) => a - b);
  }, [timeline]);

  const visibleTimeline = useMemo(() => {
    if (selectedRound === null) return timeline;
    return timeline.filter((event) => parseRound(event) === selectedRound);
  }, [selectedRound, timeline]);

  const progressPercent = Math.max(0, Math.min(100, Math.round((caseData.consensus.total_votes / Math.max(1, caseData.consensus.max_votes)) * 100)));

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("servers:update", () => {
      void refreshCase().catch(() => undefined);
    });
    socket.on("match:update", (payload: { match_id?: string }) => {
      if (payload?.match_id && payload.match_id !== caseData.match_id) return;
      void refreshCase().catch(() => undefined);
    });
    const poll = setInterval(() => {
      void refreshCase().catch(() => undefined);
    }, 8_000);
    return () => {
      clearInterval(poll);
      socket.close();
    };
  }, [caseData.case_id, caseData.match_id]);

  async function refreshCase() {
    const response = await fetch(`${API_BASE_URL}/cases/${caseData.case_id}`, { credentials: "include", cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as OverwatchCaseDetail;
    setCaseData(payload);
  }

  async function vote(voteValue: "cheating" | "insufficient_evidence" | "not_cheating") {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/cases/vote`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case_id: caseData.case_id, vote: voteValue })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "VOTE_FAILED");
      setStatus("Vote submitted.");
      await refreshCase();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function adminAction(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {})
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "ADMIN_ACTION_FAILED");
      setStatus("Admin action completed.");
      await refreshCase();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Overwatch Case Review</h1>
        <p className="mt-1 text-sm text-white/70">Case {caseData.case_id}</p>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Reported Player</p>
            <p className="mt-2 font-semibold">{caseData.reported_player_name}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Reports</p>
            <p className="mt-2 font-semibold">{caseData.reports_count}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Match ID</p>
            <p className="mt-2 truncate font-mono text-xs">{caseData.match_id}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Map</p>
            <p className="mt-2 font-semibold">{prettyMapName(caseData.map)}</p>
          </div>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Demo Player POV</h2>
        <div className="mt-3 space-y-3">
          {caseData.demo_url ? (
            <video ref={videoRef} className="w-full rounded-xl border border-white/10 bg-black/40" controls preload="metadata" src={caseData.demo_url} />
          ) : (
            <p className="text-sm text-white/70">No POV video available. Use demo link / spectate command.</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => setPlaybackRate(0.5)}>0.5x</button>
            <button type="button" className="btn-secondary" onClick={() => setPlaybackRate(1)}>1x</button>
            <button type="button" className="btn-secondary" onClick={() => setPlaybackRate(1.5)}>1.5x</button>
            <span className="text-xs text-white/65">Current slow motion: {playbackRate}x</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => setSelectedRound(null)}>All Rounds</button>
            {rounds.slice(0, 20).map((round) => (
              <button key={round} type="button" className="btn-secondary" onClick={() => setSelectedRound(round)}>
                Round {round}
              </button>
            ))}
          </div>

          {caseData.demo_url && (
            <a href={caseData.demo_url} target="_blank" rel="noreferrer" className="inline-flex text-sm text-brand hover:underline">
              Open Demo File
            </a>
          )}
          {caseData.spectate_command && <code className="block rounded bg-black/30 px-3 py-2 text-xs text-white/80">{caseData.spectate_command}</code>}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Consensus</h2>
        <p className="mt-1 text-sm text-white/70">
          {caseData.consensus.required} / {caseData.consensus.max_votes} votes required.
        </p>
        <div className="mt-3 h-2 w-full overflow-hidden rounded bg-white/10">
          <div className="h-full bg-brand" style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="mt-2 text-xs text-white/70">
          Total votes: {caseData.consensus.total_votes} | Cheating: {caseData.consensus.cheating_votes} | Clean: {caseData.consensus.clean_votes}
        </p>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Verdict</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn bg-red-600 hover:bg-red-500" disabled={busy} onClick={() => void vote("cheating")}>Cheating</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void vote("insufficient_evidence")}>Insufficient Evidence</button>
          <button type="button" className="btn bg-emerald-600 hover:bg-emerald-500" disabled={busy} onClick={() => void vote("not_cheating")}>Not Cheating</button>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Match Timeline</h2>
        <div className="mt-3 max-h-96 space-y-2 overflow-auto pr-1">
          {visibleTimeline.map((event) => (
            <div key={event.id} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
              <p className="font-medium">{event.event_type.replace(/_/g, " ")}</p>
              <p className="text-xs text-white/60">{new Date(event.created_at).toLocaleString()}</p>
            </div>
          ))}
          {visibleTimeline.length === 0 && <p className="text-sm text-white/70">No events for selected round.</p>}
        </div>
      </section>

      {canAdminTools && (
        <section className="card p-6">
          <h2 className="text-lg font-semibold">Admin Tools</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn bg-red-700 hover:bg-red-600" disabled={busy} onClick={() => void adminAction(`/cases/${caseData.case_id}/force-verdict`, { verdict: "cheating" })}>
              Force Verdict: Cheating
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void adminAction(`/cases/${caseData.case_id}/force-verdict`, { verdict: "insufficient_evidence" })}>
              Force Verdict: Insufficient
            </button>
            <button type="button" className="btn bg-emerald-700 hover:bg-emerald-600" disabled={busy} onClick={() => void adminAction(`/cases/${caseData.case_id}/force-verdict`, { verdict: "not_cheating" })}>
              Force Verdict: Not Cheating
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void adminAction(`/cases/${caseData.case_id}/reopen`)}>
              Reopen Case
            </button>
            <button type="button" className="btn bg-orange-700 hover:bg-orange-600" disabled={busy} onClick={() => void adminAction(`/cases/${caseData.case_id}/remove-false-ban`)}>
              Remove False Ban
            </button>
          </div>
        </section>
      )}

      {status && <p className="text-sm text-white/75">{status}</p>}
    </div>
  );
}
