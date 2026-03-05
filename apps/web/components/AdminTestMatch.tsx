"use client";

import { useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/config";

export function AdminTestMatch() {
  const [mode, setMode] = useState("ranked");
  const [map, setMap] = useState("de_mirage");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ match_id: string; connect_command: string; server?: { id: string } } | null>(null);
  const [error, setError] = useState("");

  const copyCmd = useMemo(() => result?.connect_command ?? "", [result]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE_URL}/admin/testmatch/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode, map })
      });
      const data = (await res.json()) as { error?: string; match_id?: string; connect_command?: string; server?: { id: string } };
      if (!res.ok) throw new Error(data.error ?? "TESTMATCH_START_FAILED");
      setResult({ match_id: String(data.match_id), connect_command: String(data.connect_command), server: data.server });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE_URL}/admin/testmatch/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ match_id: result.match_id, server_id: result.server?.id })
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "TESTMATCH_STOP_FAILED");
      setResult(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-xl font-semibold">Test Match Tool</h2>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          Mode
          <select className="mt-1 w-full rounded-lg bg-white/10 p-2" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="ranked">5v5</option>
            <option value="wingman">2v2</option>
            <option value="casual">10v10</option>
          </select>
        </label>
        <label className="text-sm">
          Map
          <input className="mt-1 w-full rounded-lg bg-white/10 p-2" value={map} onChange={(e) => setMap(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn-primary" type="button" disabled={busy} onClick={() => void start()}>
          Start Test Match
        </button>
        <button className="btn bg-red-600 hover:bg-red-500" type="button" disabled={busy || !result} onClick={() => void stop()}>
          Stop Test Match
        </button>
      </div>
      {result && (
        <div className="mt-4 rounded-lg border border-brand/40 bg-brand/10 p-3 text-sm">
          <p className="font-semibold">Test Match Ready</p>
          <p className="mt-1">Match ID: {result.match_id}</p>
          <p className="mt-1 font-mono text-xs text-white/80">{result.connect_command}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn-secondary" type="button" onClick={() => void navigator.clipboard.writeText(copyCmd)}>
              Copy connect command
            </button>
            <a href={`/match/${result.match_id}`} className="btn-secondary">
              Open match page
            </a>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-red-400">{error}</p>}
    </div>
  );
}
