import { MatchLobbyClient } from "@/components/MatchLobbyClient";
import { apiFetch } from "@/lib/api";

type LobbyMatch = {
  id: string;
  status: string;
  mode: string;
  map: string;
  created_at?: string;
  players: Array<{ id: string; display_name: string; player_rank: string; team: "A" | "B" }>;
  connection_data?: { server_ip?: string | null; port?: number | null };
};

export const dynamic = "force-dynamic";

export default async function MatchLobbyPage({ params }: { params: { id: string } }) {
  const match = await apiFetch<LobbyMatch>(`/matches/${params.id}`).catch(() => null);
  if (!match) {
    return <div className="card p-6">Match lobby not found.</div>;
  }

  return <MatchLobbyClient initial={match} />;
}
