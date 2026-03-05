import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";
import { RankBadge } from "@/components/RankBadge";
import { ReportPlayerButton } from "@/components/ReportPlayerButton";

type AuthResponse = {
  authenticated: boolean;
  user?: { steamId?: string };
};

type ProfileResponse = {
  player: {
    id: string;
    steam_id: string;
    display_name: string;
    username?: string | null;
    avatar_url?: string | null;
    player_rank?: string | null;
  };
  stats: {
    matches_played: number;
    wins: number;
    losses: number;
  };
  performance?: {
    winrate?: number;
    kd_ratio?: number;
    headshot_percentage?: number;
  };
  match_history?: Array<{
    match_id: string;
    result: "Win" | "Loss";
    map: string;
    score: string;
    status: string;
    created_at: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function PublicProfilePage({ params }: { params: { steamId: string } }) {
  const profileRes = await fetch(`${API_BASE_URL}/users/${encodeURIComponent(params.steamId)}/profile`, { cache: "no-store" }).catch(() => null);
  if (!profileRes || !profileRes.ok) {
    return <div className="card p-6">Profile not found.</div>;
  }
  const profile = (await profileRes.json()) as ProfileResponse;

  const session = cookies().get("session")?.value;
  let viewerSteamId = "";
  if (session) {
    const authRes = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Cookie: `session=${encodeURIComponent(session)}` },
      cache: "no-store"
    }).catch(() => null);
    if (authRes && authRes.ok) {
      const authPayload = (await authRes.json()) as AuthResponse;
      viewerSteamId = String(authPayload.user?.steamId ?? "");
    }
  }

  const player = profile.player;
  const matchesPlayed = Number(profile.stats?.matches_played ?? 0);
  const wins = Number(profile.stats?.wins ?? 0);
  const losses = Number(profile.stats?.losses ?? 0);
  const winrate = Number(profile.performance?.winrate ?? (matchesPlayed > 0 ? (wins / matchesPlayed) * 100 : 0));
  const kdRatio = Number(profile.performance?.kd_ratio ?? 0);
  const hs = Number(profile.performance?.headshot_percentage ?? 0);
  const history = Array.isArray(profile.match_history) ? profile.match_history : [];

  const initial = String(player.display_name ?? "P").slice(0, 1).toUpperCase();
  const latestMatchId = history[0]?.match_id ?? null;
  const canReport = viewerSteamId.length > 0 && viewerSteamId !== String(player.steam_id ?? "") && Boolean(latestMatchId);

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Player Profile</h1>
        <div className="mt-4 flex items-center gap-4">
          {player.avatar_url ? (
            <img src={player.avatar_url} alt="Avatar" className="h-16 w-16 rounded-full border border-white/20 object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-white/5 text-xl font-bold">{initial}</div>
          )}
          <div>
            <p className="text-lg font-semibold">{player.username ?? player.display_name}</p>
            <div className="mt-1">
              <RankBadge rank={player.player_rank ?? "Unranked"} />
            </div>
            {canReport && latestMatchId && (
              <div className="mt-3">
                <ReportPlayerButton matchId={latestMatchId} playerId={player.id} playerName={player.username ?? player.display_name} />
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-bold">Stats</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs text-white/60">Matches Played</p><p className="mt-2 text-xl font-semibold">{matchesPlayed}</p></div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs text-white/60">Wins</p><p className="mt-2 text-xl font-semibold">{wins}</p></div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs text-white/60">Losses</p><p className="mt-2 text-xl font-semibold">{losses}</p></div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs text-white/60">Winrate</p><p className="mt-2 text-xl font-semibold">{winrate.toFixed(0)}%</p></div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs text-white/60">K/D Ratio</p><p className="mt-2 text-xl font-semibold">{kdRatio.toFixed(2)}</p></div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs text-white/60">Headshot Percentage</p><p className="mt-2 text-xl font-semibold">{hs.toFixed(0)}%</p></div>
        </div>
      </section>
    </div>
  );
}

