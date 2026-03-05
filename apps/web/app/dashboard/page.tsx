import Link from "next/link";
import { LiveMatchGrid } from "@/components/LiveMatchGrid";
import { QueuePanel } from "@/components/QueuePanel";
import { apiFetch } from "@/lib/api";

type LiveMatch = {
  match_id: string;
  map: string;
  map_display?: string;
  mode?: string;
  team_a_score?: number;
  team_b_score?: number;
  server_ip?: string | null;
  server_port?: number | null;
  players: Array<{ id?: string; display_name?: string; team?: "A" | "B" }>;
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const live = await apiFetch<LiveMatch[]>("/matches/live").catch(() => []);

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
      <aside className="card h-fit p-4">
        <p className="text-xs uppercase tracking-[0.25em] text-white/55">Navigation</p>
        <nav className="mt-3 space-y-1">
          <Link href="/" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Home</Link>
          <a href="#queue" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Queue</a>
          <a href="#matches" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Matches</a>
          <a href="/creator" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Creator Lobbies</a>
          <Link href="/clans" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Clans</Link>
          <Link href="/leaderboard" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Leaderboard</Link>
          <Link href="/profile" className="block rounded-md px-3 py-2 text-sm text-white/80 hover:bg-white/10">Profile</Link>
        </nav>
      </aside>

      <section className="space-y-6">
        <div id="queue">
          <QueuePanel />
        </div>
        <div id="matches" className="space-y-3">
          <h1 className="text-2xl font-bold">Live Matches</h1>
          <LiveMatchGrid initial={live} />
        </div>
      </section>
    </div>
  );
}
