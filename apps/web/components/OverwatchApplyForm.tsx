"use client";

import { useState } from "react";
import { API_BASE_URL } from "@/lib/config";

export function OverwatchApplyForm() {
  const [username, setUsername] = useState("");
  const [motivation, setMotivation] = useState("");
  const [experience, setExperience] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function submit() {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/overwatch/apply`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fraghub_username: username,
          motivation,
          moderation_experience: experience
        })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
        current?: { rank?: string; matches_played?: number; account_age_days?: number; bans_on_record?: number };
      };
      if (!response.ok) {
        if (payload.error === "OVERWATCH_REQUIREMENTS_NOT_MET") {
          const current = payload.current ?? {};
          throw new Error(
            `Requirements not met. Rank=${current.rank ?? "-"}, Matches=${current.matches_played ?? 0}, Age=${current.account_age_days ?? 0}d, Bans=${current.bans_on_record ?? 0}`
          );
        }
        throw new Error(payload.error ?? "APPLICATION_FAILED");
      }
      setStatus("Application submitted. Status: pending");
      setUsername("");
      setMotivation("");
      setExperience("");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-6">
      <h2 className="text-xl font-semibold">Application Form</h2>
      <div className="mt-4 space-y-3">
        <label className="block text-sm">
          FragHub Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm"
            placeholder="Your in-platform username"
          />
        </label>

        <label className="block text-sm">
          Why do you want to join Overwatch?
          <textarea
            value={motivation}
            onChange={(event) => setMotivation(event.target.value)}
            className="mt-1 min-h-24 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm"
            placeholder="Explain your motivation"
          />
        </label>

        <label className="block text-sm">
          Do you have previous moderation experience?
          <textarea
            value={experience}
            onChange={(event) => setExperience(event.target.value)}
            className="mt-1 min-h-20 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm"
            placeholder="Share past moderation work"
          />
        </label>
      </div>

      <button type="button" className="btn-primary mt-4" onClick={() => void submit()} disabled={busy || !username || !motivation || !experience}>
        {busy ? "Submitting..." : "Submit Application"}
      </button>

      {status && <p className="mt-3 text-sm text-white/75">{status}</p>}
    </section>
  );
}
