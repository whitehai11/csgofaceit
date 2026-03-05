"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/config";

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

function prettyMapName(raw: string): string {
  return raw.replace(/^de_/, "").replace(/_/g, " ").replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());
}

function titleFor(item: HighlightItem): string {
  if (item.event_type === "ace") return `Ace by ${item.player_name}`;
  if (item.event_type === "4k") return `4K by ${item.player_name}`;
  if (item.event_type === "clutch_1v3") return `Clutch 1v3 by ${item.player_name}`;
  if (item.event_type === "noscope_kill") return `Noscope by ${item.player_name}`;
  return `Highlight by ${item.player_name}`;
}

export function HighlightsPageClient({ initial }: { initial: HighlightItem[] }) {
  const [items, setItems] = useState<HighlightItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    match_id: "",
    event_type: "4k",
    clip_url: "",
    round_number: "",
    timestamp_seconds: "",
    title: ""
  });

  async function refresh() {
    const response = await fetch(`${API_BASE_URL}/highlights?limit=40`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as HighlightItem[];
    setItems(payload);
  }

  useEffect(() => {
    const poll = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 12_000);
    return () => clearInterval(poll);
  }, []);

  async function upload() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/highlights/upload`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          match_id: form.match_id.trim(),
          event_type: form.event_type,
          clip_url: form.clip_url.trim(),
          round_number: form.round_number ? Number(form.round_number) : undefined,
          timestamp_seconds: form.timestamp_seconds ? Number(form.timestamp_seconds) : undefined,
          title: form.title.trim() || undefined
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "UPLOAD_FAILED");
      setMessage("Highlight uploaded successfully.");
      setForm((prev) => ({ ...prev, clip_url: "", round_number: "", timestamp_seconds: "", title: "" }));
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ordered = useMemo(
    () => [...items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [items]
  );

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h2 className="text-xl font-semibold">Upload Highlight</h2>
        <p className="mt-1 text-sm text-white/70">Upload your best plays to create shareable FragHub content.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <input
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm"
            placeholder="Match ID (UUID)"
            value={form.match_id}
            onChange={(e) => setForm((s) => ({ ...s, match_id: e.target.value }))}
          />
          <select
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm"
            value={form.event_type}
            onChange={(e) => setForm((s) => ({ ...s, event_type: e.target.value }))}
          >
            <option value="ace">Ace</option>
            <option value="4k">4K</option>
            <option value="clutch_1v3">Clutch 1v3</option>
            <option value="noscope_kill">Noscope</option>
          </select>
          <input
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm md:col-span-2"
            placeholder="Clip URL (https://...)"
            value={form.clip_url}
            onChange={(e) => setForm((s) => ({ ...s, clip_url: e.target.value }))}
          />
          <input
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm"
            placeholder="Round Number (optional)"
            value={form.round_number}
            onChange={(e) => setForm((s) => ({ ...s, round_number: e.target.value }))}
          />
          <input
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm"
            placeholder="Timestamp seconds (optional)"
            value={form.timestamp_seconds}
            onChange={(e) => setForm((s) => ({ ...s, timestamp_seconds: e.target.value }))}
          />
          <input
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm md:col-span-2"
            placeholder="Title (optional)"
            value={form.title}
            onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
          />
        </div>
        <button type="button" className="btn-primary mt-4" onClick={() => void upload()} disabled={busy}>
          {busy ? "Uploading..." : "Upload Highlight"}
        </button>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {ordered.map((item) => (
          <article key={item.id} className="card p-4">
            <h3 className="text-lg font-semibold">{titleFor(item)}</h3>
            <p className="mt-1 text-sm text-white/70">Map: {prettyMapName(item.map)}</p>
            <p className="text-xs text-white/60">Rank: {item.player_rank}</p>
            <div className="mt-3">
              {item.clip_url ? (
                <video controls preload="metadata" className="h-56 w-full rounded-lg border border-white/10 bg-black/40" src={item.clip_url} />
              ) : (
                <p className="text-sm text-white/65">No clip URL available.</p>
              )}
            </div>
            {item.clip_url && (
              <a href={item.clip_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-xs text-brand hover:underline">
                Open clip in new tab
              </a>
            )}
          </article>
        ))}
        {ordered.length === 0 && <div className="card p-6 text-sm text-white/70">No highlights uploaded yet.</div>}
      </section>

      {message && <p className="text-sm text-white/75">{message}</p>}
    </div>
  );
}

