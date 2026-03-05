"use client";

import { useState } from "react";

export function MatchJoinButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" onClick={() => void copyCommand()} className="btn-primary">
      {copied ? "Copied" : "Join Server"}
    </button>
  );
}

