import { apiFetch } from "@/lib/api";
import { RankBadge } from "@/components/RankBadge";

type ClanDetails = {
  clan: {
    clan_name: string;
    clan_tag: string;
    rating: number;
    wins: number;
    losses: number;
    matches_played: number;
    clan_rank?: number | null;
  };
  members: Array<{ steam_id: string; display_name: string; player_rank: string; role: string }>;
  history: Array<{
    match_id: string;
    created_at: string;
    clan_a_tag: string;
    clan_b_tag: string;
    clan_a_score: number;
    clan_b_score: number;
    winner_clan_tag: string | null;
  }>;
};

export const dynamic = "force-dynamic";

export default async function ClanDetailPage({ params }: { params: { tag: string } }) {
  const data = await apiFetch<ClanDetails>(`/clans/${params.tag}`).catch(() => null);
  if (!data) return <div className="card p-6">Clan not found.</div>;

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Clan info</h1>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Name</p>
            <p className="mt-2 font-semibold">{data.clan.clan_name}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Tag</p>
            <p className="mt-2 font-semibold">[{data.clan.clan_tag}]</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Members</p>
            <p className="mt-2 font-semibold">{data.members.length}</p>
          </div>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-bold">Stats</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Clan Rank</p>
            <p className="mt-2 text-xl font-semibold">#{data.clan.clan_rank ?? "-"}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">Matches Won</p>
            <p className="mt-2 text-xl font-semibold">{data.clan.wins}</p>
          </div>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-bold">Members</h2>
        <div className="mt-4 grid gap-2">
          {data.members.map((member) => (
            <div key={member.steam_id} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3">
              <div>
                <p>{member.display_name}</p>
                <p className="text-xs text-white/60">{member.role}</p>
              </div>
              <RankBadge rank={member.player_rank} />
            </div>
          ))}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-bold">Clan Matches</h2>
        <p className="mt-1 text-sm text-white/70">Recent clan wars</p>
        <div className="mt-4 space-y-2">
          {data.history.map((row) => (
            <div key={row.match_id} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {row.clan_a_tag} {row.clan_a_score}:{row.clan_b_score} {row.clan_b_tag}
                </span>
                <span className="text-white/70">Winner: {row.winner_clan_tag ?? "-"}</span>
              </div>
            </div>
          ))}
          {data.history.length === 0 && <p className="text-sm text-white/70">No clan war history yet.</p>}
        </div>
      </section>
    </div>
  );
}

