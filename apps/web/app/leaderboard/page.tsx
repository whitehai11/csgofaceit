import { RankBadge } from "@/components/RankBadge";
import { apiFetch } from "@/lib/api";

type LeaderItem = {
  position: number;
  steam_id: string;
  display_name: string;
  rank_tier?: string;
  rank?: string;
  matches: number;
  winrate: number;
};

type LeaderboardResponse = {
  mode: string;
  region: string | null;
  page: number;
  items: LeaderItem[];
};

const REGION_OPTIONS = ["global", "eu", "na", "sa", "asia"] as const;
const MODE_OPTIONS = ["ranked", "wingman"] as const;

export const dynamic = "force-dynamic";

function topRowClass(position: number): string {
  if (position === 1) return "bg-amber-500/15";
  if (position === 2) return "bg-slate-300/10";
  if (position === 3) return "bg-orange-700/15";
  return "";
}

function topMarker(position: number): string {
  if (position === 1) return "🥇";
  if (position === 2) return "🥈";
  if (position === 3) return "🥉";
  return `${position}`;
}

export default async function LeaderboardPage({
  searchParams
}: {
  searchParams: { mode?: string; page?: string; season?: string; region?: string };
}) {
  const mode = MODE_OPTIONS.includes((searchParams.mode ?? "ranked") as (typeof MODE_OPTIONS)[number])
    ? String(searchParams.mode)
    : "ranked";
  const region = REGION_OPTIONS.includes((searchParams.region ?? "global") as (typeof REGION_OPTIONS)[number])
    ? String(searchParams.region)
    : "global";
  const page = Number(searchParams.page ?? 1) || 1;
  const season = searchParams.season ? `&season=${encodeURIComponent(searchParams.season)}` : "";
  const data = await apiFetch<LeaderboardResponse>(`/leaderboard?mode=${mode}&region=${region}&page=${page}${season}`).catch(() => ({
    mode,
    region,
    page,
    items: []
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Global Leaderboard</h1>
          <p className="mt-1 text-sm text-white/70">Top FragHub players</p>
        </div>
        <form method="GET" className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-white/70">
            Region
            <select name="region" defaultValue={region} className="ml-2 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-sm">
              {REGION_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-white/70">
            Game Mode
            <select name="mode" defaultValue={mode} className="ml-2 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-sm">
              {MODE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button className="btn-primary" type="submit">
            Apply
          </button>
        </form>
      </div>

      <div className="card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5 text-left text-white/60">
            <tr>
              <th className="px-4 py-3">Rank</th>
              <th className="px-4 py-3">Player</th>
              <th className="px-4 py-3">Rank Tier</th>
              <th className="px-4 py-3">Matches</th>
              <th className="px-4 py-3">Winrate</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.steam_id} className={`border-t border-white/10 ${topRowClass(row.position)}`}>
                <td className="px-4 py-3 font-semibold">{topMarker(row.position)}</td>
                <td className="px-4 py-3">
                  {row.display_name}
                </td>
                <td className="px-4 py-3">
                  <RankBadge rank={row.rank_tier ?? row.rank ?? "Unranked"} />
                </td>
                <td className="px-4 py-3">{row.matches}</td>
                <td className="px-4 py-3">{Number(row.winrate ?? 0).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.items.length === 0 && <p className="p-4 text-sm text-white/70">No leaderboard data yet.</p>}
      </div>
    </div>
  );
}
