import skinsManifest from "@/public/assets/skins/skins.json";
import mapsManifest from "@/public/assets/maps/maps.json";
import ranksManifest from "@/public/assets/ranks/ranks.json";
import weaponsManifest from "@/public/assets/weapons/weapons.json";

type SkinManifestEntry = {
  local: string;
  steam_cdn?: string;
  csgostash?: string;
};

type MapManifestEntry = {
  background: string;
  radar: string;
  fallback_background?: string;
};

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\|/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function skinKey(weapon: string, skin: string): string {
  return `${normalizeToken(weapon)}_${normalizeToken(skin)}`.toUpperCase();
}

function steamFallback(weapon: string, skin: string): string {
  const w = normalizeToken(weapon).replace(/_/g, "");
  const s = normalizeToken(skin);
  return `https://steamcdn-a.akamaihd.net/apps/730/icons/econ/default_generated/weapon_${w}_${s}_light_large.png`;
}

function stashFallback(weapon: string, skin: string): string {
  const w = normalizeToken(weapon).replace(/_/g, "");
  const s = normalizeToken(skin);
  return `https://csgostash.com/img/skins/${w}_${s}.png`;
}

export function getSkinImage(weapon: string, skin: string): string {
  const key = skinKey(weapon, skin);
  const entry = (skinsManifest as Record<string, SkinManifestEntry>)[key];
  if (entry?.local) return entry.local;
  if (entry?.steam_cdn) return entry.steam_cdn;
  if (entry?.csgostash) return entry.csgostash;
  const generatedSteam = steamFallback(weapon, skin);
  if (generatedSteam) return generatedSteam;
  const generatedStash = stashFallback(weapon, skin);
  if (generatedStash) return generatedStash;
  return "/assets/icons/skin_placeholder.svg";
}

export function getMapImage(map: string): string {
  const key = normalizeToken(map).replace(/^de_/, "");
  const entry = (mapsManifest as Record<string, MapManifestEntry>)[key];
  if (entry?.background) return entry.background;
  if (entry?.fallback_background) return entry.fallback_background;
  return "/assets/icons/map_placeholder.svg";
}

export function getMapRadar(map: string): string {
  const key = normalizeToken(map).replace(/^de_/, "");
  const entry = (mapsManifest as Record<string, MapManifestEntry>)[key];
  if (entry?.radar) return entry.radar;
  return "/assets/icons/map_placeholder.svg";
}

export function getRankIcon(rank: string): string {
  const key = normalizeToken(rank);
  const entry = (ranksManifest as Record<string, string>)[key];
  if (entry) return entry;
  return "/assets/icons/rank_placeholder.svg";
}

export function getWeaponIcon(weapon: string): string {
  const key = normalizeToken(weapon).replace(/^weapon_/, "");
  const entry = (weaponsManifest as Record<string, string>)[key];
  if (entry) return entry;
  return "/assets/icons/weapon_placeholder.svg";
}
