#!/usr/bin/env node
import { mkdir, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const publicAssetsRoot = path.join(repoRoot, "apps", "web", "public", "assets");

const dirs = ["skins", "maps", "ranks", "weapons", "icons"];

const skins = {
  AK47_FIRE_SERPENT: {
    local: "/assets/skins/ak47_fire_serpent.svg",
    steam_cdn: "https://steamcdn-a.akamaihd.net/apps/730/icons/econ/default_generated/weapon_ak47_cu_fire_serpent_light_large.png",
    csgostash: "https://csgostash.com/img/skins/s1175.png"
  },
  AK47_REDLINE: {
    local: "/assets/skins/ak47_redline.svg",
    csgostash: "https://csgostash.com/img/skins/s182.png"
  },
  AK47_VULCAN: {
    local: "/assets/skins/ak47_vulcan.svg",
    csgostash: "https://csgostash.com/img/skins/s324.png"
  },
  AWP_DRAGON_LORE: {
    local: "/assets/skins/awp_dragon_lore.svg",
    csgostash: "https://csgostash.com/img/skins/s48.png"
  },
  M4A1_S_PRINTSTREAM: {
    local: "/assets/skins/m4a1s_printstream.svg",
    csgostash: "https://csgostash.com/img/skins/s1345.png"
  },
  KNIFE_KARAMBIT_FADE: {
    local: "/assets/skins/knife_karambit_fade.svg"
  }
};

const maps = {
  mirage: {
    background: "/assets/maps/mirage.svg",
    radar: "/assets/maps/de_mirage_radar.svg",
    fallback_background: "https://totalcsgo.com/images/maps/mirage.jpg"
  },
  dust2: {
    background: "/assets/maps/dust2.svg",
    radar: "/assets/maps/de_dust2_radar.svg",
    fallback_background: "https://totalcsgo.com/images/maps/dust2.jpg"
  },
  inferno: {
    background: "/assets/maps/inferno.svg",
    radar: "/assets/maps/de_inferno_radar.svg",
    fallback_background: "https://totalcsgo.com/images/maps/inferno.jpg"
  },
  nuke: {
    background: "/assets/maps/nuke.svg",
    radar: "/assets/maps/de_nuke_radar.svg",
    fallback_background: "https://totalcsgo.com/images/maps/nuke.jpg"
  },
  overpass: {
    background: "/assets/maps/overpass.svg",
    radar: "/assets/maps/de_overpass_radar.svg",
    fallback_background: "https://totalcsgo.com/images/maps/overpass.jpg"
  }
};

const mapRadarBase =
  "https://raw.githubusercontent.com/SteamDatabase/GameTracking-CSGO/master/csgo/resource/overviews";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(url, outPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outPath, buffer);
}

async function ensureDirs() {
  await mkdir(publicAssetsRoot, { recursive: true });
  for (const dir of dirs) {
    await mkdir(path.join(publicAssetsRoot, dir), { recursive: true });
  }
}

async function writeManifests() {
  await writeFile(path.join(publicAssetsRoot, "skins", "skins.json"), JSON.stringify(skins, null, 2));
  await writeFile(path.join(publicAssetsRoot, "maps", "maps.json"), JSON.stringify(maps, null, 2));
}

async function syncSkinImages() {
  const placeholder = path.join(publicAssetsRoot, "icons", "skin_placeholder.svg");
  for (const [, entry] of Object.entries(skins)) {
    const outPath = path.join(publicAssetsRoot, entry.local.replace("/assets/", ""));
    if (await exists(outPath)) continue;
    const sources = [entry.steam_cdn, entry.csgostash].filter(Boolean);
    let ok = false;
    for (const source of sources) {
      try {
        await downloadTo(source, outPath);
        ok = true;
        break;
      } catch {
        // try next
      }
    }
    if (!ok && (await exists(placeholder))) {
      await copyFile(placeholder, outPath.replace(/\.(png|jpg|jpeg)$/i, ".svg"));
    }
  }
}

async function syncMapAssets() {
  const placeholder = path.join(publicAssetsRoot, "icons", "map_placeholder.svg");
  for (const [name, entry] of Object.entries(maps)) {
    const radarFile = path.basename(entry.radar);
    const radarOut = path.join(publicAssetsRoot, "maps", radarFile);
    if (!(await exists(radarOut))) {
      try {
        await downloadTo(`${mapRadarBase}/${radarFile}`, radarOut);
      } catch {
        if (await exists(placeholder)) {
          await copyFile(placeholder, radarOut.replace(/\.png$/i, ".svg"));
        }
      }
    }

    const bgFile = path.basename(entry.background);
    const bgOut = path.join(publicAssetsRoot, "maps", bgFile);
    if (!(await exists(bgOut))) {
      try {
        await downloadTo(entry.fallback_background, bgOut);
      } catch {
        if (await exists(placeholder)) {
          await copyFile(placeholder, bgOut.replace(/\.(jpg|jpeg|png)$/i, ".svg"));
        }
      }
    }
    if (name === "dust2" && !(await exists(bgOut)) && (await exists(path.join(publicAssetsRoot, "maps", "dust2.svg")))) {
      // noop safeguard
    }
  }
}

async function main() {
  await ensureDirs();
  await writeManifests();
  await syncSkinImages();
  await syncMapAssets();
  console.log("Asset sync completed.");
}

main().catch((error) => {
  console.error("Asset sync failed:", error);
  process.exit(1);
});
