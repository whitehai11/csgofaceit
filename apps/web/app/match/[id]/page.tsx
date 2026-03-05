import Link from "next/link";
import { MatchTimeline } from "@/components/MatchTimeline";
import { RankBadge } from "@/components/RankBadge";
import { ReportPlayerButton } from "@/components/ReportPlayerButton";
import { apiFetch } from "@/lib/api";

type MatchPlayer = {
  team: "A" | "B";
  id: string;
  steam_id?: string;
  display_name: string;
  avatar_url?: string | null;
  player_rank: string;
};

type ScoreboardRow = {
  team: "A" | "B";
  player_id: string;
  steam_id?: string;
  display_name: string;
  avatar_url?: string | null;
  player_rank: string;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
};

type MatchResponse = {
  id: string;
  status: string;
  mode: string;
  map: string;
  team_a_score: number | null;
  team_b_score: number | null;
  created_at?: string;
  ended_at?: string | null;
  players: MatchPlayer[];
  scoreboard?: ScoreboardRow[];
  demo_url?: string | null;
  connection_data?: { server_ip?: string | null; port?: number | null };
};

type TimelineResponse = {
  events: Array<{ id: string; event_type: string; payload: Record<string, unknown> | null; created_at: string }>;
};

type HighlightItem = {
  id: string;
  event_type: string;
  round_number?: number | null;
  timestamp_seconds?: number | null;
  display_name?: string;
  clip_url?: string | null;
  demo_url?: string | null;
};

export const dynamic = "force-dynamic";

function regionFromServer(connectionData: MatchResponse["connection_data"]): string {
  if (connectionData?.server_ip) return "Frankfurt";
  return "Unknown";
}

function teamRows(rows: ScoreboardRow[] | undefined, team: "A" | "B", fallbackPlayers: MatchPlayer[]): ScoreboardRow[] {
  if (rows && rows.length > 0) {
    return rows.filter((row) => row.team === team).sort((a, b) => b.kills - a.kills);
  }
  return fallbackPlayers
    .filter((player) => player.team === team)
    .map((player) => ({
      team,
      player_id: player.id,
      steam_id: player.steam_id,
      display_name: player.display_name,
      avatar_url: player.avatar_url,
      player_rank: player.player_rank,
      kills: 0,
      deaths: 0,
      assists: 0,
      adr: 0
    }));
}

function prettyMapName(raw: string): string {
  return raw.replace(/^de_/, "").replace(/_/g, " ").replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());
}

