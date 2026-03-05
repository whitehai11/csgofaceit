import { HighlightsPageClient } from "@/components/HighlightsPageClient";
import { apiFetch } from "@/lib/api";

type HighlightItem = {
  id: string;
  match_id: string;
  player_id: string;
  player_name: string;
  player_rank: string;
  map: string;
  event_type: string;
  round_number: number | null;
  timestamp_seconds: number;
  clip_url: string | null;
  demo_url: string | null;
  created_at: string;
};

export const dynamic = "force-dynamic";

export default async function HighlightsPage() {
  const highlights = await apiFetch<HighlightItem[]>("/highlights?limit=40").catch(() => []);
  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Highlights</h1>
        <p className="mt-1 text-sm text-white/70">Watch top plays and upload your own best clips.</p>
      </section>
      <HighlightsPageClient initial={highlights} />
    </div>
  );
}

