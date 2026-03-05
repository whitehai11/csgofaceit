"use client";

import { motion } from "framer-motion";

export function StatCard(props: { label: string; value: number | string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card p-4"
    >
      <p className="text-xs uppercase tracking-wider text-white/60">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold">{props.value}</p>
    </motion.div>
  );
}
