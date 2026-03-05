"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/config";
import { Skin3DPreview } from "@/components/Skin3DPreview";
import { getSkinImage } from "@/lib/assets";

type SkinEntry = {
  skin_name: string;
  skin_id: string;
  rarity: string;
  image_url: string | null;
  is_default: boolean;
};

type WeaponCatalog = {
  weapon_name: string;
  skins: SkinEntry[];
};

type CatalogResponse = {
  categories: {
    primary: WeaponCatalog[];
    pistol: WeaponCatalog[];
    knife: WeaponCatalog[];
    gloves: WeaponCatalog[];
  };
};

type PlayerSkinsResponse = {
  steam_id: string;
  skins: Array<{
    weapon: string;
    skin_id: string;
    skin_name?: string | null;
    rarity?: string | null;
    image_url?: string | null;
  }>;
};

type SidebarGroup = "rifles" | "pistols" | "snipers" | "smgs" | "heavy" | "knives" | "gloves" | "weapons";

const sidebarGroups: Array<{ key: SidebarGroup; label: string }> = [
  { key: "weapons", label: "Weapons" },
  { key: "rifles", label: "Rifles" },
  { key: "pistols", label: "Pistols" },
  { key: "snipers", label: "Snipers" },
  { key: "smgs", label: "SMGs" },
  { key: "heavy", label: "Heavy" },
  { key: "knives", label: "Knives" },
  { key: "gloves", label: "Gloves" }
];

const rarityClass: Record<string, string> = {
  common: "border-white/15",
  uncommon: "border-emerald-400/45",
  rare: "border-sky-400/50",
  epic: "border-violet-400/55",
  legendary: "border-amber-400/60",
  mythic: "border-red-400/60"
};

