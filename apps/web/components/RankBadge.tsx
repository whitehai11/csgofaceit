"use client";

import { getRankIcon } from "@/lib/assets";

const RANK_THEMES: Array<{ match: RegExp; chip: string; dot: string; label: string }> = [
  { match: /silver/i, chip: "border-slate-400/40 bg-slate-300/10 text-slate-200", dot: "bg-slate-300", label: "SV" },
  { match: /gold|nova/i, chip: "border-amber-400/40 bg-amber-400/10 text-amber-200", dot: "bg-amber-300", label: "GN" },
  { match: /guardian|distinguished/i, chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200", dot: "bg-emerald-300", label: "MG" },
  { match: /eagle|legendary/i, chip: "border-sky-400/40 bg-sky-500/10 text-sky-200", dot: "bg-sky-300", label: "LE" },
  { match: /supreme/i, chip: "border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200", dot: "bg-fuchsia-300", label: "SM" },
  { match: /global/i, chip: "border-rose-400/50 bg-rose-500/15 text-rose-100", dot: "bg-rose-300", label: "GE" }
];

function resolveTheme(rank: string) {
  return RANK_THEMES.find((theme) => theme.match.test(rank)) ?? {
    chip: "border-brand/40 bg-brand/10 text-brand",
    dot: "bg-brand",
    label: "--"
  };
}

export function RankBadge({ rank }: { rank: string | null | undefined }) {
  const safe = (rank ?? "Unranked").toString().trim() || "Unranked";
  const theme = resolveTheme(safe);
  const icon = getRankIcon(safe);
  return (
    <span className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs font-semibold ${theme.chip}`}>
      <img src={icon} alt={safe} className="h-4 w-4 rounded-sm object-contain" onError={(event) => {
        (event.currentTarget as HTMLImageElement).src = "/assets/icons/rank_placeholder.svg";
      }} />
      <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded text-[10px] font-bold text-black/80 ${theme.dot}`}>
        {theme.label}
      </span>
      {safe}
    </span>
  );
}
