"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { API_BASE_URL } from "@/lib/config";
import { getSkinImage } from "@/lib/assets";

type BoxesResponse = {
  steam_id: string;
  unopened: number;
  opened: number;
  boxes: Array<{
    id: string;
    box_type: string;
    date_received: string;
    opened: boolean;
    opened_at: string | null;
    reward_id: string | null;
  }>;
};

type OpenBoxResponse = {
  ok: boolean;
  box_id: string;
  reward: {
    reward_id: string | null;
    reward_type: string;
    skin_name: string;
    rarity: string;
    image_url: string | null;
    box_type: string;
    season_id: string | null;
  };
  premium_battlepass_token: boolean;
  unopened_boxes: number;
};

type CatalogResponse = {
  categories: {
    primary: Array<{ weapon_name: string; skins: Array<{ skin_name: string; skin_id: string }> }>;
    pistol: Array<{ weapon_name: string; skins: Array<{ skin_name: string; skin_id: string }> }>;
    knife: Array<{ weapon_name: string; skins: Array<{ skin_name: string; skin_id: string }> }>;
    gloves: Array<{ weapon_name: string; skins: Array<{ skin_name: string; skin_id: string }> }>;
  };
};

const rarityGlow: Record<string, string> = {
  common: "from-white/20 to-white/5 border-white/20",
  rare: "from-sky-500/30 to-sky-900/20 border-sky-400/50",
  epic: "from-violet-500/35 to-violet-900/20 border-violet-400/60",
  legendary: "from-amber-500/35 to-amber-900/20 border-amber-400/60",
  mythic: "from-red-500/40 to-red-900/25 border-red-400/70"
};

function prettyRewardType(value: string): string {
  const key = value.toLowerCase();
  if (key === "weapon_skin" || key === "knife_skin" || key === "glove_skin" || key === "box_reward") return "Skin";
  if (key === "premium_battlepass_token") return "Battlepass Token";
  if (key === "profile_badge") return "Profile Badge";
  if (key === "special_title") return "Profile Badge";
  return value.replace(/_/g, " ");
}

