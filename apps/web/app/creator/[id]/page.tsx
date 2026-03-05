import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";
import { CreatorLobbyClient } from "@/components/CreatorLobbyClient";

type LobbyDetail = {
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
  status: string;
  match_id: string | null;
  server_id: string | null;
  created_at: string;
  players: Array<{
    player_id: string;
    steam_id: string;
    display_name: string;
    rank: string;
    joined_at: string;
  }>;
};

type AuthMe = {
  authenticated?: boolean;
  user?: {
    role?: string;
    playerId?: string;
    player_id?: string;
  };
};

export const dynamic = "force-dynamic";

export default async function CreatorLobbyPage({ params }: { params: { id: string } }) {
  const lobbyRes = await fetch(`${API_BASE_URL}/creator/lobbies/${params.id}`, { cache: "no-store" }).catch(() => null);
  if (!lobbyRes || !lobbyRes.ok) {
    return <div className="card p-6">Lobby not found.</div>;
  }
  const lobby = (await lobbyRes.json()) as LobbyDetail;

  const session = cookies().get("session")?.value;
  let canStart = false;
  if (session) {
    const authRes = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { Cookie: `session=${encodeURIComponent(session)}` },
      cache: "no-store"
    }).catch(() => null);
    if (authRes && authRes.ok) {
      const auth = (await authRes.json()) as AuthMe;
      const role = String(auth.user?.role ?? "player").toLowerCase();
      const playerId = String(auth.user?.playerId ?? auth.user?.player_id ?? "");
      canStart = ["owner", "admin", "moderator"].includes(role) || playerId === lobby.creator.player_id;
    }
  }

  return <CreatorLobbyClient initial={lobby} canStart={canStart} />;
}