function normalizeWeaponName(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function classifyWeapon(weaponName: string, category: "primary" | "pistol" | "knife" | "gloves"): SidebarGroup {
  if (category === "knife") return "knives";
  if (category === "gloves") return "gloves";
  if (category === "pistol") return "pistols";
  const w = normalizeWeaponName(weaponName);
  if (["awp", "ssg08", "scar20", "g3sg1"].includes(w)) return "snipers";
  if (["mp9", "mp7", "ump45", "p90", "mac10", "mp5sd", "ppbizon"].includes(w)) return "smgs";
  if (["nova", "xm1014", "mag7", "sawedoff", "m249", "negev"].includes(w)) return "heavy";
  if (["ak47", "m4a1s", "m4a4", "famas", "galil", "aug", "sg553"].includes(w)) return "rifles";
  return "weapons";
}

function prettyWeaponName(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SkinsLoadoutClient({ steamId }: { steamId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveInfo, setSaveInfo] = useState<string>("");
  const [group, setGroup] = useState<SidebarGroup>("rifles");
  const [selectedWeapon, setSelectedWeapon] = useState<string>("");
  const [catalog, setCatalog] = useState<Array<{ weapon_name: string; category: "primary" | "pistol" | "knife" | "gloves"; skins: SkinEntry[] }>>([]);
  const [currentLoadout, setCurrentLoadout] = useState<Record<string, string>>({});
  const [draftLoadout, setDraftLoadout] = useState<Record<string, string>>({});

  const loadData = async () => {
    setLoading(true);
    try {
      const [catalogRes, loadoutRes] = await Promise.all([
        fetch(`${API_BASE_URL}/skins/catalog`, { cache: "no-store", credentials: "include" }),
        fetch(`${API_BASE_URL}/player/skins/${encodeURIComponent(steamId)}`, { cache: "no-store", credentials: "include" })
      ]);
      if (!catalogRes.ok || !loadoutRes.ok) {
        setSaveInfo("Failed to load skins.");
        return;
      }
      const catalogPayload = (await catalogRes.json()) as CatalogResponse;
      const loadoutPayload = (await loadoutRes.json()) as PlayerSkinsResponse;

      const merged = [
        ...(catalogPayload.categories.primary ?? []).map((w) => ({ ...w, category: "primary" as const })),
        ...(catalogPayload.categories.pistol ?? []).map((w) => ({ ...w, category: "pistol" as const })),
        ...(catalogPayload.categories.knife ?? []).map((w) => ({ ...w, category: "knife" as const })),
        ...(catalogPayload.categories.gloves ?? []).map((w) => ({ ...w, category: "gloves" as const }))
      ];
      setCatalog(merged);

      const loaded: Record<string, string> = {};
      for (const entry of loadoutPayload.skins ?? []) {
        loaded[String(entry.weapon)] = String(entry.skin_id);
      }
      setCurrentLoadout(loaded);
      setDraftLoadout(loaded);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [steamId]);

  const weaponsByGroup = useMemo(() => {
    const map: Record<SidebarGroup, Array<{ weapon_name: string; category: "primary" | "pistol" | "knife" | "gloves"; skins: SkinEntry[] }>> = {
      weapons: [],
      rifles: [],
      pistols: [],
      snipers: [],
      smgs: [],
      heavy: [],
      knives: [],
      gloves: []
    };
    for (const weapon of catalog) {
      const g = classifyWeapon(weapon.weapon_name, weapon.category);
      map[g].push(weapon);
      if (g !== "weapons" && weapon.category === "primary") {
        map.weapons.push(weapon);
      }
    }
    map.weapons = Array.from(new Map(map.weapons.map((w) => [w.weapon_name, w])).values());
    return map;
  }, [catalog]);

  useEffect(() => {
    const entries = weaponsByGroup[group];
    if (!entries.length) {
      setSelectedWeapon("");
      return;
    }
    if (!entries.some((entry) => entry.weapon_name === selectedWeapon)) {
      setSelectedWeapon(entries[0].weapon_name);
    }
  }, [group, weaponsByGroup, selectedWeapon]);

  const selectedWeaponData = useMemo(
    () => catalog.find((entry) => entry.weapon_name === selectedWeapon) ?? null,
    [catalog, selectedWeapon]
  );

  const dirtyWeapons = useMemo(() => {
    return Object.keys(draftLoadout).filter((weapon) => draftLoadout[weapon] !== currentLoadout[weapon]);
  }, [draftLoadout, currentLoadout]);

  const onSelectSkin = (weapon: string, skinId: string) => {
    setDraftLoadout((prev) => ({ ...prev, [weapon]: skinId }));
    setSaveInfo("");
  };

  const saveLoadout = async () => {
    if (!dirtyWeapons.length) {
      setSaveInfo("No changes to save.");
      return;
    }
    setSaving(true);
    setSaveInfo("");
    try {
      for (const weapon of dirtyWeapons) {
        const skinId = draftLoadout[weapon];
        const response = await fetch(`${API_BASE_URL}/player/skins`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            steam_id: steamId,
            weapon,
            skin_id: skinId
          })
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({ error: "SAVE_FAILED" }))) as { error?: string };
          throw new Error(payload.error ?? "SAVE_FAILED");
        }
      }
      setCurrentLoadout(draftLoadout);
      setSaveInfo("Loadout saved.");
    } catch (error: any) {
      setSaveInfo(`Save failed: ${String(error?.message ?? error)}`);
    } finally {
      setSaving(false);
    }
  };

  const loadoutRows = useMemo(() => {
    return catalog
      .map((weapon) => {
        const selectedId = draftLoadout[weapon.weapon_name];
        if (!selectedId) return null;
        const selectedSkin = weapon.skins.find((skin) => skin.skin_id === selectedId);
        return {
          weapon: weapon.weapon_name,
          skin: selectedSkin?.skin_name ?? selectedId
        };
      })
      .filter((row): row is { weapon: string; skin: string } => Boolean(row))
      .sort((a, b) => a.weapon.localeCompare(b.weapon));
  }, [catalog, draftLoadout]);

  const selectedPreviewSkin = useMemo(() => {
    if (!selectedWeaponData) return null;
    const selectedId = draftLoadout[selectedWeaponData.weapon_name] ?? selectedWeaponData.skins[0]?.skin_id;
    if (!selectedId) return null;
    return selectedWeaponData.skins.find((skin) => skin.skin_id === selectedId) ?? null;
  }, [selectedWeaponData, draftLoadout]);

  if (loading) {
    return <div className="card p-6 text-sm text-white/70">Loading skin catalog...</div>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_280px_minmax(0,1fr)]">
      <aside className="card p-4">
        <p className="text-xs uppercase tracking-wide text-white/60">Weapons</p>
        <div className="mt-3 space-y-1">
          {sidebarGroups.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                group === item.key ? "bg-brand/20 text-white" : "text-white/75 hover:bg-white/10"
              }`}
              onClick={() => setGroup(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </aside>

      <section className="card p-4">
        <p className="text-xs uppercase tracking-wide text-white/60">Weapon List</p>
        <div className="mt-3 space-y-2">
          {weaponsByGroup[group].map((weapon) => (
            <button
              key={weapon.weapon_name}
              type="button"
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                selectedWeapon === weapon.weapon_name ? "border-brand/60 bg-brand/10" : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
              onClick={() => setSelectedWeapon(weapon.weapon_name)}
            >
              {prettyWeaponName(weapon.weapon_name)}
            </button>
          ))}
          {weaponsByGroup[group].length === 0 ? <p className="text-sm text-white/60">No weapons in this category.</p> : null}
        </div>
      </section>

      <section className="space-y-4">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{selectedWeapon ? prettyWeaponName(selectedWeapon) : "Select a weapon"}</h2>
            <button type="button" className="btn-primary disabled:opacity-60" onClick={() => void saveLoadout()} disabled={saving}>
              {saving ? "Saving..." : "Save Loadout"}
            </button>
          </div>
          {saveInfo ? <p className="mt-2 text-xs text-white/70">{saveInfo}</p> : null}
          {selectedWeaponData && selectedPreviewSkin ? (
            <div className="mt-4">
              <Skin3DPreview
                weaponName={prettyWeaponName(selectedWeaponData.weapon_name)}
                skinName={selectedPreviewSkin.skin_name}
                skinImageUrl={selectedPreviewSkin.image_url}
              />
            </div>
          ) : null}
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(selectedWeaponData?.skins ?? []).map((skin) => {
              const active = draftLoadout[selectedWeaponData!.weapon_name] === skin.skin_id;
              const rarity = String(skin.rarity ?? "common").toLowerCase();
              return (
                <button
                  key={skin.skin_id}
                  type="button"
                  className={`rounded-xl border p-3 text-left transition ${
                    active ? "border-brand bg-brand/10" : `${rarityClass[rarity] ?? "border-white/15"} bg-white/5 hover:bg-white/10`
                  }`}
                  onClick={() => onSelectSkin(selectedWeaponData!.weapon_name, skin.skin_id)}
                >
                  <img
                    src={getSkinImage(selectedWeaponData!.weapon_name, skin.skin_name)}
                    alt={skin.skin_name}
                    className="h-24 w-full rounded-lg object-cover"
                    onError={(event) => {
                      (event.currentTarget as HTMLImageElement).src = skin.image_url ?? "/assets/icons/skin_placeholder.svg";
                    }}
                  />
                  <p className="mt-2 text-sm font-medium">{skin.skin_name}</p>
                  <p className="text-xs uppercase tracking-wide text-white/60">{skin.rarity}</p>
                </button>
              );
            })}
            {!selectedWeaponData ? <p className="text-sm text-white/60">Choose a weapon to view skins.</p> : null}
          </div>
        </div>

        <div className="card p-4">
          <h3 className="text-base font-semibold">Player Loadout</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {loadoutRows.map((entry) => (
              <div key={entry.weapon} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                <p className="text-xs text-white/60">{prettyWeaponName(entry.weapon)}</p>
                <p className="text-sm">{entry.skin}</p>
              </div>
            ))}
            {loadoutRows.length === 0 ? <p className="text-sm text-white/60">No skin loadout available.</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
