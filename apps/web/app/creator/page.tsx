import { CreatorLobbiesClient } from "@/components/CreatorLobbiesClient";
import { apiFetch } from "@/lib/api";

type CreatorLobby = {
  id: string;
  creator: {
    player_id: string;
    steam_id: string;
    name: string;
    rank: string;
  };
  mode: string;
  map_pool: string[];
  max_players: number;
  players_joined: number;
  status: string;
  match_id: string | null;
  server_id: string | null;
  created_at: string;
};

export const dynamic = "force-dynamic";

export default async function CreatorPage() {
  const lobbies = await apiFetch<CreatorLobby[]>("/creator/lobbies").catch(() => []);
  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Creator Match Lobbies</h1>
        <p className="mt-1 text-sm text-white/70">Creators can host community lobbies and start full FragHub matches with one click.</p>
      </section>
      <CreatorLobbiesClient initial={lobbies} />
    </div>
  );
}

