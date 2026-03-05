import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";
import { OverwatchReviewClient } from "@/components/OverwatchReviewClient";

type UserPayload = {
  authenticated: boolean;
  user?: { role?: string };
};

type OverwatchCaseDetail = {
  case_id: string;
  player_id: string;
  reported_player_name: string;
  reported_player_steam_id?: string;
  match_id: string;
  map: string;
  match_status: string;
  match_created_at?: string;
  reports_count: number;
  reports?: unknown;
  demo_url?: string | null;
  spectate_command?: string | null;
  status: string;
  consensus: {
    required: number;
    max_votes: number;
    total_votes: number;
    cheating_votes: number;
    clean_votes: number;
  };
  votes: Array<{ case_id: string; moderator_id: string; vote: string; created_at: string; reviewer_name?: string | null }>;
};

type TimelineResponse = {
  events: Array<{ id: string; event_type: string; payload: Record<string, unknown> | null; created_at: string }>;
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

export default async function OverwatchCasePage({ params }: { params: { id: string } }) {
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

  const caseRes = await fetch(`${API_BASE_URL}/cases/${params.id}`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);
  if (!caseRes || !caseRes.ok) return <div className="card p-6">Case not found.</div>;

  const caseData = (await caseRes.json()) as OverwatchCaseDetail;

  const timelineRes = await fetch(`${API_BASE_URL}/match/${caseData.match_id}/timeline`, { cache: "no-store" }).catch(() => null);
  const timeline = timelineRes && timelineRes.ok ? ((await timelineRes.json()) as TimelineResponse).events : [];

  return <OverwatchReviewClient initialCase={caseData} initialTimeline={timeline} canAdminTools={canAdmin(role)} />;
}

