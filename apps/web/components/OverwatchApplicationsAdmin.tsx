"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/config";

type OverwatchApplication = {
  id: string;
  player_id: string;
  steam_id: string;
  display_name: string;
  player_rank: string;
  fraghub_username: string;
  motivation: string;
  moderation_experience: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at?: string | null;
  rejection_reason?: string | null;
};

export function OverwatchApplicationsAdmin() {
  const [applications, setApplications] = useState<OverwatchApplication[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/overwatch/applications`, { credentials: "include", cache: "no-store" });
      const payload = (await response.json().catch(() => [])) as OverwatchApplication[] | { error?: string };
      if (!response.ok) {
        setError((payload as { error?: string }).error ?? "APPLICATIONS_LOAD_FAILED");
        return;
      }
      setApplications(Array.isArray(payload) ? payload : []);
    } catch {
      setError("APPLICATIONS_LOAD_FAILED");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function approve(id: string) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/overwatch/applications/${id}/approve`, {
        method: "POST",
        credentials: "include"
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? "APPLICATION_APPROVE_FAILED");
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/overwatch/applications/${id}/reject`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Requirements or fit not met" })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? "APPLICATION_REJECT_FAILED");
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-xl font-semibold">Overwatch Applications</h2>
      <div className="mt-4 space-y-3">
        {applications.map((app) => (
          <div key={app.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{app.display_name} ({app.fraghub_username})</p>
              <span className="text-xs text-white/70">{new Date(app.created_at).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-xs text-white/65">Rank: {app.player_rank} | Steam: {app.steam_id}</p>
            <p className="mt-3 text-sm text-white/80"><span className="font-semibold">Motivation:</span> {app.motivation}</p>
            <p className="mt-2 text-sm text-white/80"><span className="font-semibold">Experience:</span> {app.moderation_experience}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn bg-emerald-600 hover:bg-emerald-500" disabled={busyId === app.id || app.status !== "pending"} onClick={() => void approve(app.id)}>
                Approve
              </button>
              <button type="button" className="btn bg-red-600 hover:bg-red-500" disabled={busyId === app.id || app.status !== "pending"} onClick={() => void reject(app.id)}>
                Reject
              </button>
              <span className="self-center text-xs text-white/70">Status: {app.status}</span>
            </div>
          </div>
        ))}
        {applications.length === 0 && <p className="text-sm text-white/70">No applications found.</p>}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
