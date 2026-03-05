import { apiFetch } from "@/lib/api";
import { RankBadge } from "@/components/RankBadge";

type SeasonSummary = {
  season: {
    season_id: string;
    name: string;
    start_date: string;
    end_date: string;
    status: string;
  };
  total_ranked_players: number;
  reward_tiers: Array<{ tier: string; rewards: string[] }>;
  leaderboard: Array<{
    rank: number;
    steam_id: string;
    mmr: number;
    wins: number;
    matches: number;
    display_name?: string | null;
    player_rank?: string | null;
  }>;
};

export const dynamic = "force-dynamic";

function daysRemaining(endDate: string): number {
  const end = new Date(endDate).getTime();
  const now = Date.now();
  const diff = end - now;
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

export default async function SeasonPage() {
  const summary = await apiFetch<SeasonSummary>("/season/summary?limit=50").catch(() => null);
  if (!summary) return <div className="card p-6">Season data unavailable.</div>;

  const remaining = daysRemaining(summary.season.end_date);

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">{summary.season.name}</h1>
        <p className="mt-1 text-sm text-white/70">
          3-month competitive season. Days remaining: {remaining} | Ranked players: {summary.total_ranked_players}
        </p>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-semibold">Season Leaderboard</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-white/5 text-left text-white/65">
              <tr>
                <th className="px-3 py-2">Rank</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">MMR</th>
                <th className="px-3 py-2">Wins</th>
                <th className="px-3 py-2">Matches</th>
              </tr>
            </thead>
            <tbody>
              {summary.leaderboard.map((row) => (
                <tr key={`${row.steam_id}-${row.rank}`} className="border-t border-white/10">
                  <td className="px-3 py-2 font-semibold">{row.rank}</td>
                  <td className="px-3 py-2">{row.display_name ?? row.steam_id}</td>
                  <td className="px-3 py-2"><RankBadge rank={row.player_rank ?? "Unranked"} /></td>
                  <td className="px-3 py-2">{row.mmr}</td>
                  <td className="px-3 py-2">{row.wins}</td>
                  <td className="px-3 py-2">{row.matches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-semibold">Season Rewards</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {summary.reward_tiers.map((tier) => (
            <div key={tier.tier} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="font-semibold">{tier.tier}</p>
              <ul className="mt-2 space-y-1 text-sm text-white/75">
                {tier.rewards.map((reward) => (
                  <li key={`${tier.tier}-${reward}`}>• {reward}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

