import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";
import { OverwatchCaseQueueClient } from "@/components/OverwatchCaseQueueClient";

type UserPayload = {
  authenticated: boolean;
  user?: { role?: string };
};

type OverwatchCase = {
  case_id: string;
  player_id: string;
  reported_player_name?: string;
  match_id: string;
  map?: string;
  reports_count?: number;
  status: string;
  consensus?: {
    required: number;
    max_votes: number;
    total_votes: number;
    cheating_votes: number;
    clean_votes: number;
  };
};

export const dynamic = "force-dynamic";

function canAccess(role: string): boolean {
  const normalized = role.toLowerCase();
  return ["owner", "admin", "overwatch"].includes(normalized);
}

export default async function OverwatchPage() {
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

  const casesRes = await fetch(`${API_BASE_URL}/cases`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);

  const cases = casesRes && casesRes.ok ? ((await casesRes.json()) as OverwatchCase[]) : [];

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Overwatch Review Queue</h1>
        <p className="mt-1 text-sm text-white/70">Community anti-cheat case queue.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/overwatch/live" className="btn-primary inline-flex">
            Open Live Match Panel
          </a>
          <a href="/overwatch/apply" className="btn-secondary inline-flex">
            Apply for Overwatch Reviewer
          </a>
        </div>
      </section>

      <OverwatchCaseQueueClient initial={cases} />
    </div>
  );
}
