import { cookies } from "next/headers";
import { API_BASE_URL } from "@/lib/config";
import { SkinsLoadoutClient } from "@/components/SkinsLoadoutClient";

type AuthResponse = {
  authenticated: boolean;
  user?: { steamId?: string };
};

export const dynamic = "force-dynamic";

export default async function SkinsPage() {
  const session = cookies().get("session")?.value;
  if (!session) {
    return <div className="card p-6">Skins require login.</div>;
  }

  const authRes = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Cookie: `session=${encodeURIComponent(session)}` },
    cache: "no-store"
  }).catch(() => null);
  if (!authRes || !authRes.ok) {
    return <div className="card p-6">Skins require login.</div>;
  }

  const authPayload = (await authRes.json()) as AuthResponse;
  const steamId = String(authPayload.user?.steamId ?? "").trim();
  if (!steamId) {
    return <div className="card p-6">Could not resolve Steam account.</div>;
  }

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">FragHub Skin Changer</h1>
        <p className="mt-2 text-sm text-white/70">
          Select custom visual skins for FragHub servers. These skins are cosmetic only and only apply on FragHub.
        </p>
      </section>
      <SkinsLoadoutClient steamId={steamId} />
    </div>
  );
}
