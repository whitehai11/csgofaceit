import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";
import { OverwatchApplyForm } from "@/components/OverwatchApplyForm";

type UserPayload = {
  authenticated: boolean;
  user?: { role?: string };
};

export const dynamic = "force-dynamic";

export default async function OverwatchApplyPage() {
  const session = cookies().get("session")?.value;
  if (!session) return <div className="card p-6">Login required to apply.</div>;

  const authRes = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);
  if (!authRes || !authRes.ok) return <div className="card p-6">Login required to apply.</div>;

  const auth = (await authRes.json()) as UserPayload;
  const role = String(auth.user?.role ?? "player").toLowerCase();
  if (["owner", "admin", "moderator", "overwatch"].includes(role)) {
    return <div className="card p-6">Your account already has elevated moderation permissions.</div>;
  }

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">FragHub Overwatch</h1>
        <p className="mt-1 text-sm text-white/70">Help keep the platform fair by reviewing suspicious matches.</p>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-semibold">Requirements</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-white/80">
          <li>Minimum Rank: Master Guardian I or higher</li>
          <li>Minimum Matches: 100 FragHub matches</li>
          <li>Account Age: 30 days</li>
          <li>No bans on record</li>
        </ul>
      </section>

      <section className="card p-6">
        <h2 className="text-xl font-semibold">Responsibilities</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-white/80">
          <li>Review suspicious matches</li>
          <li>Watch demos</li>
          <li>Vote on cheating cases</li>
          <li>Help moderators keep games fair</li>
        </ul>
      </section>

      <OverwatchApplyForm />
    </div>
  );
}
