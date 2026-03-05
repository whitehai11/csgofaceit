import { QueuePanel } from "@/components/QueuePanel";

export const dynamic = "force-dynamic";

export default function PlayPage() {
  return (
    <div className="space-y-6">
      <section className="card p-6">
        <h1 className="text-2xl font-bold">Play</h1>
        <p className="mt-1 text-sm text-white/70">Join the web queue and get redirected to your match lobby once a match is found.</p>
      </section>
      <QueuePanel redirectOnMatchFound />
    </div>
  );
}

