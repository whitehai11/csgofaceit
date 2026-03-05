import { AdminTestMatch } from "@/components/AdminTestMatch";
import { AdminOpsPanel } from "@/components/AdminOpsPanel";
import { OverwatchApplicationsAdmin } from "@/components/OverwatchApplicationsAdmin";
import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = cookies().get("session")?.value;
  if (!session) {
    return <div className="card p-6">Admin access requires login.</div>;
  }
  const authRes = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);
  if (!authRes || !authRes.ok) {
    return <div className="card p-6">Admin access requires login.</div>;
  }
  const payload = (await authRes.json()) as { user?: { role?: string } };
  const role = String(payload.user?.role ?? "player").toLowerCase();
  if (!["owner", "admin", "moderator"].includes(role)) {
    return <div className="card p-6">Forbidden.</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin Panel</h1>
      <p className="text-sm text-white/70">Server monitor, live queues, moderation and real test matches.</p>
      <AdminOpsPanel />
      <OverwatchApplicationsAdmin />
      <AdminTestMatch />
    </div>
  );
}
