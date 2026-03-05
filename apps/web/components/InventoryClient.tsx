"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import { getSkinImage } from "@/lib/assets";

type InventoryItem = {
  id: string;
  item_id: string | null;
  item_type: string;
  season_id: string | null;
  rarity: string;
  obtained_at: string;
  created_at: string;
  reward_type: string | null;
  skin_name: string | null;
  image_url: string | null;
};

type InventoryResponse = {
  steam_id: string;
  items: InventoryItem[];
};

type CatalogSkin = {
  skin_name: string;
  skin_id: string;
  rarity: string;
  image_url: string | null;
  is_default: boolean;
};

type CatalogWeapon = {
  weapon_name: string;
  skins: CatalogSkin[];
};

type CatalogResponse = {
  categories: {
    primary: CatalogWeapon[];
    pistol: CatalogWeapon[];
    knife: CatalogWeapon[];
    gloves: CatalogWeapon[];
  };
};

type LoadoutResponse = {
  steam_id: string;
  skins: Array<{
    weapon: string;
    skin_id: string;
    skin_name?: string | null;
  }>;
};

type EquipTarget = {
  weapon: string;
  skin_id: string;
};

const rarityStyles: Record<string, string> = {
  common: "border-white/15 bg-white/5",
  rare: "border-sky-400/45 bg-sky-500/10",
  epic: "border-violet-400/50 bg-violet-500/10",
  legendary: "border-amber-400/55 bg-amber-500/10",
  mythic: "border-red-400/60 bg-red-500/10"
};

function toDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export function InventoryClient({ steamId }: { steamId: string }) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [catalog, setCatalog] = useState<CatalogWeapon[]>([]);
  const [loadout, setLoadout] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string>("");
  const [equippingId, setEquippingId] = useState<string>("");

  const loadData = async () => {
    setLoading(true);
    setStatus("");
    try {
      const [inventoryRes, catalogRes, loadoutRes] = await Promise.all([
        fetch(`${API_BASE_URL}/player/inventory/${encodeURIComponent(steamId)}`, { cache: "no-store", credentials: "include" }),
        fetch(`${API_BASE_URL}/skins/catalog`, { cache: "no-store", credentials: "include" }),
        fetch(`${API_BASE_URL}/player/skins/${encodeURIComponent(steamId)}`, { cache: "no-store", credentials: "include" })
      ]);
      if (!inventoryRes.ok || !catalogRes.ok || !loadoutRes.ok) {
        setStatus("Failed to load inventory.");
        return;
      }
      const inventoryPayload = (await inventoryRes.json()) as InventoryResponse;
      const catalogPayload = (await catalogRes.json()) as CatalogResponse;
      const loadoutPayload = (await loadoutRes.json()) as LoadoutResponse;
      setItems(inventoryPayload.items ?? []);
      setCatalog([
        ...(catalogPayload.categories.primary ?? []),
        ...(catalogPayload.categories.pistol ?? []),
        ...(catalogPayload.categories.knife ?? []),
        ...(catalogPayload.categories.gloves ?? [])
      ]);
      const loadoutMap: Record<string, string> = {};
      for (const row of loadoutPayload.skins ?? []) {
        loadoutMap[String(row.weapon)] = String(row.skin_id);
      }
      setLoadout(loadoutMap);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [steamId]);

  const equipMap = useMemo(() => {
    const map = new Map<string, EquipTarget>();
    for (const weapon of catalog) {
      for (const skin of weapon.skins) {
        const key = String(skin.skin_name ?? "").trim().toLowerCase();
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, { weapon: weapon.weapon_name, skin_id: skin.skin_id });
        }
      }
    }
    return map;
  }, [catalog]);

  const onEquip = async (item: InventoryItem) => {
    const skinName = String(item.skin_name ?? "").trim().toLowerCase();
    const target = equipMap.get(skinName);
    if (!target) {
      setStatus("This inventory item cannot be equipped directly.");
      return;
    }
    setEquippingId(item.id);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/player/skins`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          steam_id: steamId,
          weapon: target.weapon,
          skin_id: target.skin_id
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "EQUIP_FAILED" }))) as { error?: string };
        setStatus(`Equip failed: ${payload.error ?? "EQUIP_FAILED"}`);
        return;
      }
      setLoadout((prev) => ({ ...prev, [target.weapon]: target.skin_id }));
      setStatus(`Equipped ${item.skin_name ?? target.skin_id} on ${target.weapon}.`);
    } finally {
      setEquippingId("");
    }
  };

  if (loading) {
    return <div className="card p-6 text-sm text-white/70">Loading inventory...</div>;
  }

  return (
    <div className="space-y-4">
      <section className="card p-6">
        <h2 className="text-lg font-semibold">Inventory Grid</h2>
        <p className="mt-1 text-sm text-white/70">Skins unlocked via FragBoxes or rewards. Equip them to your FragHub loadout.</p>
        {status ? <p className="mt-2 text-xs text-white/70">{status}</p> : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => {
            const rarity = String(item.rarity ?? "common").toLowerCase();
            const equipTarget = equipMap.get(String(item.skin_name ?? "").trim().toLowerCase());
            const isEquipped = equipTarget ? loadout[equipTarget.weapon] === equipTarget.skin_id : false;
            return (
              <div key={item.id} className={`rounded-xl border p-3 ${rarityStyles[rarity] ?? rarityStyles.common}`}>
                <img
                  src={equipTarget ? getSkinImage(equipTarget.weapon, item.skin_name ?? "") : item.image_url ?? "/assets/icons/skin_placeholder.svg"}
                  alt={item.skin_name ?? "Inventory item"}
                  className="h-28 w-full rounded-lg object-cover"
                  onError={(event) => {
                    (event.currentTarget as HTMLImageElement).src = item.image_url ?? "/assets/icons/skin_placeholder.svg";
                  }}
                />
                <p className="mt-2 text-sm font-medium">{item.skin_name ?? "Unknown item"}</p>
                <p className="text-xs text-white/70">Weapon: {equipTarget?.weapon ?? "Not mapped"}</p>
                <p className="text-xs text-white/70">Rarity: {item.rarity}</p>
                <p className="text-[11px] text-white/55">Unlocked: {toDateLabel(item.obtained_at)}</p>
                <button
                  type="button"
                  className="btn-primary mt-3 w-full disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!equipTarget || equippingId === item.id || isEquipped}
                  onClick={() => void onEquip(item)}
                >
                  {isEquipped ? "Equipped" : equippingId === item.id ? "Equipping..." : "Equip"}
                </button>
              </div>
            );
          })}
          {!items.length ? <p className="text-sm text-white/70">No inventory items yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