export function FragBoxClient({ steamId }: { steamId: string }) {
  const [loading, setLoading] = useState(true);
  const [openInProgress, setOpenInProgress] = useState(false);
  const [boxes, setBoxes] = useState<BoxesResponse | null>(null);
  const [lastReward, setLastReward] = useState<OpenBoxResponse["reward"] | null>(null);
  const [status, setStatus] = useState("");
  const [rollingLabel, setRollingLabel] = useState("Opening FragBox...");
  const [equipping, setEquipping] = useState(false);
  const [weaponBySkinName, setWeaponBySkinName] = useState<Map<string, { weapon: string; skinId: string }>>(new Map());

  const loadBoxes = async () => {
    const response = await fetch(`${API_BASE_URL}/player/boxes/${encodeURIComponent(steamId)}`, {
      cache: "no-store",
      credentials: "include"
    });
    if (!response.ok) throw new Error("BOXES_FETCH_FAILED");
    const payload = (await response.json()) as BoxesResponse;
    setBoxes(payload);
  };

  const loadCatalog = async () => {
    const response = await fetch(`${API_BASE_URL}/skins/catalog`, {
      cache: "no-store",
      credentials: "include"
    });
    if (!response.ok) return;
    const payload = (await response.json()) as CatalogResponse;
    const index = new Map<string, { weapon: string; skinId: string }>();
    for (const group of [payload.categories.primary, payload.categories.pistol, payload.categories.knife, payload.categories.gloves]) {
      for (const weapon of group ?? []) {
        for (const skin of weapon.skins ?? []) {
          const key = String(skin.skin_name ?? "").trim().toLowerCase();
          if (!key || index.has(key)) continue;
          index.set(key, { weapon: weapon.weapon_name, skinId: skin.skin_id });
        }
      }
    }
    setWeaponBySkinName(index);
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([loadBoxes(), loadCatalog()])
      .catch(() => setStatus("Failed to load FragBox data."))
      .finally(() => setLoading(false));
  }, [steamId]);

  const canOpen = Number(boxes?.unopened ?? 0) > 0 && !openInProgress;

  const openBox = async () => {
    if (!canOpen) return;
    setOpenInProgress(true);
    setStatus("");
    setLastReward(null);

    const fakeItems = ["Common skin...", "Rare skin...", "Epic reward...", "Legendary drop..."];
    let pointer = 0;
    const ticker = setInterval(() => {
      setRollingLabel(fakeItems[pointer % fakeItems.length]);
      pointer += 1;
    }, 150);

    try {
      const response = await fetch(`${API_BASE_URL}/player/boxes/open`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steam_id: steamId })
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<OpenBoxResponse> & { error?: string };
      if (!response.ok || !payload.reward) {
        throw new Error(payload.error ?? "OPEN_FAILED");
      }
      await new Promise((resolve) => setTimeout(resolve, 1300));
      setLastReward(payload.reward);
      setStatus("FragBox opened.");
      await loadBoxes();
    } catch (error: any) {
      setStatus(`Open failed: ${String(error?.message ?? error)}`);
    } finally {
      clearInterval(ticker);
      setOpenInProgress(false);
    }
  };

  const equipReward = async () => {
    if (!lastReward) return;
    const mapping = weaponBySkinName.get(String(lastReward.skin_name ?? "").trim().toLowerCase());
    if (!mapping) {
      setStatus("This reward cannot be equipped as a weapon skin.");
      return;
    }
    setEquipping(true);
    try {
      const response = await fetch(`${API_BASE_URL}/player/skins`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          steam_id: steamId,
          weapon: mapping.weapon,
          skin_id: mapping.skinId
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "EQUIP_FAILED" }))) as { error?: string };
        throw new Error(payload.error ?? "EQUIP_FAILED");
      }
      setStatus(`Equipped ${lastReward.skin_name} on ${mapping.weapon}.`);
    } catch (error: any) {
      setStatus(`Equip failed: ${String(error?.message ?? error)}`);
    } finally {
      setEquipping(false);
    }
  };

  const rewardIsSkin = useMemo(() => {
    const type = String(lastReward?.reward_type ?? "").toLowerCase();
    return type === "weapon_skin" || type === "knife_skin" || type === "glove_skin" || type === "box_reward";
  }, [lastReward]);

  if (loading) {
    return <div className="card p-6 text-sm text-white/70">Loading FragBox...</div>;
  }

  return (
    <div className="space-y-4">
      <section className="card p-6">
        <h2 className="text-lg font-semibold">FragBox</h2>
        <p className="mt-1 text-sm text-white/70">After matches, you can receive FragBoxes. Open them to unlock skins, battlepass tokens, and profile badges.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-xs text-white/60">Unopened</p>
            <p className="mt-1 text-xl font-semibold">{boxes?.unopened ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-xs text-white/60">Opened</p>
            <p className="mt-1 text-xl font-semibold">{boxes?.opened ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-xs text-white/60">Possible rewards</p>
            <p className="mt-1 text-sm font-medium">Skin • Battlepass Token • Profile Badge</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" className="btn-primary disabled:opacity-60" disabled={!canOpen} onClick={() => void openBox()}>
            {openInProgress ? "Opening..." : "Open Box"}
          </button>
          {status ? <span className="text-xs text-white/70">{status}</span> : null}
        </div>
      </section>

      <section className="card p-6">
        <h3 className="text-base font-semibold">Open Box</h3>
        <div className="mt-4 min-h-[220px]">
          <AnimatePresence mode="wait">
            {openInProgress ? (
              <motion.div
                key="rolling"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className="rounded-xl border border-brand/40 bg-brand/10 p-6"
              >
                <motion.div
                  className="h-2 rounded-full bg-gradient-to-r from-brand/30 via-brand to-brand/30"
                  initial={{ backgroundPositionX: 0 }}
                  animate={{ backgroundPositionX: 300 }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                />
                <p className="mt-4 text-sm text-white/80">{rollingLabel}</p>
              </motion.div>
            ) : lastReward ? (
              <motion.div
                key="reward"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                className={`rounded-xl border bg-gradient-to-br p-5 ${rarityGlow[String(lastReward.rarity ?? "common").toLowerCase()] ?? rarityGlow.common}`}
              >
                <img
                  src={
                    rewardIsSkin
                      ? getSkinImage(weaponBySkinName.get(String(lastReward.skin_name ?? "").trim().toLowerCase())?.weapon ?? "", lastReward.skin_name)
                      : lastReward.image_url ?? "/assets/icons/skin_placeholder.svg"
                  }
                  alt={lastReward.skin_name}
                  className="h-36 w-full rounded-lg object-cover"
                  onError={(event) => {
                    (event.currentTarget as HTMLImageElement).src = lastReward.image_url ?? "/assets/icons/skin_placeholder.svg";
                  }}
                />
                <p className="mt-3 text-lg font-semibold">{lastReward.skin_name}</p>
                <p className="text-sm text-white/80">{prettyRewardType(lastReward.reward_type)}</p>
                <p className="text-xs uppercase tracking-wide text-white/70">{lastReward.rarity}</p>
                {rewardIsSkin ? (
                  <button type="button" className="btn-primary mt-3" onClick={() => void equipReward()} disabled={equipping}>
                    {equipping ? "Equipping..." : "Equip Reward"}
                  </button>
                ) : null}
              </motion.div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/60">
                Open a FragBox to reveal your reward.
              </div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <section className="card p-6">
        <h3 className="text-base font-semibold">Rarity</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          {["common", "rare", "epic", "legendary"].map((r) => (
            <div key={r} className={`rounded-lg border px-3 py-2 text-sm capitalize ${rarityGlow[r] ?? rarityGlow.common}`}>
              {r}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
