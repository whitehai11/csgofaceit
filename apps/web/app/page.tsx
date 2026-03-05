import { apiFetch } from "@/lib/api";
import { LandingPage } from "@/components/LandingPage";

type Stats = {
  live_matches: number;
  servers_online: number;
  players_online: number;
  players_queued: number;
};

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const stats = await apiFetch<Stats>("/stats").catch(() => ({ live_matches: 0, servers_online: 0, players_online: 0, players_queued: 0 }));
  const discordUrl = process.env.NEXT_PUBLIC_DISCORD_URL ?? "https://discord.gg/fraghub";

  return (
    <LandingPage
      stats={{
        liveMatches: stats.live_matches,
        serversOnline: stats.servers_online,
        playersOnline: stats.players_online
      }}
      discordUrl={discordUrl}
    />
  );
}
