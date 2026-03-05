"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/config";

type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

type NotificationsResponse = {
  success: boolean;
  unread_count: number;
  notifications: NotificationItem[];
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/notifications?limit=20`, {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      });
      if (!response.ok) {
        setItems([]);
        setUnreadCount(0);
        return;
      }
      const payload = (await response.json()) as NotificationsResponse;
      setItems(payload.notifications ?? []);
      setUnreadCount(Number(payload.unread_count ?? 0));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const socket: Socket = io(API_BASE_URL, { transports: ["websocket"] });
    socket.on("notification:new", () => {
      void load();
    });
    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const markOne = async (id: string) => {
    await fetch(`${API_BASE_URL}/notifications/${encodeURIComponent(id)}/read`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" }
    }).catch(() => null);
    await load();
  };

  const markAll = async () => {
    await fetch(`${API_BASE_URL}/notifications/read-all`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" }
    }).catch(() => null);
    await load();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="relative rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white hover:bg-white/10"
        onClick={() => setOpen((state) => !state)}
        aria-label="Notifications"
      >
        🔔
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-brand px-1 text-center text-[11px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-96 rounded-xl border border-white/10 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Notifications</p>
            <button
              type="button"
              className="text-xs text-white/70 hover:text-white"
              onClick={() => void markAll()}
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {loading ? <div className="text-xs text-white/60">Loading...</div> : null}
            {!loading && !items.length ? <div className="text-xs text-white/60">No notifications yet.</div> : null}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  item.read_at ? "border-white/10 bg-white/0" : "border-brand/40 bg-brand/10"
                }`}
                onClick={() => void markOne(item.id)}
              >
                <p className="text-sm font-medium text-white">{item.title}</p>
                <p className="mt-1 text-xs text-white/70">{item.message}</p>
                <p className="mt-1 text-[11px] text-white/50">{formatTime(item.created_at)}</p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
