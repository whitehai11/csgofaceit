import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

type WeaponType = "rifle" | "pistol" | "sniper" | "smg" | "heavy" | "knife" | "gloves" | "other";
type SkinRarity = "consumer" | "industrial" | "mil-spec" | "restricted" | "classified" | "covert" | "extraordinary" | "contraband" | "other";

type ByMykelSkin = {
  id: string;
  name: string;
  image?: string;
  weapon?: { name?: string };
  rarity?: { name?: string };
  category?: { name?: string };
};

type GameMap = {
  name: string;
  displayName: string;
  radarFile: string;
  previewUrl: string;
};

type RankSeed = {
  tier: number;
  name: string;
  slug: string;
};

const ROOT = process.cwd();
const ASSETS_ROOT = path.join(ROOT, "apps", "web", "public", "assets");
const SKINS_DIR = path.join(ASSETS_ROOT, "skins");
const MAPS_DIR = path.join(ASSETS_ROOT, "maps");
const RANKS_DIR = path.join(ASSETS_ROOT, "ranks");

const MAP_RADAR_BASE = "https://raw.githubusercontent.com/SteamDatabase/GameTracking-CSGO/master/csgo/resource/overviews";
const MAP_PREVIEW_BASE = "https://totalcsgo.com/images/maps";
const SKINS_DATASET_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json";
const CSGO_STASH_IMAGE_BASE = "https://csgostash.com/img/skins";

const REQUIRED_WEAPONS: Array<{ name: string; type: WeaponType }> = [
  { name: "AK-47", type: "rifle" },
  { name: "M4A1-S", type: "rifle" },
  { name: "M4A4", type: "rifle" },
  { name: "AUG", type: "rifle" },
  { name: "FAMAS", type: "rifle" },
  { name: "Galil AR", type: "rifle" },
  { name: "SG 553", type: "rifle" },
  { name: "AWP", type: "sniper" },
  { name: "SSG 08", type: "sniper" },
  { name: "SCAR-20", type: "sniper" },
  { name: "G3SG1", type: "sniper" },
  { name: "Glock-18", type: "pistol" },
  { name: "USP-S", type: "pistol" },
  { name: "P2000", type: "pistol" },
  { name: "Desert Eagle", type: "pistol" },
  { name: "Five-SeveN", type: "pistol" },
  { name: "P250", type: "pistol" },
  { name: "Tec-9", type: "pistol" },
  { name: "CZ75-Auto", type: "pistol" },
  { name: "P90", type: "smg" },
  { name: "MP9", type: "smg" },
  { name: "MP7", type: "smg" },
  { name: "UMP-45", type: "smg" },
  { name: "MAC-10", type: "smg" },
  { name: "PP-Bizon", type: "smg" },
  { name: "Negev", type: "heavy" },
  { name: "M249", type: "heavy" },
  { name: "Nova", type: "heavy" },
  { name: "XM1014", type: "heavy" },
  { name: "MAG-7", type: "heavy" },
  { name: "Sawed-Off", type: "heavy" },
  { name: "Knife", type: "knife" },
  { name: "Gloves", type: "gloves" }
];

