import { cookies } from "next/headers";
import Link from "next/link";
import { API_BASE_URL } from "@/lib/config";
import { OverwatchLivePanelClient } from "@/components/OverwatchLivePanelClient";

type UserPayload = {
  authenticated: boolean;
  user?: { role?: string };
};

type LiveAlert = {
  alert_id: string;
  match_id: string;
  map: string;
  reports_count: number;
  players_count: number;
  suspect: {
    steam_id: string;
    player_id: string | null;
    name: string;
  };
  match_status: string;
  alert_status: string;
  case_id: string | null;
  score: number;
  created_at: string;
  spectate_command: string | null;
};

export const dynamic = "force-dynamic";

function canAccess(role: string): boolean {
  const normalized = role.toLowerCase();
  return ["owner", "admin", "overwatch"].includes(normalized);
}

function canAdmin(role: string): boolean {
  const normalized = role.toLowerCase();
  return ["owner", "admin"].includes(normalized);
}

export default async function OverwatchLivePage() {
  const session = cookies().get("session")?.value;
  if (!session) return <div className="card p-6">Overwatch access requires login.</div>;

  const authRes = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);
  if (!authRes || !authRes.ok) return <div className="card p-6">Overwatch access requires login.</div>;

  const auth = (await authRes.json()) as UserPayload;
  const role = String(auth.user?.role ?? "player");
  if (!canAccess(role)) return <div className="card p-6">Forbidden.</div>;

  const liveRes = await fetch(`${API_BASE_URL}/overwatch/live?min_reports=4&limit=100`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);
  const initial = liveRes && liveRes.ok ? ((await liveRes.json()) as LiveAlert[]) : [];

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Live Match Report Panel</h1>
        <p className="mt-1 text-sm text-white/70">Intervene in live matches with high cheating reports. Timeout only pauses and opens review, it does not auto-ban.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/overwatch" className="btn-secondary">
            Back to Cases
          </Link>
          <Link href="/overwatch/apply" className="btn-secondary">
            Overwatch Program
          </Link>
        </div>
      </section>

      <OverwatchLivePanelClient initial={initial} canAdminTools={canAdmin(role)} />
    </div>
  );
}