export default async function MatchReviewPage({ params }: { params: { id: string } }) {
  const match = await apiFetch<MatchResponse>(`/matches/${params.id}`).catch(() => null);
  if (!match) return <div className="card p-6">Match not found.</div>;

  const [timeline, highlights] = await Promise.all([
    apiFetch<TimelineResponse>(`/match/${params.id}/timeline`).catch(() => ({ events: [] })),
    apiFetch<HighlightItem[]>(`/matches/${params.id}/highlights`).catch(() => [])
  ]);

  const teamA = teamRows(match.scoreboard, "A", match.players);
  const teamB = teamRows(match.scoreboard, "B", match.players);
  const dateText = new Date(match.ended_at ?? match.created_at ?? Date.now()).toLocaleString();
  const region = regionFromServer(match.connection_data);
  const score = `${Number(match.team_a_score ?? 0)} - ${Number(match.team_b_score ?? 0)}`;

  const isFinished = String(match.status).toLowerCase() === "finished";

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Match Review</h1>
            <p className="mt-1 text-sm text-white/70">Map: {prettyMapName(match.map)} | Score: {score}</p>
          </div>
          {!isFinished && (
            <Link href={`/match/${params.id}/lobby`} className="btn-secondary">
              Open Lobby
            </Link>
          )}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Map</p>
            <p className="mt-2 font-semibold">{prettyMapName(match.map)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Score</p>
            <p className="mt-2 text-xl font-black">{score}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Date</p>
            <p className="mt-2 text-sm font-medium">{dateText}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Region</p>
            <p className="mt-2 font-semibold">{region}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-semibold">Team A Scoreboard</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-white/5 text-left text-white/60">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">K</th>
                  <th className="px-3 py-2">D</th>
                  <th className="px-3 py-2">A</th>
                  <th className="px-3 py-2">ADR</th>
                  <th className="px-3 py-2">Report</th>
                </tr>
              </thead>
              <tbody>
                {teamA.map((row) => (
                  <tr key={row.player_id} className="border-t border-white/10">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/10 text-xs font-semibold">
                          {row.display_name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          {row.steam_id ? (
                            <a href={`/profile/${encodeURIComponent(row.steam_id)}`} className="font-medium hover:underline">
                              {row.display_name}
                            </a>
                          ) : (
                            <p className="font-medium">{row.display_name}</p>
                          )}
                          <div className="mt-1"><RankBadge rank={row.player_rank} /></div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">{row.kills}</td>
                    <td className="px-3 py-2">{row.deaths}</td>
                    <td className="px-3 py-2">{row.assists}</td>
                    <td className="px-3 py-2">{row.adr.toFixed(1)}</td>
                    <td className="px-3 py-2"><ReportPlayerButton matchId={match.id} playerId={row.player_id} playerName={row.display_name} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-semibold">Team B Scoreboard</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-white/5 text-left text-white/60">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">K</th>
                  <th className="px-3 py-2">D</th>
                  <th className="px-3 py-2">A</th>
                  <th className="px-3 py-2">ADR</th>
                  <th className="px-3 py-2">Report</th>
                </tr>
              </thead>
              <tbody>
                {teamB.map((row) => (
                  <tr key={row.player_id} className="border-t border-white/10">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/10 text-xs font-semibold">
                          {row.display_name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          {row.steam_id ? (
                            <a href={`/profile/${encodeURIComponent(row.steam_id)}`} className="font-medium hover:underline">
                              {row.display_name}
                            </a>
                          ) : (
                            <p className="font-medium">{row.display_name}</p>
                          )}
                          <div className="mt-1"><RankBadge rank={row.player_rank} /></div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">{row.kills}</td>
                    <td className="px-3 py-2">{row.deaths}</td>
                    <td className="px-3 py-2">{row.assists}</td>
                    <td className="px-3 py-2">{row.adr.toFixed(1)}</td>
                    <td className="px-3 py-2"><ReportPlayerButton matchId={match.id} playerId={row.player_id} playerName={row.display_name} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <MatchTimeline matchId={params.id} initial={timeline.events} />

        <section className="card p-4">
          <h2 className="text-lg font-semibold">Clip Highlights</h2>
          <div className="mt-3 space-y-2">
            {highlights.map((item) => {
              const label = `Round ${Number(item.round_number ?? 0)} ${String(item.event_type ?? "event")} by ${String(item.display_name ?? "Player")}`;
              const href = item.clip_url ?? item.demo_url ?? null;
              return (
                <div key={item.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-sm font-medium">{label}</p>
                  {href && (
                    <a className="mt-2 inline-flex text-xs text-brand hover:underline" href={href} target="_blank" rel="noreferrer">
                      Open highlight clip
                    </a>
                  )}
                </div>
              );
            })}
            {highlights.length === 0 && <p className="text-sm text-white/70">No highlights available.</p>}
          </div>
        </section>
      </div>

      <section className="card p-6">
        <h2 className="text-lg font-semibold">Demo Download</h2>
        {match.demo_url ? (
          <a href={match.demo_url} target="_blank" rel="noreferrer" className="btn-primary mt-3 inline-flex">
            Download Demo
          </a>
        ) : (
          <p className="mt-2 text-sm text-white/70">Demo file not available yet.</p>
        )}
      </section>
    </div>
  );
}