const MAPS: GameMap[] = [
  { name: "de_dust2", displayName: "Dust2", radarFile: "de_dust2_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/dust2.jpg` },
  { name: "de_mirage", displayName: "Mirage", radarFile: "de_mirage_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/mirage.jpg` },
  { name: "de_inferno", displayName: "Inferno", radarFile: "de_inferno_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/inferno.jpg` },
  { name: "de_nuke", displayName: "Nuke", radarFile: "de_nuke_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/nuke.jpg` },
  { name: "de_overpass", displayName: "Overpass", radarFile: "de_overpass_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/overpass.jpg` },
  { name: "de_ancient", displayName: "Ancient", radarFile: "de_ancient_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/ancient.jpg` },
  { name: "de_vertigo", displayName: "Vertigo", radarFile: "de_vertigo_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/vertigo.jpg` },
  { name: "de_anubis", displayName: "Anubis", radarFile: "de_anubis_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/anubis.jpg` },
  { name: "de_train", displayName: "Train", radarFile: "de_train_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/train.jpg` },
  { name: "de_cache", displayName: "Cache", radarFile: "de_cache_radar.png", previewUrl: `${MAP_PREVIEW_BASE}/cache.jpg` }
];

const RANKS: RankSeed[] = [
  { tier: 1, name: "Silver I", slug: "silver_1" },
  { tier: 2, name: "Silver II", slug: "silver_2" },
  { tier: 3, name: "Silver III", slug: "silver_3" },
  { tier: 4, name: "Silver IV", slug: "silver_4" },
  { tier: 5, name: "Silver Elite", slug: "silver_elite" },
  { tier: 6, name: "Silver Elite Master", slug: "silver_elite_master" },
  { tier: 7, name: "Gold Nova I", slug: "gold_nova_1" },
  { tier: 8, name: "Gold Nova II", slug: "gold_nova_2" },
  { tier: 9, name: "Gold Nova III", slug: "gold_nova_3" },
  { tier: 10, name: "Gold Nova Master", slug: "gold_nova_master" },
  { tier: 11, name: "Master Guardian I", slug: "master_guardian_1" },
  { tier: 12, name: "Master Guardian II", slug: "master_guardian_2" },
  { tier: 13, name: "Master Guardian Elite", slug: "master_guardian_elite" },
  { tier: 14, name: "Distinguished Master Guardian", slug: "distinguished_master_guardian" },
  { tier: 15, name: "Legendary Eagle", slug: "legendary_eagle" },
  { tier: 16, name: "Legendary Eagle Master", slug: "legendary_eagle_master" },
  { tier: 17, name: "Supreme Master First Class", slug: "supreme_master_first_class" },
  { tier: 18, name: "Global Elite", slug: "global_elite" }
];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeWeaponName(raw: string): string {
  return raw
    .replace(/^★\s*/u, "")
    .replace(/\s*\|\s*.+$/u, "")
    .trim();
}

function weaponTypeFromName(weapon: string): WeaponType {
  const w = weapon.toLowerCase();
  if (w.includes("knife")) return "knife";
  if (w.includes("glove") || w.includes("wrap")) return "gloves";
  if (["awp", "ssg 08", "scar-20", "g3sg1"].includes(w)) return "sniper";
  if (["glock-18", "usp-s", "p2000", "desert eagle", "five-seven", "p250", "tec-9", "cz75-auto", "dual berettas", "r8 revolver"].includes(w)) return "pistol";
  if (["p90", "mp9", "mp7", "ump-45", "mac-10", "pp-bizon", "mp5-sd"].includes(w)) return "smg";
  if (["nova", "xm1014", "mag-7", "sawed-off", "negev", "m249"].includes(w)) return "heavy";
  if (["ak-47", "m4a1-s", "m4a4", "aug", "famas", "galil ar", "sg 553"].includes(w)) return "rifle";
  return "other";
}

function mapRarity(raw?: string): SkinRarity {
  const v = (raw ?? "").toLowerCase();
  if (v.includes("consumer")) return "consumer";
  if (v.includes("industrial")) return "industrial";
  if (v.includes("mil-spec")) return "mil-spec";
  if (v.includes("restricted")) return "restricted";
  if (v.includes("classified")) return "classified";
  if (v.includes("covert")) return "covert";
  if (v.includes("extraordinary")) return "extraordinary";
  if (v.includes("contraband")) return "contraband";
  return "other";
}

function toLegacyWeaponSkinsRarity(rarity: SkinRarity): "consumer" | "industrial" | "mil-spec" | "restricted" | "classified" | "covert" | "legendary" {
  if (rarity === "extraordinary" || rarity === "contraband") return "legendary";
  if (rarity === "other") return "mil-spec";
  return rarity;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, targetPath: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const arr = await res.arrayBuffer();
    await writeFile(targetPath, Buffer.from(arr));
    return true;
  } catch {
    return false;
  }
}

async function writeRankIcon(seed: RankSeed): Promise<string> {
  const fileName = `${seed.slug}.svg`;
  const relative = `/assets/ranks/${fileName}`;
  const fullPath = path.join(RANKS_DIR, fileName);
  if (await exists(fullPath)) return relative;

  const hue = Math.round(220 - Math.min(seed.tier * 6, 100));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" fill="none">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},80%,65%)"/>
      <stop offset="100%" stop-color="hsl(${Math.max(hue - 40, 0)},90%,40%)"/>
    </linearGradient>
  </defs>
  <rect x="20" y="20" width="216" height="216" rx="26" fill="#0f172a" stroke="url(#g)" stroke-width="8"/>
  <circle cx="128" cy="104" r="44" fill="url(#g)"/>
  <text x="128" y="178" text-anchor="middle" fill="#e2e8f0" font-family="Arial, sans-serif" font-weight="700" font-size="18">${seed.tier}</text>
</svg>`;
  await writeFile(fullPath, svg, "utf8");
  return relative;
}

async function loadJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await exists(filePath))) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function saveJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const skipDownloads = args.has("--no-download");
  const maxDownloadsArg = process.argv.find((a) => a.startsWith("--max-skin-downloads="));
  const maxSkinDownloads = Number(maxDownloadsArg?.split("=")[1] ?? process.env.MAX_SKIN_DOWNLOADS ?? "2000");

  await ensureDir(SKINS_DIR);
  await ensureDir(MAPS_DIR);
  await ensureDir(RANKS_DIR);

  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/csgofaceit";
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log("Importing game data...");
    console.log(`Skins source: ${SKINS_DATASET_URL}`);
    if (skipDownloads) console.log("Asset downloads: disabled (--no-download)");

    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS weapons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('rifle', 'pistol', 'sniper', 'smg', 'heavy', 'knife', 'gloves', 'other')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS skins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        weapon_id UUID NOT NULL REFERENCES weapons(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        rarity TEXT NOT NULL CHECK (rarity IN ('consumer', 'industrial', 'mil-spec', 'restricted', 'classified', 'covert', 'extraordinary', 'contraband', 'other')),
        image_url TEXT,
        local_image_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (weapon_id, name)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS maps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        image_url TEXT,
        radar_url TEXT,
        local_image_path TEXT,
        local_radar_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ranks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        icon_url TEXT,
        local_icon_path TEXT,
        tier INTEGER NOT NULL CHECK (tier > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const w of REQUIRED_WEAPONS) {
      await client.query(
        `INSERT INTO weapons (name, type) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type`,
        [w.name, w.type]
      );
    }

    const skinsResponse = await fetch(SKINS_DATASET_URL);
    if (!skinsResponse.ok) {
      throw new Error(`Failed to fetch skins dataset: ${skinsResponse.status} ${skinsResponse.statusText}`);
    }
    const skinsDataset = (await skinsResponse.json()) as ByMykelSkin[];
    console.log(`Fetched ${skinsDataset.length} skins`);

    const weaponIdByName = new Map<string, string>();
    const weaponRows = await client.query<{ id: string; name: string }>("SELECT id, name FROM weapons");
    for (const row of weaponRows.rows) {
      weaponIdByName.set(row.name, row.id);
    }
    const hasLegacyWeaponSkins = (
      await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'weapon_skins'
         ) AS "exists"`
      )
    ).rows[0]?.exists === true;

    let downloadedSkinAssets = 0;
    const skinManifestPath = path.join(SKINS_DIR, "skins.json");
    const skinManifest = await loadJson<Record<string, string>>(skinManifestPath, {});

    for (const skin of skinsDataset) {
      const weaponName = normalizeWeaponName(skin.weapon?.name ?? "Unknown");
      if (!weaponIdByName.has(weaponName)) {
        const type = weaponTypeFromName(weaponName);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO weapons (name, type) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type
           RETURNING id`,
          [weaponName, type]
        );
        weaponIdByName.set(weaponName, inserted.rows[0].id);
      }

      const rarity = mapRarity(skin.rarity?.name);
      const cleanSkinName = skin.name.includes("|") ? skin.name.split("|")[1]?.trim() ?? skin.name : skin.name;
      const key = `${slugify(weaponName)}_${slugify(cleanSkinName)}`;
      const localFileName = `${key}.png`;
      const localPath = path.join(SKINS_DIR, localFileName);
      const localRelative = `/assets/skins/${localFileName}`;

      if (!skipDownloads && downloadedSkinAssets < maxSkinDownloads) {
        if (!(await exists(localPath))) {
          const downloaded = await downloadFile(skin.image ?? "", localPath);
          if (!downloaded && skin.image) {
            const maybeId = skin.id.match(/s(\d+)$/i)?.[1];
            if (maybeId) {
              await downloadFile(`${CSGO_STASH_IMAGE_BASE}/s${maybeId}.png`, localPath);
            }
          }
        }
        if (await exists(localPath)) downloadedSkinAssets += 1;
      }
      const hasLocalAsset = await exists(localPath);
      skinManifest[key] = hasLocalAsset ? localRelative : (skin.image ?? "");

      await client.query(
        `INSERT INTO skins (weapon_id, name, rarity, image_url, local_image_path)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (weapon_id, name) DO UPDATE
           SET rarity = EXCLUDED.rarity,
               image_url = EXCLUDED.image_url,
               local_image_path = EXCLUDED.local_image_path,
               updated_at = NOW()`,
        [weaponIdByName.get(weaponName), cleanSkinName, rarity, skin.image ?? null, hasLocalAsset ? localRelative : null]
      );

      if (hasLegacyWeaponSkins) {
        // Keep legacy table in sync so existing skin changer works immediately.
        await client.query(
          `INSERT INTO weapon_skins (weapon_name, category, skin_name, skin_id, rarity, image_url, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, FALSE)
           ON CONFLICT (weapon_name, skin_id) DO UPDATE
             SET skin_name = EXCLUDED.skin_name,
                 rarity = EXCLUDED.rarity,
                 image_url = EXCLUDED.image_url`,
          [
            slugify(weaponName),
            weaponTypeFromName(weaponName) === "pistol" ? "pistol" : (weaponTypeFromName(weaponName) === "knife" ? "knife" : (weaponTypeFromName(weaponName) === "gloves" ? "gloves" : "primary")),
            cleanSkinName,
            slugify(cleanSkinName),
            toLegacyWeaponSkinsRarity(rarity),
            hasLocalAsset ? localRelative : (skin.image ?? null)
          ]
        );
      }
    }

    const mapManifestPath = path.join(MAPS_DIR, "maps.json");
    const mapManifest = await loadJson<Record<string, { image: string; radar: string }>>(mapManifestPath, {});

    for (const mapItem of MAPS) {
      const radarUrl = `${MAP_RADAR_BASE}/${mapItem.radarFile}`;
      const radarLocalName = `${mapItem.name}_radar.png`;
      const imageLocalName = `${mapItem.name}.jpg`;
      const radarLocalPath = path.join(MAPS_DIR, radarLocalName);
      const imageLocalPath = path.join(MAPS_DIR, imageLocalName);
      const radarRelative = `/assets/maps/${radarLocalName}`;
      const imageRelative = `/assets/maps/${imageLocalName}`;

      if (!skipDownloads) {
        if (!(await exists(radarLocalPath))) await downloadFile(radarUrl, radarLocalPath);
        if (!(await exists(imageLocalPath))) await downloadFile(mapItem.previewUrl, imageLocalPath);
      }

      mapManifest[mapItem.name] = {
        image: (await exists(imageLocalPath)) ? imageRelative : mapItem.previewUrl,
        radar: (await exists(radarLocalPath)) ? radarRelative : radarUrl
      };

      await client.query(
        `INSERT INTO maps (name, display_name, image_url, radar_url, local_image_path, local_radar_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               image_url = EXCLUDED.image_url,
               radar_url = EXCLUDED.radar_url,
               local_image_path = EXCLUDED.local_image_path,
               local_radar_path = EXCLUDED.local_radar_path`,
        [
          mapItem.name,
          mapItem.displayName,
          mapItem.previewUrl,
          radarUrl,
          (await exists(imageLocalPath)) ? imageRelative : null,
          (await exists(radarLocalPath)) ? radarRelative : null
        ]
      );
    }

    const rankManifestPath = path.join(RANKS_DIR, "ranks.json");
    const rankManifest = await loadJson<Record<string, string>>(rankManifestPath, {});
    for (const rank of RANKS) {
      const iconPath = await writeRankIcon(rank);
      rankManifest[rank.name] = iconPath;
      await client.query(
        `INSERT INTO ranks (name, icon_url, local_icon_path, tier)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE
           SET icon_url = EXCLUDED.icon_url,
               local_icon_path = EXCLUDED.local_icon_path,
               tier = EXCLUDED.tier`,
        [rank.name, iconPath, iconPath, rank.tier]
      );
    }

    await saveJson(skinManifestPath, skinManifest);
    await saveJson(mapManifestPath, mapManifest);
    await saveJson(rankManifestPath, rankManifest);

    await client.query("COMMIT");

    const counts = await Promise.all([
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM weapons"),
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM skins"),
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM maps"),
      client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM ranks")
    ]);

    console.log("Import completed.");
    console.log(`Weapons: ${counts[0].rows[0].count}`);
    console.log(`Skins: ${counts[1].rows[0].count}`);
    console.log(`Maps: ${counts[2].rows[0].count}`);
    console.log(`Ranks: ${counts[3].rows[0].count}`);
    console.log(`Downloaded skin assets: ${skipDownloads ? 0 : downloadedSkinAssets}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("import-game-data failed:", err);
  process.exit(1);
});
