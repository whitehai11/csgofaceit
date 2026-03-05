import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import { NotificationBell } from "@/components/NotificationBell";

export const metadata: Metadata = {
  title: "FragHub",
  description: "FragHub Matchmaking Platform"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-white/10 bg-black/20 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-xl font-bold text-brand">
              FragHub
            </Link>
            <div className="flex items-center gap-3">
              <nav className="flex items-center gap-4 text-sm text-white/80">
                <a href="/play">Play</a>
                <a href="/status">Status</a>
                <a href="/season">Season</a>
                <a href="/skins">Skins</a>
                <a href="/inventory">Inventory</a>
                <a href="/fragbox">FragBox</a>
                <Link href="/dashboard">Dashboard</Link>
                <a href="/highlights">Highlights</a>
                <Link href="/leaderboard">Leaderboard</Link>
                <Link href="/clans">Clans</Link>
                <Link href="/overwatch">Overwatch</Link>
                <Link href="/admin">Admin</Link>
              </nav>
              <NotificationBell />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
