"use client";

import { useState } from "react";
import { API_BASE_URL } from "@/lib/config";

const REASONS = [
  { id: "cheating", label: "Cheating" },
  { id: "griefing", label: "Griefing" },
  { id: "abusive_chat", label: "Abusive Chat" }
] as const;

export function ReportPlayerButton({
  matchId,
  playerId,
  playerName
}: {
  matchId: string;
  playerId: string;
  playerName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]["id"]>("cheating");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState("");

  async function submitReport() {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/report`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ match_id: matchId, player_id: playerId, reason, comment: comment.trim() || undefined })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "REPORT_FAILED");
      setStatus("Report submitted successfully.");
      setComment("");
      setOpen(false);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" className="btn-secondary" onClick={() => setOpen((prev) => !prev)}>
        Report Player
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-panel p-5 shadow-2xl">
            <h3 className="text-lg font-semibold">Report Player</h3>
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/60">Player Name</p>
                <p className="mt-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/90">{playerName ?? "Unknown Player"}</p>
              </div>
              <label className="block text-sm text-white/80">
                Reason
                <select
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm"
                  value={reason}
                  onChange={(event) => setReason(event.target.value as (typeof REASONS)[number]["id"])}
                >
                  {REASONS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-white/80">
                Optional Comment
                <textarea
                  className="mt-1 min-h-24 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Add context for the Overwatch team..."
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn bg-red-600 hover:bg-red-500" onClick={() => void submitReport()} disabled={busy}>
                {busy ? "Submitting..." : "Submit Report"}
              </button>
            </div>
          </div>
        </div>
      )}
      {status && <span className="text-xs text-white/70">{status}</span>}
    </div>
  );
}
