"use client";

import Link from "next/link";
import { motion } from "framer-motion";

type LandingStats = {
  liveMatches: number;
  serversOnline: number;
  playersOnline: number;
};

type LandingPageProps = {
  stats: LandingStats;
  discordUrl: string;
};

const features = [
  "Fair Matchmaking",
  "Overwatch Anti-Cheat",
  "Clan Wars",
  "Creator Rewards",
  "Skin Drops"
];

const steps = ["Join FragHub", "Connect Steam", "Queue for a match", "Play competitive games"];

export function LandingPage({ stats, discordUrl }: LandingPageProps) {
  return (
    <div className="space-y-8">
      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0 }}
        className="card overflow-hidden p-8 md:p-12"
      >
        <p className="text-xs uppercase tracking-[0.35em] text-white/60">Competitive CS:GO</p>
        <h1 className="mt-4 text-5xl font-black tracking-tight md:text-6xl">FragHub</h1>
        <h2 className="mt-3 text-xl text-white/90 md:text-2xl">Competitive CS:GO matchmaking</h2>
        <p className="mt-5 max-w-3xl text-sm leading-7 text-white/75 md:text-base">
          Play fair matches with active moderation, overwatch, and a competitive ranking system.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/dashboard" className="btn-primary">
            Play Now
          </Link>
          <a href={discordUrl} className="btn-secondary" target="_blank" rel="noreferrer">
            Join Discord
          </a>
        </div>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.08 }}
        className="card p-6 md:p-8"
      >
        <p className="text-xs uppercase tracking-[0.28em] text-white/60">Live Stats</p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/25 p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-white/55">Live Matches</p>
            <p className="mt-3 text-3xl font-bold">{stats.liveMatches}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-white/55">Servers Online</p>
            <p className="mt-3 text-3xl font-bold">{stats.serversOnline}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-white/55">Players Online</p>
            <p className="mt-3 text-3xl font-bold">{stats.playersOnline}</p>
          </div>
        </div>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.16 }}
        className="card p-6 md:p-8"
      >
        <p className="text-xs uppercase tracking-[0.28em] text-white/60">Features</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {features.map((feature) => (
            <div key={feature} className="rounded-xl border border-white/10 bg-black/25 p-4 text-sm font-medium text-white/90">
              {feature}
            </div>
          ))}
        </div>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.24 }}
        className="card p-6 md:p-8"
      >
        <p className="text-xs uppercase tracking-[0.28em] text-white/60">How It Works</p>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {steps.map((step, index) => (
            <div key={step} className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand/90">{index + 1}</p>
              <p className="mt-3 text-sm text-white/90">{step}</p>
            </div>
          ))}
        </div>
      </motion.section>

      <motion.footer
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.3 }}
        className="card p-5"
      >
        <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-white/70">
          <a href={discordUrl} target="_blank" rel="noreferrer" className="hover:text-white">
            Discord
          </a>
          <a href="https://twitter.com" target="_blank" rel="noreferrer" className="hover:text-white">
            Twitter
          </a>
          <Link href="/terms" className="hover:text-white">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-white">
            Privacy
          </Link>
        </div>
      </motion.footer>
    </div>
  );
}
