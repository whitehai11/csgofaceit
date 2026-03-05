import Link from "next/link";
import { apiFetch } from "@/lib/api";

type ClanItem = {
  clan_id: string;
  clan_name: string;
  clan_tag: string;
  rating: number;
  wins: number;
  losses: number;
  matches_played: number;
  members_count: number;
};

type ClansResponse = {
  items: ClanItem[];
};

export const dynamic = "force-dynamic";

export default async function ClansPage({ searchParams }: { searchParams: { q?: string } }) {
  const q = searchParams.q ? `&q=${encodeURIComponent(searchParams.q)}` : "";
  const data = await apiFetch<ClansResponse>(`/clans?page=1${q}`).catch(() => ({ items: [] }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Clan System</h1>
          <p className="mt-1 text-sm text-white/70">Each clan has its own page with stats and clan war history.</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((clan) => (
          <Link key={clan.clan_id} href={`/clan/${clan.clan_tag}`} className="card p-4 transition hover:border-brand/50">
            <p className="text-xs uppercase tracking-[0.2em] text-white/60">[{clan.clan_tag}]</p>
            <p className="mt-1 text-lg font-semibold">{clan.clan_name}</p>
            <p className="mt-3 text-sm text-white/75">Members: {clan.members_count}</p>
            <p className="text-sm text-white/75">Matches Won: {clan.wins}</p>
            <p className="text-sm text-white/75">Matches Played: {clan.matches_played}</p>
          </Link>
        ))}
      </div>
      {data.items.length === 0 && <div className="card p-5 text-sm text-white/70">No clans found.</div>}
    </div>
  );
}

