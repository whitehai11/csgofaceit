import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import crypto from "node:crypto";
import { RelyingParty } from "openid";
import { z } from "zod";
import authPlugin from "@csgofaceit/auth";
import { db } from "@csgofaceit/db";
import { MAP_POOL } from "@csgofaceit/shared";
import { STARTING_MMR, applyMatchResult, rankFromMmr } from "@csgofaceit/elo";
import { createServiceLogger } from "@csgofaceit/logger";
import { calculateSuspicionScore } from "./services/cheatDetection";
import { calculateBanEvasionScore } from "./services/banEvasion";
import { DEFAULT_SMURF_WEIGHTS, computeSmurfScore, type SmurfRiskWeights } from "./services/smurfRisk";
import { hasPrivilegedRole, isIpAllowed, normalizeSafeRelativePath, verifyInternalRequest } from "./security";
import { RATE_LIMIT_POLICIES } from "./rateLimitPolicies";

async function buildServer() {
  const app = Fastify({
    logger: true,
    bodyLimit: Number(process.env.API_BODY_LIMIT_BYTES ?? 1048576)
  });
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const eventLogger = createServiceLogger("api");
  const internalApiToken = process.env.INTERNAL_API_TOKEN ?? process.env.DISCORD_BOT_API_TOKEN ?? "";
  const internalWebhookSecret = process.env.INTERNAL_WEBHOOK_SECRET ?? "";
  const serverManagerApiToken = process.env.SERVER_MANAGER_API_TOKEN ?? "";
  const queueJoinCooldownSeconds = Number(process.env.QUEUE_JOIN_COOLDOWN_SECONDS ?? 10);
  const reportMuteSeconds = Number(process.env.REPORT_MUTE_SECONDS ?? 3600);
  const reportSpamThreshold = Number(process.env.REPORT_SPAM_THRESHOLD ?? 12);
  const newAccountReportWeightDays = Number(process.env.NEW_ACCOUNT_REPORT_WEIGHT_DAYS ?? 14);
  const webhookFailureSpikeThreshold = Number(process.env.WEBHOOK_FAILURE_SPIKE_THRESHOLD ?? 20);
  const telemetryWebhookSecret = process.env.TELEMETRY_WEBHOOK_SECRET ?? internalWebhookSecret ?? "";
  const telemetryNonceTtlSeconds = Number(process.env.TELEMETRY_NONCE_TTL_SECONDS ?? 600);
  const telemetryMaxSkewMs = Number(process.env.TELEMETRY_MAX_SKEW_MS ?? 5 * 60 * 1000);
  const antiCheatFlagThreshold = Number(process.env.ANTI_CHEAT_FLAG_THRESHOLD ?? 8);
  const antiCheatCaseThreshold = Number(process.env.ANTI_CHEAT_CASE_THRESHOLD ?? 12);
  const antiCheatTimeoutSuggestThreshold = Number(process.env.ANTI_CHEAT_TIMEOUT_SUGGEST_THRESHOLD ?? 16);
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const requestThrottle = new Map<string, { count: number; resetAt: number }>();
  const metrics = {
    blocked_requests: 0,
    rate_limit_hits: 0,
    webhook_signature_failures: 0,
    queue_spam_blocks: 0,
    telemetry_rejected: 0,
    anti_cheat_alerts_created: 0
  };
  const throttleConfig: Record<string, { max: number; windowMs: number }> = {
    "/report": { max: 3, windowMs: 60_000 },
    "/queue/join": { max: 12, windowMs: 60_000 },
    "/cases/vote": { max: 20, windowMs: 60_000 },
    "/timeout": { max: 6, windowMs: 60_000 },
    "/ban": { max: 6, windowMs: 60_000 },
    "/auth/steam": { max: 20, windowMs: 60_000 }
  };
  const steamReturnUrl = process.env.STEAM_RETURN_URL ?? "http://localhost:3001/auth/steam/callback";
  const relyingParty = new RelyingParty(
    steamReturnUrl,
    process.env.STEAM_REALM ?? "https://api.play.maro.run",
    true,
    false,
    []
  );

  const reportThreshold = Number(process.env.OVERWATCH_REPORT_THRESHOLD ?? 3);
  const reportReasons = ["cheating", "griefing", "toxic", "afk"] as const;
  const caseVotes = ["cheating", "griefing", "clean"] as const;
  const creatorStatuses = ["pending", "approved", "rejected"] as const;
  const queueModes = ["ranked", "wingman", "casual", "superpower", "gungame", "zombie", "clanwars"] as const;
  type QueueMode = (typeof queueModes)[number];
  const modeConfig: Record<QueueMode, { playersPerMatch: number; teamSize: number; unranked: boolean }> = {
    ranked: { playersPerMatch: 10, teamSize: 5, unranked: false },
    wingman: { playersPerMatch: 4, teamSize: 2, unranked: false },
    casual: { playersPerMatch: 20, teamSize: 10, unranked: true },
    superpower: { playersPerMatch: 20, teamSize: 10, unranked: true },
    gungame: { playersPerMatch: 20, teamSize: 10, unranked: true },
    zombie: { playersPerMatch: 20, teamSize: 10, unranked: true },
    clanwars: { playersPerMatch: 10, teamSize: 5, unranked: false }
  };
  const botApiToken = process.env.DISCORD_BOT_API_TOKEN ?? "";
  const skinCategories = ["primary", "pistol", "knife", "gloves"] as const;
  const communityMaps = ["de_mirage", "de_inferno", "de_dust2", "de_overpass", "de_ancient", "de_nuke", "de_vertigo"] as const;
  const verificationStateSecret = process.env.DISCORD_VERIFICATION_STATE_SECRET ?? internalWebhookSecret ?? process.env.JWT_SECRET ?? "";
  const steamApiKey = process.env.STEAM_API_KEY ?? "";
  const steamLinkTokenTtlSeconds = Number(process.env.STEAM_LINK_TOKEN_TTL_SECONDS ?? 900);
  const apiPublicBaseUrl = process.env.API_URL ?? process.env.PUBLIC_API_URL ?? "http://localhost:3001";
  const demoClipBaseUrl = process.env.DEMO_CLIP_BASE_URL ?? "";
  const banEvasionPlaytimeThreshold = Number(process.env.BAN_EVASION_PLAYTIME_SIMILARITY_THRESHOLD ?? 0.6);
  const banEvasionAlertCooldownSeconds = Number(process.env.BAN_EVASION_ALERT_COOLDOWN_SECONDS ?? 300);
  const progressionSkinPools: Record<string, Record<string, string[]>> = {
    basic_skins: {
      ak47: ["elite_build", "safari_mesh"],
      "m4a1-s": ["nitro", "basilisk"],
      awp: ["aether", "worm_god"]
    },
    rare_skins: {
      ak47: ["redline", "vulcan"],
      "m4a1-s": ["printstream", "golden_coil"],
      awp: ["asiimov", "wildfire"]
    },
    knife_skins: {
      knife: ["karambit_fade", "m9_doppler", "butterfly_slaughter"]
    },
    gloves: {
      gloves: ["specialist_fade", "driver_king_snake"]
    },
    exclusive_skins: {
      ak47: ["wild_lotus"],
      awp: ["gungnir"],
      knife: ["karambit_gamma_doppler"],
      gloves: ["sport_pandora"]
    }
  };
  const baseSmurfWeights: SmurfRiskWeights = {
    steamAgeLt30: Number(process.env.SMURF_WEIGHT_STEAM_AGE_LT_30 ?? DEFAULT_SMURF_WEIGHTS.steamAgeLt30),
    csHoursLt50: Number(process.env.SMURF_WEIGHT_CS_HOURS_LT_50 ?? DEFAULT_SMURF_WEIGHTS.csHoursLt50),
    lowMatchesHighAdr: Number(process.env.SMURF_WEIGHT_LOW_MATCHES_HIGH_ADR ?? DEFAULT_SMURF_WEIGHTS.lowMatchesHighAdr),
    highWinrateAfter15: Number(process.env.SMURF_WEIGHT_HIGH_WINRATE_AFTER_15 ?? DEFAULT_SMURF_WEIGHTS.highWinrateAfter15),
    highMmrGain: Number(process.env.SMURF_WEIGHT_HIGH_MMR_GAIN ?? DEFAULT_SMURF_WEIGHTS.highMmrGain),
    sustainedHighHs: Number(process.env.SMURF_WEIGHT_SUSTAINED_HIGH_HS ?? DEFAULT_SMURF_WEIGHTS.sustainedHighHs),
    sharedIp: Number(process.env.SMURF_WEIGHT_SHARED_IP ?? DEFAULT_SMURF_WEIGHTS.sharedIp),
    sharedIpBanned: Number(process.env.SMURF_WEIGHT_SHARED_IP_BANNED ?? DEFAULT_SMURF_WEIGHTS.sharedIpBanned),
    sharedDevice: Number(process.env.SMURF_WEIGHT_SHARED_DEVICE ?? DEFAULT_SMURF_WEIGHTS.sharedDevice),
    sharedDeviceBanned: Number(process.env.SMURF_WEIGHT_SHARED_DEVICE_BANNED ?? DEFAULT_SMURF_WEIGHTS.sharedDeviceBanned),
    reportPressure: Number(process.env.SMURF_WEIGHT_REPORT_PRESSURE ?? DEFAULT_SMURF_WEIGHTS.reportPressure),
    reportAccuracyPressure: Number(process.env.SMURF_WEIGHT_REPORT_ACCURACY ?? DEFAULT_SMURF_WEIGHTS.reportAccuracyPressure)
  };
  const fragBoxRarityWeights: Array<{ rarity: "common" | "rare" | "epic" | "legendary" | "mythic"; chance: number }> = [
    { rarity: "common", chance: 60 },
    { rarity: "rare", chance: 25 },
    { rarity: "epic", chance: 10 },
    { rarity: "legendary", chance: 4 },
    { rarity: "mythic", chance: 1 }
  ];
  const creatorBoxRarityWeights: Array<{ rarity: "common" | "rare" | "epic" | "legendary" | "mythic"; chance: number }> = [
    { rarity: "common", chance: 40 },
    { rarity: "rare", chance: 35 },
    { rarity: "epic", chance: 15 },
    { rarity: "legendary", chance: 8 },
    { rarity: "mythic", chance: 2 }
  ];
  const creatorMatchBonusDropChance = Number(process.env.CREATOR_MATCH_BONUS_DROP_CHANCE ?? 0.25);
  const creatorBoxBaseDropChance = Number(process.env.CREATOR_BOX_BASE_DROP_CHANCE ?? 0);
  const seasonDurationDays = Number(process.env.SEASON_DURATION_DAYS ?? 90);
  const seasonWeekendXpBoostMultiplier = Number(process.env.SEASON_WEEKEND_XP_BOOST_MULTIPLIER ?? 1.5);
  const premiumBattlepassTokenDropChance = Number(process.env.PREMIUM_BATTLEPASS_TOKEN_DROP_CHANCE ?? 0.005);
  const internalAllowedIps = (process.env.INTERNAL_ALLOWED_IPS ?? process.env.TRUSTED_NETWORKS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const matchmakingFlagKey = "platform:matchmaking:enabled";
  const matchmakingDefaultEnabled = (process.env.MATCHMAKING_ENABLED ?? "true").toLowerCase() !== "false";
  const matchmakingDisabledMessage = "Matchmaking temporarily disabled due to a scheduled update.";
  const clanWarsEnabled = (process.env.CLAN_WARS_ENABLED ?? "true").toLowerCase() !== "false";
  const clanRatingStart = Number(process.env.CLAN_RATING_START ?? 1000);
  const clanWinRating = Number(process.env.CLAN_WIN_RATING ?? 25);
  const clanLossRating = Number(process.env.CLAN_LOSS_RATING ?? 25);
  const clanMaxMembers = Number(process.env.CLAN_MAX_MEMBERS ?? 50);
  const usernamePattern = /^[a-zA-Z0-9_]{3,16}$/;
  const reservedUsernames = new Set(
    (process.env.RESERVED_USERNAMES ?? "admin,moderator,system,developer")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );

  function assertStrongRuntimeSecret(name: string, value: string): void {
    const lowered = value.toLowerCase();
    const placeholder =
      !value ||
      value.length < 32 ||
      lowered.includes("change-me") ||
      lowered.includes("changeme") ||
      lowered.includes("replace") ||
      lowered === "placeholder" ||
      lowered === "example";
    if (placeholder) {
      eventLogger.error("startup_secret_invalid", { secret_name: name, reason: "missing_or_weak" });
      throw new Error(`${name} must be set to a strong value (>=32 chars, non-placeholder)`);
    }
  }

  assertStrongRuntimeSecret("INTERNAL_API_TOKEN", internalApiToken);
  assertStrongRuntimeSecret("INTERNAL_WEBHOOK_SECRET", internalWebhookSecret);
  assertStrongRuntimeSecret("SERVER_MANAGER_API_TOKEN", serverManagerApiToken);
  await redis.set(matchmakingFlagKey, matchmakingDefaultEnabled ? "1" : "0", "NX");

  function normalizeCreatorCode(code: string): string {
    return code.replace(/[^a-zA-Z0-9_]/g, "").toUpperCase().slice(0, 24);
  }

  function buildRelyingParty(returnUrl: string): RelyingParty {
    return new RelyingParty(
      returnUrl,
      process.env.STEAM_REALM ?? "https://api.play.maro.run",
      true,
      false,
      []
    );
  }

  async function createSteamAuthUrl(returnUrl: string): Promise<string> {
    const rp = buildRelyingParty(returnUrl);
    return new Promise<string>((resolve, reject) => {
      rp.authenticate("https://steamcommunity.com/openid", false, (error: any, authUrlMaybe: any) => {
        if (error || !authUrlMaybe) {
          reject(error ?? new Error("No Steam auth URL"));
          return;
        }
        resolve(authUrlMaybe);
      });
    });
  }

  async function fetchSteamProfileSecurity(steamId: string): Promise<{
    steam_profile_url: string;
    steam_account_age: number | null;
    cs_hours: number | null;
    vac_bans: number;
  }> {
    const defaultProfileUrl = `https://steamcommunity.com/profiles/${steamId}`;
    if (!steamApiKey) {
      return {
        steam_profile_url: defaultProfileUrl,
        steam_account_age: null,
        cs_hours: null,
        vac_bans: 0
      };
    }

    let steamProfileUrl = defaultProfileUrl;
    let steamAccountAge: number | null = null;
    let csHours: number | null = null;
    let vacBans = 0;

    try {
      const summaryUrl = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
      summaryUrl.searchParams.set("key", steamApiKey);
      summaryUrl.searchParams.set("steamids", steamId);
      const res = await fetch(summaryUrl.toString());
      if (res.ok) {
        const payload: any = await res.json();
        const player = payload?.response?.players?.[0];
        if (player?.profileurl) steamProfileUrl = String(player.profileurl);
        if (player?.timecreated) {
          const createdMs = Number(player.timecreated) * 1000;
          if (Number.isFinite(createdMs) && createdMs > 0) {
            steamAccountAge = Math.floor((Date.now() - createdMs) / (24 * 60 * 60 * 1000));
          }
        }
      }
    } catch {
      // best effort; keep defaults
    }

    try {
      const gamesUrl = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
      gamesUrl.searchParams.set("key", steamApiKey);
      gamesUrl.searchParams.set("steamid", steamId);
      gamesUrl.searchParams.set("include_played_free_games", "1");
      gamesUrl.searchParams.set("appids_filter[0]", "730");
      const res = await fetch(gamesUrl.toString());
      if (res.ok) {
        const payload: any = await res.json();
        const game = payload?.response?.games?.find((g: any) => Number(g?.appid) === 730);
        if (game && Number.isFinite(Number(game.playtime_forever))) {
          csHours = Math.floor(Number(game.playtime_forever) / 60);
        }
      }
    } catch {
      // best effort; keep defaults
    }

    try {
      const bansUrl = new URL("https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/");
      bansUrl.searchParams.set("key", steamApiKey);
      bansUrl.searchParams.set("steamids", steamId);
      const res = await fetch(bansUrl.toString());
      if (res.ok) {
        const payload: any = await res.json();
        const player = payload?.players?.[0];
        vacBans = Math.max(0, Number(player?.NumberOfVACBans ?? 0));
      }
    } catch {
      // best effort; keep defaults
    }

    return {
      steam_profile_url: steamProfileUrl,
      steam_account_age: steamAccountAge,
      cs_hours: csHours,
      vac_bans: vacBans
    };
  }

  function hashIp(rawIp: string): string {
    return crypto.createHash("sha256").update(rawIp).digest("hex");
  }

  function hashOptional(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return crypto.createHash("sha256").update(trimmed).digest("hex");
  }

  function normalizeProvidedHash(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^[a-zA-Z0-9:_-]{8,256}$/.test(trimmed)) return null;
    return trimmed;
  }

  function ipRangeBucket(rawIp: string): string {
    const ip = rawIp.trim();
    if (!ip) return "unknown";
    if (ip.includes(".")) {
      const parts = ip.split(".");
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      }
    }
    if (ip.includes(":")) {
      const parts = ip.split(":");
      return `${parts.slice(0, 4).join(":")}::/64`;
    }
    return "unknown";
  }

  function signDiscordVerificationState(discordId: string): string {
    const payload = {
      discord_id: discordId,
      ts: Date.now(),
      nonce: crypto.randomBytes(8).toString("hex")
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", verificationStateSecret).update(encoded).digest("hex");
    return `${encoded}.${sig}`;
  }

  function readDiscordVerificationState(state: string): { discord_id: string; ts: number; nonce: string } | null {
    if (!verificationStateSecret) return null;
    const [encoded, sig] = state.split(".");
    if (!encoded || !sig) return null;
    const expected = crypto.createHmac("sha256", verificationStateSecret).update(encoded).digest("hex");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!parsed?.discord_id || !parsed?.ts || !parsed?.nonce) return null;
      if (Math.abs(Date.now() - Number(parsed.ts)) > 15 * 60 * 1000) return null;
      return {
        discord_id: String(parsed.discord_id),
        ts: Number(parsed.ts),
        nonce: String(parsed.nonce)
      };
    } catch {
      return null;
    }
  }

  function secureHexEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  async function enforceAccountRateLimit(input: {
    route: string;
    request: any;
    reply: any;
    steamId?: string | null;
    discordId?: string | null;
    max: number;
    windowSec: number;
  }): Promise<boolean> {
    const ip = String(input.request.ip ?? "unknown");
    const discordId = String(input.discordId ?? input.request.headers["x-discord-user-id"] ?? "").trim();
    const steamId = String(input.steamId ?? input.request.headers["x-steam-id"] ?? "").trim();
    const identities = [
      discordId ? `discord:${discordId}` : "",
      steamId ? `steam:${steamId}` : "",
      `ip:${ip}`
    ].filter(Boolean);

    for (const identity of identities) {
      const key = `acct:rate:${input.route}:${identity}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, input.windowSec);
      }
      if (count > input.max) {
        metrics.rate_limit_hits += 1;
        metrics.blocked_requests += 1;
        await redis.publish(
          "security-events",
          JSON.stringify({
            type: "high_request_rate_blocked",
            route: input.route,
            identity
          })
        );
        await input.reply.code(429).send({ error: "Too many requests" });
        return false;
      }
    }
    return true;
  }

  async function isMatchmakingEnabled(): Promise<boolean> {
    const value = await redis.get(matchmakingFlagKey);
    if (value === null) return matchmakingDefaultEnabled;
    return value === "1" || value.toLowerCase() === "true";
  }

  async function verifyTelemetryRequest(request: any, reply: any): Promise<boolean> {
    if (!telemetryWebhookSecret) {
      return true;
    }

    const timestamp = String(request.headers["x-telemetry-timestamp"] ?? "");
    const nonce = String(request.headers["x-telemetry-nonce"] ?? "");
    const signature = String(request.headers["x-telemetry-signature"] ?? "");
    if (!timestamp || !nonce || !signature) {
      metrics.telemetry_rejected += 1;
      await reply.code(401).send({ error: "Missing telemetry signature headers" });
      return false;
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > telemetryMaxSkewMs) {
      metrics.telemetry_rejected += 1;
      await reply.code(401).send({ error: "Invalid telemetry timestamp" });
      return false;
    }

    if (!/^[a-zA-Z0-9_-]{12,128}$/.test(nonce)) {
      metrics.telemetry_rejected += 1;
      await reply.code(401).send({ error: "Invalid telemetry nonce" });
      return false;
    }

    const nonceOk = await redis.set(`telemetry:nonce:${nonce}`, "1", "EX", telemetryNonceTtlSeconds, "NX");
    if (nonceOk !== "OK") {
      metrics.telemetry_rejected += 1;
      await reply.code(409).send({ error: "Telemetry replay detected" });
      return false;
    }

    const route = String(request.url ?? "").split("?")[0];
    const bodyRaw = request.body ? JSON.stringify(request.body) : "";
    const bodyHash = crypto.createHash("sha256").update(bodyRaw).digest("hex");
    const payload = `${timestamp}.${nonce}.${String(request.method ?? "POST").toUpperCase()}.${route}.${bodyHash}`;
    const expected = crypto.createHmac("sha256", telemetryWebhookSecret).update(payload).digest("hex");
    if (!secureHexEqual(expected, signature)) {
      metrics.telemetry_rejected += 1;
      await reply.code(401).send({ error: "Invalid telemetry signature" });
      return false;
    }

    return true;
  }

  async function assertVerifiedDiscordSteam(
    request: any,
    reply: any,
    expectedSteamId?: string
  ): Promise<{ discordId: string; steamId: string } | null> {
    const discordId = String(request.headers["x-discord-user-id"] ?? "").trim();
    if (!discordId) {
      await reply.code(401).send({ error: "Discord verification required" });
      return null;
    }
    const linked = await db.query(
      "SELECT discord_id, steam_id FROM steam_links WHERE discord_id = $1",
      [discordId]
    );
    const fallback = linked.rowCount
      ? linked
      : await db.query("SELECT discord_id, steam_id FROM verified_users WHERE discord_id = $1", [discordId]);
    if (!fallback.rowCount) {
      await reply.code(403).send({ error: "User is not verified" });
      return null;
    }
    const steamId = String(fallback.rows[0].steam_id);
    if (expectedSteamId && steamId !== expectedSteamId) {
      await reply.code(403).send({ error: "Steam account does not match verified Discord account" });
      return null;
    }
    return { discordId, steamId };
  }

  function normalizeUsername(input: string): string {
    return input.trim();
  }

  function validateUsernameOrThrow(input: string): string {
    const username = normalizeUsername(input);
    if (!usernamePattern.test(username)) {
      throw new Error("Username must be 3-16 chars and only contain letters, numbers, and underscore.");
    }
    if (reservedUsernames.has(username.toLowerCase())) {
      throw new Error("Username is reserved.");
    }
    return username;
  }

  async function getUsernameBySteamId(steamId: string): Promise<string | null> {
    const user = await db.query("SELECT username FROM users WHERE steam_id = $1", [steamId]);
    if (!user.rowCount) return null;
    return String(user.rows[0].username);
  }

  const clanTagPattern = /^[A-Z0-9]{3,5}$/;
  const reservedClanTags = new Set(
    (process.env.CLAN_RESERVED_TAGS ?? "DEV,MOD,ADMIN,STAFF,SYS,OWNER")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
  );

  function normalizeClanTag(input: string): string {
    return input.trim().toUpperCase();
  }

  function validateClanNameOrThrow(input: string): string {
    const value = input.trim();
    if (!/^[a-zA-Z0-9 _-]{3,32}$/.test(value)) {
      throw new Error("Clan name must be 3-32 chars (letters, numbers, space, underscore, hyphen).");
    }
    return value;
  }

  function validateClanTagOrThrow(input: string): string {
    const tag = normalizeClanTag(input);
    if (!clanTagPattern.test(tag)) {
      throw new Error("Clan tag must be 3-5 chars using A-Z and 0-9.");
    }
    if (reservedClanTags.has(tag)) {
      throw new Error("Clan tag is reserved.");
    }
    return tag;
  }

  type SelectedTagType = "dev" | "admin" | "mod" | "clan" | "none";

  function staffTagFromRole(role: string | null | undefined): "DEV" | "ADMIN" | "MOD" | null {
    const normalized = String(role ?? "").toLowerCase();
    if (normalized === "developer" || normalized === "dev") return "DEV";
    if (normalized === "admin") return "ADMIN";
    if (normalized === "moderator" || normalized === "mod") return "MOD";
    return null;
  }

  function canUseTagType(role: string, requested: SelectedTagType, clanTag: string | null): boolean {
    const normalized = String(role ?? "").toLowerCase();
    if (requested === "none") return true;
    if (requested === "clan") return Boolean(clanTag);
    if (requested === "dev") return normalized === "developer" || normalized === "dev";
    if (requested === "admin") return normalized === "admin";
    if (requested === "mod") return normalized === "moderator" || normalized === "mod";
    return false;
  }

  function normalizeSelectedTagType(
    requested: string | null | undefined,
    role: string,
    clanTag: string | null
  ): SelectedTagType {
    const value = String(requested ?? "none").toLowerCase() as SelectedTagType;
    const allowedValues: SelectedTagType[] = ["dev", "admin", "mod", "clan", "none"];
    const requestedSafe: SelectedTagType = allowedValues.includes(value) ? value : "none";
    if (canUseTagType(role, requestedSafe, clanTag)) return requestedSafe;
    if (canUseTagType(role, "clan", clanTag)) return "clan";
    return "none";
  }

  function tagTypeToLabel(type: SelectedTagType): "DEV" | "ADMIN" | "MOD" | string | null {
    if (type === "dev") return "DEV";
    if (type === "admin") return "ADMIN";
    if (type === "mod") return "MOD";
    return null;
  }

  function formatTaggedName(username: string, selectedTagType: SelectedTagType, clanTag: string | null): string {
    const effectiveTag =
      selectedTagType === "clan"
        ? clanTag
        : tagTypeToLabel(selectedTagType);
    return effectiveTag ? `[${effectiveTag}] ${username}` : username;
  }

  async function getPlayerIdentityBySteamId(steamId: string): Promise<{
    steam_id: string;
    username: string;
    role: string;
    clan_tag: string | null;
    staff_tag: string | null;
    selected_tag_type: SelectedTagType;
    available_tag_types: SelectedTagType[];
    display_name: string;
  } | null> {
    const row = await db.query(
      `SELECT
         u.steam_id,
         u.username,
         u.selected_tag_type,
         COALESCE(p.role, 'player') AS role,
         c.clan_tag
       FROM users u
       LEFT JOIN players p ON p.steam_id = u.steam_id
       LEFT JOIN clan_members cm ON cm.steam_id = u.steam_id
       LEFT JOIN clans c ON c.clan_id = cm.clan_id
       WHERE u.steam_id = $1
       LIMIT 1`,
      [steamId]
    );
    if (!row.rowCount) return null;
    const username = String(row.rows[0].username);
    const role = String(row.rows[0].role ?? "player");
    const clanTag = row.rows[0].clan_tag ? String(row.rows[0].clan_tag) : null;
    const staffTag = staffTagFromRole(role);
    const selectedTagType = normalizeSelectedTagType(String(row.rows[0].selected_tag_type ?? "none"), role, clanTag);
    if (selectedTagType !== String(row.rows[0].selected_tag_type ?? "none").toLowerCase()) {
      await db.query(
        "UPDATE users SET selected_tag_type = $1 WHERE steam_id = $2",
        [selectedTagType, steamId]
      );
    }
    const availableTagTypes: SelectedTagType[] = ["none"];
    if (canUseTagType(role, "clan", clanTag)) availableTagTypes.push("clan");
    if (canUseTagType(role, "dev", clanTag)) availableTagTypes.push("dev");
    if (canUseTagType(role, "admin", clanTag)) availableTagTypes.push("admin");
    if (canUseTagType(role, "mod", clanTag)) availableTagTypes.push("mod");
    return {
      steam_id: String(row.rows[0].steam_id),
      username,
      role,
      clan_tag: clanTag,
      staff_tag: staffTag,
      selected_tag_type: selectedTagType,
      available_tag_types: availableTagTypes,
      display_name: formatTaggedName(username, selectedTagType, clanTag)
    };
  }

  async function refreshPlayerDisplayName(steamId: string): Promise<void> {
    const identity = await getPlayerIdentityBySteamId(steamId);
    if (!identity) return;
    await db.query("UPDATE players SET display_name = $1 WHERE steam_id = $2", [
      identity.display_name,
      steamId
    ]);
  }

  async function ensureClanRatingRow(clanId: string): Promise<void> {
    await db.query(
      `INSERT INTO clan_ratings (clan_id, rating, wins, losses, matches_played)
       VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (clan_id) DO NOTHING`,
      [clanId, clanRatingStart]
    );
  }

  function calculateEloDelta(currentRating: number, opponentRating: number, actualScore: 0 | 1): number {
    const expected = 1 / (1 + Math.pow(10, (opponentRating - currentRating) / 400));
    const baseK = actualScore === 1 ? clanWinRating : clanLossRating;
    return Math.round(baseK * (actualScore - expected));
  }

  async function recomputeClanLeaderboard(seasonId: string): Promise<void> {
    const rows = await db.query(
      `SELECT cr.clan_id, c.clan_tag, cr.rating, cr.wins, cr.losses, cr.matches_played
       FROM clan_ratings cr
       JOIN clans c ON c.clan_id = cr.clan_id
       ORDER BY cr.rating DESC, cr.wins DESC, cr.matches_played DESC, c.clan_tag ASC`
    );
    let rank = 1;
    for (const row of rows.rows) {
      await db.query(
        `INSERT INTO clan_leaderboard (season_id, clan_id, rank, rating, wins, losses, matches_played, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (season_id, clan_id)
         DO UPDATE SET
           rank = EXCLUDED.rank,
           rating = EXCLUDED.rating,
           wins = EXCLUDED.wins,
           losses = EXCLUDED.losses,
           matches_played = EXCLUDED.matches_played,
           updated_at = NOW()`,
        [
          seasonId,
          String(row.clan_id),
          rank,
          Number(row.rating ?? clanRatingStart),
          Number(row.wins ?? 0),
          Number(row.losses ?? 0),
          Number(row.matches_played ?? 0)
        ]
      );
      rank += 1;
    }
  }

  async function grantClanSeasonRewards(seasonId: string): Promise<Array<{ rank: number; clan_tag: string }>> {
    const top = await db.query(
      `SELECT cl.rank, cl.clan_id, cl.rating, cl.wins, cl.losses, cl.matches_played, c.clan_tag
       FROM clan_leaderboard cl
       JOIN clans c ON c.clan_id = cl.clan_id
       WHERE cl.season_id = $1
       ORDER BY cl.rank ASC
       LIMIT 10`,
      [seasonId]
    );

    for (const row of top.rows) {
      const rank = Number(row.rank ?? 999);
      const clanId = String(row.clan_id);
      await db.query(
        `INSERT INTO clan_season_results (season_id, clan_id, final_rating, final_rank, wins, losses, matches_played)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (season_id, clan_id)
         DO UPDATE SET
           final_rating = EXCLUDED.final_rating,
           final_rank = EXCLUDED.final_rank,
           wins = EXCLUDED.wins,
           losses = EXCLUDED.losses,
           matches_played = EXCLUDED.matches_played`,
        [
          seasonId,
          clanId,
          Number(row.rating ?? clanRatingStart),
          rank,
          Number(row.wins ?? 0),
          Number(row.losses ?? 0),
          Number(row.matches_played ?? 0)
        ]
      );

      let rewardType: string | null = null;
      if (rank === 1) rewardType = "season_champion_bundle";
      else if (rank === 2) rewardType = "season_runnerup_bundle";
      else if (rank === 3) rewardType = "season_third_place_bundle";
      if (!rewardType) continue;

      await db.query(
        `INSERT INTO clan_rewards (clan_id, reward_type, season_id, granted_at)
         VALUES ($1, $2, $3, NOW())`,
        [clanId, rewardType, seasonId]
      );

      const members = await db.query(
        `SELECT p.id AS player_id
         FROM clan_members cm
         JOIN players p ON p.steam_id = cm.steam_id
         WHERE cm.clan_id = $1`,
        [clanId]
      );
      for (const member of members.rows) {
        const playerId = String(member.player_id);
        if (rank === 1) {
          await db.query(
            `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
             VALUES ($1, 'clan_season_champion_badge', 'exclusive_skins', 'Clan season champion')
             ON CONFLICT (player_id, reward_code) DO NOTHING`,
            [playerId]
          );
          await db.query(
            `INSERT INTO player_inventory (steam_id, item_type, rarity, obtained_at)
             SELECT steam_id, 'premium_battlepass_token', 'mythic', NOW()
             FROM players
             WHERE id = $1`,
            [playerId]
          );
        } else if (rank === 2) {
          await db.query(
            `INSERT INTO player_inventory (steam_id, item_type, rarity, obtained_at)
             SELECT steam_id, 'premium_battlepass_token', 'legendary', NOW()
             FROM players
             WHERE id = $1`,
            [playerId]
          );
        } else if (rank === 3) {
          await db.query(
            `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
             VALUES ($1, 'clan_season_top3_rare_skin', 'rare_skins', 'Clan season top 3')
             ON CONFLICT (player_id, reward_code) DO NOTHING`,
            [playerId]
          );
        }
      }
    }

    return top.rows.map((r) => ({ rank: Number(r.rank), clan_tag: String(r.clan_tag) }));
  }

  async function applyClanWarResult(input: {
    matchId: string;
    teamAScore: number;
    teamBScore: number;
  }): Promise<{
    updated: boolean;
    winner_clan_id: string | null;
    clan_a_tag: string | null;
    clan_b_tag: string | null;
    clan_a_rating: number | null;
    clan_b_rating: number | null;
  }> {
    const clansByTeam = await db.query(
      `SELECT mp.team, c.clan_id, c.clan_tag
       FROM match_players mp
       JOIN players p ON p.id = mp.player_id
       JOIN clan_members cm ON cm.steam_id = p.steam_id
       JOIN clans c ON c.clan_id = cm.clan_id
       WHERE mp.match_id = $1
       GROUP BY mp.team, c.clan_id, c.clan_tag
       ORDER BY mp.team, c.clan_tag`,
      [input.matchId]
    );

    const teamAClans = clansByTeam.rows.filter((r) => String(r.team) === "A");
    const teamBClans = clansByTeam.rows.filter((r) => String(r.team) === "B");
    if (teamAClans.length !== 1 || teamBClans.length !== 1) {
      return {
        updated: false,
        winner_clan_id: null,
        clan_a_tag: null,
        clan_b_tag: null,
        clan_a_rating: null,
        clan_b_rating: null
      };
    }

    const clanAId = String(teamAClans[0].clan_id);
    const clanBId = String(teamBClans[0].clan_id);
    const clanATag = String(teamAClans[0].clan_tag);
    const clanBTag = String(teamBClans[0].clan_tag);
    await ensureClanRatingRow(clanAId);
    await ensureClanRatingRow(clanBId);

    const ratings = await db.query(
      `SELECT clan_id, rating, wins, losses, matches_played
       FROM clan_ratings
       WHERE clan_id = ANY($1::uuid[])`,
      [[clanAId, clanBId]]
    );
    const rowA = ratings.rows.find((r) => String(r.clan_id) === clanAId);
    const rowB = ratings.rows.find((r) => String(r.clan_id) === clanBId);
    const ratingA = Number(rowA?.rating ?? clanRatingStart);
    const ratingB = Number(rowB?.rating ?? clanRatingStart);

    const teamAWin = input.teamAScore > input.teamBScore;
    const teamBWin = input.teamBScore > input.teamAScore;
    if (!teamAWin && !teamBWin) {
      return {
        updated: false,
        winner_clan_id: null,
        clan_a_tag: clanATag,
        clan_b_tag: clanBTag,
        clan_a_rating: ratingA,
        clan_b_rating: ratingB
      };
    }
    const deltaA = calculateEloDelta(ratingA, ratingB, teamAWin ? 1 : 0);
    const deltaB = calculateEloDelta(ratingB, ratingA, teamBWin ? 1 : 0);
    const newA = Math.max(100, ratingA + deltaA);
    const newB = Math.max(100, ratingB + deltaB);

    await db.query(
      `UPDATE clan_ratings
       SET rating = $2,
           wins = wins + $3,
           losses = losses + $4,
           matches_played = matches_played + 1,
           last_match = NOW()
       WHERE clan_id = $1`,
      [clanAId, newA, teamAWin ? 1 : 0, teamAWin ? 0 : 1]
    );
    await db.query(
      `UPDATE clan_ratings
       SET rating = $2,
           wins = wins + $3,
           losses = losses + $4,
           matches_played = matches_played + 1,
           last_match = NOW()
       WHERE clan_id = $1`,
      [clanBId, newB, teamBWin ? 1 : 0, teamBWin ? 0 : 1]
    );

    const season = await ensureActiveSeason();
    await db.query(
      `INSERT INTO clan_war_matches (match_id, season_id, clan_a_id, clan_b_id, clan_a_score, clan_b_score, winner_clan_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (match_id)
       DO UPDATE SET
         season_id = EXCLUDED.season_id,
         clan_a_id = EXCLUDED.clan_a_id,
         clan_b_id = EXCLUDED.clan_b_id,
         clan_a_score = EXCLUDED.clan_a_score,
         clan_b_score = EXCLUDED.clan_b_score,
         winner_clan_id = EXCLUDED.winner_clan_id`,
      [input.matchId, season.season_id, clanAId, clanBId, input.teamAScore, input.teamBScore, teamAWin ? clanAId : clanBId]
    );
    await recomputeClanLeaderboard(season.season_id);
    return {
      updated: true,
      winner_clan_id: teamAWin ? clanAId : clanBId,
      clan_a_tag: clanATag,
      clan_b_tag: clanBTag,
      clan_a_rating: newA,
      clan_b_rating: newB
    };
  }

  async function getPlayerPlayHours(playerId: string): Promise<Set<number>> {
    const rows = await db.query(
      `SELECT EXTRACT(HOUR FROM COALESCE(m.started_at, m.created_at))::int AS hour
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = $1
       ORDER BY COALESCE(m.started_at, m.created_at) DESC
       LIMIT 40`,
      [playerId]
    );
    return new Set(rows.rows.map((r) => Number(r.hour)).filter((h) => Number.isFinite(h)));
  }

  function playtimeSimilarity(a: Set<number>, b: Set<number>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const hour of a) {
      if (b.has(hour) || b.has((hour + 23) % 24) || b.has((hour + 1) % 24)) {
        overlap += 1;
      }
    }
    return overlap / Math.max(1, a.size);
  }

  async function detectBanEvasion(input: {
    steamId: string;
    discordId: string;
    playerId: string;
    steamAccountAgeDays?: number | null;
    discordAccountCreatedAt?: string | null;
    discordInviteSource?: string | null;
    hardwareHash?: string | null;
    ipRangeHash?: string | null;
  }): Promise<{
    blocked: boolean;
    flagged: boolean;
    case?: any;
    matched_account?: string | null;
    suspicion_score: number;
    reasons: string[];
  }> {
    const verified = await db.query("SELECT ip_hash FROM verified_users WHERE discord_id = $1", [input.discordId]);
    const ipHash = verified.rowCount ? String(verified.rows[0].ip_hash ?? "") : "";
    const existingIdentifiers = await db.query(
      "SELECT ip_range_hash, hardware_hash FROM player_identifiers WHERE steam_id = $1",
      [input.steamId]
    );
    const ipRangeHash =
      hashOptional(input.ipRangeHash) ??
      (existingIdentifiers.rowCount ? String(existingIdentifiers.rows[0].ip_range_hash ?? "") || null : null);
    const hardwareHash =
      hashOptional(input.hardwareHash) ??
      (existingIdentifiers.rowCount ? String(existingIdentifiers.rows[0].hardware_hash ?? "") || null : null);

    await db.query(
      `INSERT INTO player_identifiers (
         steam_id, discord_id, ip_hash, ip_range_hash, hardware_hash, discord_invite_source, discord_account_created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (steam_id) DO UPDATE
       SET discord_id = EXCLUDED.discord_id,
           ip_hash = COALESCE(EXCLUDED.ip_hash, player_identifiers.ip_hash),
           ip_range_hash = COALESCE(EXCLUDED.ip_range_hash, player_identifiers.ip_range_hash),
           hardware_hash = COALESCE(EXCLUDED.hardware_hash, player_identifiers.hardware_hash),
           discord_invite_source = COALESCE(EXCLUDED.discord_invite_source, player_identifiers.discord_invite_source),
           discord_account_created_at = COALESCE(EXCLUDED.discord_account_created_at, player_identifiers.discord_account_created_at),
           updated_at = NOW()`,
      [
        input.steamId,
        input.discordId,
        ipHash || null,
        ipRangeHash,
        hardwareHash,
        input.discordInviteSource ?? null,
        input.discordAccountCreatedAt ?? null
      ]
    );

    const bannedMatches = await db.query(
      `SELECT
         p.id AS player_id,
         p.steam_id,
         pi.discord_id,
         pi.ip_hash,
         pi.ip_range_hash,
         pi.hardware_hash,
         pi.discord_invite_source,
         pi.discord_account_created_at
       FROM players p
       LEFT JOIN player_identifiers pi ON pi.steam_id = p.steam_id
       WHERE p.steam_id <> $1
         AND (p.permanent_ban = TRUE OR (p.banned_until IS NOT NULL AND p.banned_until > NOW()))`,
      [input.steamId]
    );

    const candidatePlayHours = await getPlayerPlayHours(input.playerId);
    let bestScore = 0;
    let best: any = null;
    let bestReasons: string[] = [];

    for (const banned of bannedMatches.rows) {
      const bannedPlayHours = await getPlayerPlayHours(String(banned.player_id));
      const similarity = playtimeSimilarity(candidatePlayHours, bannedPlayHours);
      const candidateDiscordCreatedAt = input.discordAccountCreatedAt ? new Date(input.discordAccountCreatedAt).getTime() : 0;
      const bannedDiscordCreatedAt = banned.discord_account_created_at ? new Date(banned.discord_account_created_at).getTime() : 0;
      const discordCreationPatternMatch =
        candidateDiscordCreatedAt > 0 &&
        bannedDiscordCreatedAt > 0 &&
        Math.abs(candidateDiscordCreatedAt - bannedDiscordCreatedAt) <= 14 * 24 * 60 * 60 * 1000;
      const scoring = calculateBanEvasionScore({
        steamAccountAgeDays: input.steamAccountAgeDays ?? null,
        sharedIpHash: Boolean(ipHash && banned.ip_hash && banned.ip_hash === ipHash),
        sharedHardwareHash: Boolean(hardwareHash && banned.hardware_hash && banned.hardware_hash === hardwareHash),
        sharedIpRange: Boolean(ipRangeHash && banned.ip_range_hash && banned.ip_range_hash === ipRangeHash),
        sameDiscordInviteSource: Boolean(
          input.discordInviteSource &&
            banned.discord_invite_source &&
            String(input.discordInviteSource) === String(banned.discord_invite_source)
        ),
        playTimeSimilarity: similarity,
        discordCreationPatternMatch
      });
      if (similarity >= banEvasionPlaytimeThreshold && !scoring.reasons.some((x) => x.includes("play-time"))) {
        scoring.reasons.push("play-time similarity above threshold");
      }
      if (scoring.suspicion_score > bestScore) {
        bestScore = scoring.suspicion_score;
        best = { ...banned, playtime_similarity: similarity };
        bestReasons = scoring.reasons;
      }
    }

    const fallbackScore = calculateBanEvasionScore({
      steamAccountAgeDays: input.steamAccountAgeDays ?? null,
      sharedIpHash: false,
      sharedHardwareHash: false,
      sharedIpRange: false,
      sameDiscordInviteSource: false,
      playTimeSimilarity: 0,
      discordCreationPatternMatch: false
    });

    const suspicionScore = best ? bestScore : fallbackScore.suspicion_score;
    const status = suspicionScore > 8 ? "blocked" : suspicionScore > 5 ? "flagged" : "normal";
    const reasons = best ? bestReasons : fallbackScore.reasons;
    if (status === "normal") {
      return {
        blocked: false,
        flagged: false,
        matched_account: null,
        suspicion_score: suspicionScore,
        reasons
      };
    }

    const created = await db.query(
      `INSERT INTO ban_evasion_cases (steam_id, discord_id, suspicion_score, matched_account, status, reasons, evidence, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW())
       RETURNING *`,
      [
        input.steamId,
        input.discordId,
        suspicionScore,
        best?.steam_id ?? null,
        status === "blocked" ? "blocked" : "flagged",
        JSON.stringify(reasons),
        JSON.stringify({
          steam_account_age_days: input.steamAccountAgeDays ?? null,
          playtime_similarity: best?.playtime_similarity ?? 0,
          matched_identifiers: {
            ip_hash: Boolean(ipHash && best?.ip_hash && best.ip_hash === ipHash),
            hardware_hash: Boolean(hardwareHash && best?.hardware_hash && best.hardware_hash === hardwareHash),
            ip_range_hash: Boolean(ipRangeHash && best?.ip_range_hash && best.ip_range_hash === ipRangeHash),
            discord_invite_source: Boolean(
              input.discordInviteSource &&
                best?.discord_invite_source &&
                String(input.discordInviteSource) === String(best.discord_invite_source)
            )
          }
        })
      ]
    );

    const caseRow = created.rows[0];
    const alertKey = `ban-evasion:alert:${input.steamId}:${best?.steam_id ?? "none"}`;
    const shouldPublish = (await redis.set(alertKey, "1", "EX", banEvasionAlertCooldownSeconds, "NX")) === "OK";
    if (shouldPublish) {
      await redis.publish(
        "overwatch-events",
        JSON.stringify({
          type: "ban_evasion_alert",
          case: caseRow,
          steam_id: input.steamId,
          discord_id: input.discordId,
          suspicion_score: suspicionScore,
          matched_account: best?.steam_id ?? null,
          reasons
        })
      );
      await createModerationLog({
        action: "ban_evasion_alert",
        playerId: input.playerId,
        reason: `score=${suspicionScore}; matched=${best?.steam_id ?? "n/a"}`
      });
    }

    return {
      blocked: status === "blocked",
      flagged: status === "flagged",
      case: caseRow,
      matched_account: best?.steam_id ?? null,
      suspicion_score: suspicionScore,
      reasons
    };
  }

  async function getAdaptiveSmurfWeights(): Promise<SmurfRiskWeights> {
    const feedback = await db.query(
      `SELECT
         SUM(CASE WHEN status IN ('false_positive', 'allow') THEN 1 ELSE 0 END)::int AS false_positive,
         SUM(CASE WHEN status IN ('true_positive', 'block_ranked', 'blocked', 'banned') THEN 1 ELSE 0 END)::int AS true_positive
       FROM risk_alerts
       WHERE type = 'smurf'`
    );
    const falsePositives = Number(feedback.rows[0]?.false_positive ?? 0);
    const truePositives = Number(feedback.rows[0]?.true_positive ?? 0);
    const total = falsePositives + truePositives;
    if (total < 10) {
      return { ...baseSmurfWeights };
    }

    const falseRate = falsePositives / Math.max(1, total);
    const scale = falseRate > 0.5 ? 0.92 : 1.05;
    return {
      steamAgeLt30: Math.round(baseSmurfWeights.steamAgeLt30 * scale),
      csHoursLt50: Math.round(baseSmurfWeights.csHoursLt50 * scale),
      lowMatchesHighAdr: Math.round(baseSmurfWeights.lowMatchesHighAdr * scale),
      highWinrateAfter15: Math.round(baseSmurfWeights.highWinrateAfter15 * scale),
      highMmrGain: Math.round(baseSmurfWeights.highMmrGain * scale),
      sustainedHighHs: Math.round(baseSmurfWeights.sustainedHighHs * scale),
      sharedIp: baseSmurfWeights.sharedIp,
      sharedIpBanned: baseSmurfWeights.sharedIpBanned,
      sharedDevice: baseSmurfWeights.sharedDevice,
      sharedDeviceBanned: baseSmurfWeights.sharedDeviceBanned,
      reportPressure: Math.round(baseSmurfWeights.reportPressure * scale),
      reportAccuracyPressure: Math.round(baseSmurfWeights.reportAccuracyPressure * scale)
    };
  }

  async function resolveSmurfRiskForPlayer(input: {
    playerId: string;
    steamId: string;
    discordId?: string | null;
    ipHash?: string | null;
    deviceHash?: string | null;
  }): Promise<{
    smurf_score: number;
    ban_evasion_score: number;
    status: "normal" | "suspected_smurf" | "high_suspicion" | "ban_evasion_likely";
    reasons: string[];
    matched_accounts: string[];
  }> {
    const steam = await db.query(
      `SELECT steam_account_age, cs_hours, vac_bans
       FROM steam_links
       WHERE steam_id = $1`,
      [input.steamId]
    );
    const security = steam.rowCount ? steam.rows[0] : { steam_account_age: null, cs_hours: null, vac_bans: 0 };

    const profile = await db.query(
      `SELECT p.id, p.mmr, p.wingman_mmr, ps.wins, ps.losses, ps.matches_played
       FROM players p
       LEFT JOIN player_stats ps ON ps.player_id = p.id
       WHERE p.id = $1`,
      [input.playerId]
    );
    if (!profile.rowCount) {
      return { smurf_score: 0, ban_evasion_score: 0, status: "normal", reasons: [], matched_accounts: [] };
    }
    const p = profile.rows[0];
    const matchesPlayed = Number(p.matches_played ?? 0);
    const wins = Number(p.wins ?? 0);

    const modeStats = await db.query(
      `SELECT
         m.mode,
         COUNT(*)::int AS matches,
         AVG(COALESCE((pm.metrics_json->>'adr')::numeric, 0))::float8 AS avg_adr,
         AVG(COALESCE((pm.metrics_json->>'kd')::numeric, 0))::float8 AS avg_kd,
         AVG(COALESCE((pm.metrics_json->>'headshot_rate')::numeric, 0))::float8 AS avg_hs
       FROM player_match_metrics pm
       JOIN matches m ON m.id = pm.match_id
       WHERE pm.steam_id = $1
         AND m.mode IN ('ranked', 'wingman')
       GROUP BY m.mode`,
      [input.steamId]
    );
    const rankedStats = modeStats.rows.find((r) => String(r.mode) === "ranked");
    const wingmanStats = modeStats.rows.find((r) => String(r.mode) === "wingman");
    const weightedMatches = Number(rankedStats?.matches ?? 0) + Number(wingmanStats?.matches ?? 0);
    const adr =
      weightedMatches > 0
        ? ((Number(rankedStats?.avg_adr ?? 0) * Number(rankedStats?.matches ?? 0)) +
          (Number(wingmanStats?.avg_adr ?? 0) * Number(wingmanStats?.matches ?? 0))) /
          weightedMatches
        : 0;
    const kd =
      weightedMatches > 0
        ? ((Number(rankedStats?.avg_kd ?? 0) * Number(rankedStats?.matches ?? 0)) +
          (Number(wingmanStats?.avg_kd ?? 0) * Number(wingmanStats?.matches ?? 0))) /
          weightedMatches
        : 0;
    const headshotRate =
      weightedMatches > 0
        ? ((Number(rankedStats?.avg_hs ?? 0) * Number(rankedStats?.matches ?? 0)) +
          (Number(wingmanStats?.avg_hs ?? 0) * Number(wingmanStats?.matches ?? 0))) /
          weightedMatches
        : 0;

    const hsSustain = await db.query(
      `SELECT COUNT(*)::int AS sustained
       FROM (
         SELECT metrics_json
         FROM player_match_metrics
         WHERE steam_id = $1
         ORDER BY created_at DESC
         LIMIT 10
       ) recent
       WHERE COALESCE((metrics_json->>'headshot_rate')::numeric, 0) > 65`,
      [input.steamId]
    );
    const sustainedHighHs = Number(hsSustain.rows[0]?.sustained ?? 0) >= 10;

    const mmrProgress = await db.query(
      `SELECT COALESCE(AVG(mmr_delta), 0)::float8 AS avg_gain
       FROM rank_history
       WHERE player_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [input.playerId]
    );
    const mmrGainPerMatch = Number(mmrProgress.rows[0]?.avg_gain ?? 0);

    const reportAgg = await db.query(
      `SELECT
         COUNT(*)::int AS reports_against,
         COALESCE(SUM(CASE WHEN cc.id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS accurate_reports
       FROM reports r
       LEFT JOIN confirmed_cases cc
         ON cc.match_id = r.match_id
        AND cc.player_id = r.reported_player_id
       JOIN players rp ON rp.id = r.reported_player_id
       WHERE rp.steam_id = $1`,
      [input.steamId]
    );
    const reportsAgainst = Number(reportAgg.rows[0]?.reports_against ?? 0);
    const accurateAgainst = Number(reportAgg.rows[0]?.accurate_reports ?? 0);
    const reportAccuracyAgainst = reportsAgainst > 0 ? accurateAgainst / reportsAgainst : 0;

    const idMatches = await db.query(
      `SELECT il.steam_id, p.permanent_ban, p.banned_until
       FROM identifier_links il
       LEFT JOIN players p ON p.steam_id = il.steam_id
       WHERE il.steam_id <> $1
         AND (
           ($2::text IS NOT NULL AND il.ip_hash = $2::text) OR
           ($3::text IS NOT NULL AND il.device_hash = $3::text)
         )`,
      [input.steamId, input.ipHash ?? null, input.deviceHash ?? null]
    );
    const matchedAccounts = Array.from(new Set(idMatches.rows.map((r) => String(r.steam_id))));
    const sharedIpWithAny = Boolean(input.ipHash && idMatches.rows.some((r) => r.steam_id && input.ipHash));
    const sharedDeviceWithAny = Boolean(input.deviceHash && idMatches.rows.some((r) => r.steam_id && input.deviceHash));
    const sharedWithBanned = idMatches.rows.some(
      (r) => Boolean(r.permanent_ban) || (r.banned_until && new Date(String(r.banned_until)).getTime() > Date.now())
    );

    const mmrValue = Number(p.mmr ?? 1000);
    const bucketMin =
      mmrValue < 900 ? 0 : mmrValue < 1100 ? 900 : mmrValue < 1300 ? 1100 : mmrValue < 1500 ? 1300 : mmrValue < 1700 ? 1500 : mmrValue < 1900 ? 1700 : 1900;
    const bucketMax =
      mmrValue < 900 ? 899 : mmrValue < 1100 ? 1099 : mmrValue < 1300 ? 1299 : mmrValue < 1500 ? 1499 : mmrValue < 1700 ? 1699 : mmrValue < 1900 ? 1899 : 10000;
    const cohort = await db.query(
      `SELECT
         COALESCE(AVG(COALESCE((pm.metrics_json->>'adr')::numeric, 0)), 80)::float8 AS adr_avg,
         COALESCE(AVG(COALESCE((pm.metrics_json->>'headshot_rate')::numeric, 0)), 45)::float8 AS hs_avg
       FROM player_match_metrics pm
       JOIN players p2 ON p2.steam_id = pm.steam_id
       JOIN matches m ON m.id = pm.match_id
       WHERE p2.mmr BETWEEN $1 AND $2
         AND m.mode IN ('ranked', 'wingman')`,
      [bucketMin, bucketMax]
    );
    const cohortAdr = Number(cohort.rows[0]?.adr_avg ?? 80);
    const cohortHs = Number(cohort.rows[0]?.hs_avg ?? 45);
    const cohortMmr = await db.query(
      `SELECT COALESCE(AVG(mmr_delta), 0)::float8 AS mmr_gain_avg
       FROM rank_history rh
       JOIN players p2 ON p2.id = rh.player_id
       WHERE p2.mmr BETWEEN $1 AND $2`,
      [bucketMin, bucketMax]
    );
    const cohortMmrGain = Number(cohortMmr.rows[0]?.mmr_gain_avg ?? 0);

    const weights = await getAdaptiveSmurfWeights();
    const smurf = computeSmurfScore(
      {
        steamAgeDays: security.steam_account_age !== null ? Number(security.steam_account_age) : null,
        csHours: security.cs_hours !== null ? Number(security.cs_hours) : null,
        vacBanCount: Number(security.vac_bans ?? 0),
        gameBanCount: 0,
        matchesPlayed,
        wins,
        kd,
        adr,
        headshotRate,
        mmrGainPerMatch,
        mmrGainDeltaVsBucket: mmrGainPerMatch - cohortMmrGain,
        adrDeltaVsBucket: adr - cohortAdr,
        hsDeltaVsBucket: headshotRate - cohortHs,
        highHsSustained: sustainedHighHs,
        sharedIpWithAny,
        sharedIpWithBanned: Boolean(input.ipHash && sharedWithBanned),
        sharedDeviceWithAny,
        sharedDeviceWithBanned: Boolean(input.deviceHash && sharedWithBanned),
        reportsAgainst,
        reportAccuracyAgainst
      },
      weights
    );

    const banEvasionScore = sharedWithBanned ? Math.min(100, smurf.smurf_score + 20) : Math.max(0, smurf.smurf_score - 10);
    const status = smurf.status;

    await db.query(
      `INSERT INTO player_risk_profile (steam_id, smurf_score, ban_evasion_score, reasons_json, status, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (steam_id)
       DO UPDATE SET smurf_score = EXCLUDED.smurf_score,
                     ban_evasion_score = EXCLUDED.ban_evasion_score,
                     reasons_json = EXCLUDED.reasons_json,
                     status = EXCLUDED.status,
                     updated_at = NOW()`,
      [input.steamId, smurf.smurf_score, banEvasionScore, JSON.stringify(smurf.reasons), status]
    );

    if (smurf.smurf_score >= 40) {
      const recent = await db.query(
        `SELECT id
         FROM risk_alerts
         WHERE steam_id = $1
           AND type = 'smurf'
           AND created_at > NOW() - INTERVAL '15 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.steamId]
      );
      if (!recent.rowCount) {
        const inserted = await db.query(
          `INSERT INTO risk_alerts (steam_id, type, score, reasons_json, matched_accounts, status, created_at, updated_at)
           VALUES ($1, 'smurf', $2, $3::jsonb, $4::jsonb, 'open', NOW(), NOW())
           RETURNING id`,
          [input.steamId, smurf.smurf_score, JSON.stringify(smurf.reasons), JSON.stringify(matchedAccounts)]
        );
        await redis.publish(
          "moderation-events",
          JSON.stringify({
            type: "smurf_alert",
            alert_id: inserted.rows[0].id,
            steam_id: input.steamId,
            score: smurf.smurf_score,
            reasons: smurf.reasons,
            matched_accounts: matchedAccounts
          })
        );
      }
    }

    return {
      smurf_score: smurf.smurf_score,
      ban_evasion_score: banEvasionScore,
      status,
      reasons: smurf.reasons,
      matched_accounts: matchedAccounts
    };
  }

  const highlightEventTypes = ["ace", "4k", "clutch_1v3", "noscope_kill"] as const;
  type HighlightEventType = (typeof highlightEventTypes)[number];

  function buildClipUrl(demoUrl: string | null, timestampSeconds: number, durationSeconds = 12): string | null {
    if (!demoUrl) return null;
    const hasQuery = demoUrl.includes("?");
    return `${demoUrl}${hasQuery ? "&" : "?"}t=${Math.max(0, timestampSeconds)}&dur=${Math.max(1, durationSeconds)}`;
  }

  function buildExportClipUrl(matchId: string, timestampSeconds: number): string | null {
    if (!demoClipBaseUrl) return null;
    const base = demoClipBaseUrl.endsWith("/") ? demoClipBaseUrl.slice(0, -1) : demoClipBaseUrl;
    return `${base}/${matchId}_${Math.max(0, Math.floor(timestampSeconds))}.mp4`;
  }

  async function storeHighlight(input: {
    match_id: string;
    player_id: string;
    event_type: HighlightEventType;
    round_number?: number | null;
    timestamp_seconds: number;
    metadata?: Record<string, unknown>;
  }) {
    const match = await db.query("SELECT id, demo_url FROM matches WHERE id = $1", [input.match_id]);
    if (!match.rowCount) {
      throw new Error("Match not found");
    }
    const demoUrl = match.rows[0].demo_url ? String(match.rows[0].demo_url) : null;
    const clipUrl = buildClipUrl(demoUrl, input.timestamp_seconds);
    const inserted = await db.query(
      `INSERT INTO match_highlights (match_id, player_id, event_type, round_number, timestamp_seconds, demo_url, clip_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        input.match_id,
        input.player_id,
        input.event_type,
        input.round_number ?? null,
        Math.max(0, Math.floor(input.timestamp_seconds)),
        demoUrl,
        clipUrl,
        JSON.stringify(input.metadata ?? {})
      ]
    );

    const player = await db.query("SELECT display_name FROM players WHERE id = $1", [input.player_id]);
    const highlight = inserted.rows[0];
    const playerName = String(player.rows[0]?.display_name ?? input.player_id);

    await redis.publish(
      "highlight-events",
      JSON.stringify({
        type: "highlight_moment",
        highlight_id: highlight.id,
        match_id: highlight.match_id,
        player_id: highlight.player_id,
        player_name: playerName,
        event_type: highlight.event_type,
        round_number: highlight.round_number,
        timestamp_seconds: highlight.timestamp_seconds,
        demo_url: highlight.demo_url,
        clip_url: highlight.clip_url
      })
    );

    if (["ace", "clutch_1v3", "noscope_kill"].includes(input.event_type)) {
      await db.query(
        `INSERT INTO evidence_clips (match_id, player_id, timestamp, clip_url, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [input.match_id, input.player_id, Math.max(0, Math.floor(input.timestamp_seconds)), clipUrl]
      );
    }

    return {
      ...highlight,
      player_name: playerName
    };
  }

  async function generateEvidenceClip(input: {
    match_id: string;
    timestamp: number;
    player_id?: string | null;
  }) {
    const match = await db.query("SELECT id, demo_url FROM matches WHERE id = $1", [input.match_id]);
    if (!match.rowCount) {
      throw new Error("Match not found");
    }
    const demoUrl = match.rows[0].demo_url ? String(match.rows[0].demo_url) : null;
    const timestamp = Math.max(0, Math.floor(input.timestamp));
    const clipUrl = buildExportClipUrl(input.match_id, timestamp) ?? buildClipUrl(demoUrl, timestamp, 15);

    const inserted = await db.query(
      `INSERT INTO evidence_clips (match_id, player_id, timestamp, clip_url, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [input.match_id, input.player_id ?? null, timestamp, clipUrl]
    );
    return inserted.rows[0];
  }

  function queueOrderKey(mode: QueueMode, pool: "normal" | "smurf" = "normal"): string {
    return pool === "smurf" ? `queue:${mode}:smurf:order` : `queue:${mode}:order`;
  }

  function queueEntriesKey(mode: QueueMode, pool: "normal" | "smurf" = "normal"): string {
    return pool === "smurf" ? `queue:${mode}:smurf:entries` : `queue:${mode}:entries`;
  }

  function rewardFromWins(wins: number): Array<{ code: string; type: string; reason: string }> {
    const rewards: Array<{ code: string; type: string; reason: string }> = [];
    if (wins >= 10) rewards.push({ code: "wins_10_basic", type: "basic_skins", reason: "10 wins milestone" });
    if (wins >= 25) rewards.push({ code: "wins_25_rare", type: "rare_skins", reason: "25 wins milestone" });
    if (wins >= 50) rewards.push({ code: "wins_50_knife", type: "knife_skins", reason: "50 wins milestone" });
    if (wins >= 100) rewards.push({ code: "wins_100_gloves", type: "gloves", reason: "100 wins milestone" });
    return rewards;
  }

  function rewardFromRank(rank: string): Array<{ code: string; type: string; reason: string }> {
    const rewards: Array<{ code: string; type: string; reason: string }> = [];
    if (["Gold Nova", "Master Guardian", "Distinguished Master Guardian", "Legendary Eagle", "Supreme", "Global Elite"].includes(rank)) {
      rewards.push({ code: "rank_gold_nova_rare", type: "rare_skins", reason: "Reached Gold Nova" });
    }
    if (["Master Guardian", "Distinguished Master Guardian", "Legendary Eagle", "Supreme", "Global Elite"].includes(rank)) {
      rewards.push({ code: "rank_master_guardian_knife", type: "knife_skins", reason: "Reached Master Guardian" });
    }
    if (["Supreme", "Global Elite"].includes(rank)) {
      rewards.push({ code: "rank_supreme_gloves", type: "gloves", reason: "Reached Supreme" });
    }
    if (rank === "Global Elite") {
      rewards.push({ code: "rank_global_elite_exclusive", type: "exclusive_skins", reason: "Reached Global Elite" });
    }
    return rewards;
  }

  async function ensureDefaultSkins(playerId: string): Promise<void> {
    await db.query(
      `INSERT INTO player_skins (player_id, weapon, skin_id, created_at, updated_at)
       SELECT $1, ws.weapon_name, ws.skin_id, NOW(), NOW()
       FROM weapon_skins ws
       WHERE ws.is_default = TRUE
       ON CONFLICT (player_id, weapon) DO NOTHING`,
      [playerId]
    );
  }

  async function skinExists(weapon: string, skinId: string): Promise<boolean> {
    const row = await db.query(
      `SELECT 1
       FROM weapon_skins
       WHERE weapon_name = $1 AND skin_id = $2
       LIMIT 1`,
      [weapon, skinId]
    );
    return row.rows.length > 0;
  }

  function rollRarity(
    weights: Array<{ rarity: "common" | "rare" | "epic" | "legendary" | "mythic"; chance: number }>
  ): "common" | "rare" | "epic" | "legendary" | "mythic" {
    const roll = Math.random() * 100;
    let cursor = 0;
    for (const band of weights) {
      cursor += band.chance;
      if (roll < cursor) {
        return band.rarity;
      }
    }
    return "common";
  }

  function rollFragBoxRarity(boxType: string): "common" | "rare" | "epic" | "legendary" | "mythic" {
    const normalized = boxType.toLowerCase();
    if (normalized === "creatorbox" || normalized === "elite_creatorbox" || normalized === "legendary_creatorbox") {
      return rollRarity(creatorBoxRarityWeights);
    }
    return rollRarity(fragBoxRarityWeights);
  }

  async function chooseFragBoxReward(
    rarity: "common" | "rare" | "epic" | "legendary" | "mythic",
    boxType: string
  ) {
    const sourceBoxType =
      boxType.toLowerCase() === "creatorbox" ||
      boxType.toLowerCase() === "elite_creatorbox" ||
      boxType.toLowerCase() === "legendary_creatorbox"
        ? "creatorbox"
        : "fragbox";
    const byRarity = await db.query(
      `SELECT reward_id, reward_type, skin_name, rarity, image_url
       FROM box_rewards
       WHERE rarity = $1
         AND source_box_type = $2`,
      [rarity, sourceBoxType]
    );
    const fallback = byRarity.rowCount
      ? byRarity.rows
      : (await db.query(
          `SELECT reward_id, reward_type, skin_name, rarity, image_url
           FROM box_rewards`
        )).rows;
    if (!fallback.length) {
      throw new Error("FragBox rewards not configured");
    }
    const idx = Math.floor(Math.random() * fallback.length);
    return fallback[idx];
  }

  function seasonLevelFromXp(xp: number): number {
    const level = Math.floor(Math.max(0, xp) / 500) + 1;
    return Math.min(50, Math.max(1, level));
  }

  function seasonXpMultiplierNow(): number {
    const now = new Date();
    const day = now.getUTCDay();
    if (day === 0 || day === 6) {
      return seasonWeekendXpBoostMultiplier;
    }
    return 1;
  }

  function nextSeasonName(previousName: string | null, previousCount: number): string {
    if (previousName) {
      const m = previousName.match(/Season\s+(\d+)/i);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return `Season ${n + 1}`;
      }
    }
    return `Season ${Math.max(1, previousCount + 1)}`;
  }

  async function recomputeSeasonLeaderboard(seasonId: string): Promise<void> {
    const rows = await db.query(
      `SELECT steam_id, mmr, wins, matches
       FROM season_progress
       WHERE season_id = $1
       ORDER BY mmr DESC, wins DESC, matches DESC, steam_id ASC`,
      [seasonId]
    );
    let rank = 1;
    for (const row of rows.rows) {
      await db.query(
        `INSERT INTO season_leaderboard (steam_id, season_id, rank, mmr, wins, matches, frozen, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())
         ON CONFLICT (season_id, steam_id)
         DO UPDATE SET rank = EXCLUDED.rank, mmr = EXCLUDED.mmr, wins = EXCLUDED.wins, matches = EXCLUDED.matches, updated_at = NOW()`,
        [String(row.steam_id), seasonId, rank, Number(row.mmr ?? 1000), Number(row.wins ?? 0), Number(row.matches ?? 0)]
      );
      rank += 1;
    }
  }

  async function grantSeasonReward(
    seasonId: string,
    playerId: string,
    steamId: string,
    rewardCode: string,
    source: "level" | "leaderboard" | "event" | "season_end",
    metadata: Record<string, unknown>
  ): Promise<void> {
    const inserted = await db.query(
      `INSERT INTO season_rewards (season_id, player_id, steam_id, reward_code, reward_type, source, metadata)
       VALUES ($1, $2, $3, $4, 'exclusive_skins', $5, $6::jsonb)
       ON CONFLICT (season_id, player_id, reward_code, source) DO NOTHING
       RETURNING id`,
      [seasonId, playerId, steamId, rewardCode, source, JSON.stringify(metadata)]
    );
    if (!inserted.rowCount) return;

    await db.query(
      `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
       VALUES ($1, $2, 'exclusive_skins', $3)
       ON CONFLICT (player_id, reward_code) DO NOTHING`,
      [playerId, rewardCode, `Season reward: ${rewardCode}`]
    );
  }

  async function grantSeasonLevelMilestones(
    seasonId: string,
    seasonName: string,
    playerId: string,
    steamId: string,
    oldLevel: number,
    newLevel: number
  ): Promise<void> {
    const milestones = [1, 5, 10, 15, 20, 30, 40, 50].filter((lvl) => lvl > oldLevel && lvl <= newLevel);
    const seasonSlug = seasonName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    for (const lvl of milestones) {
      if (lvl === 1) {
        await grantSeasonReward(
          seasonId,
          playerId,
          steamId,
          `${seasonSlug}_badge_lvl1`,
          "level",
          { level: lvl, reward: "profile_badge" }
        );
      } else if (lvl === 5) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'ak47', $2, NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId, `${seasonSlug}_weapon_lvl5`]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `${seasonSlug}_skin_lvl5`, "level", { level: lvl, reward: "weapon_skin" });
      } else if (lvl === 10) {
        await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'fragbox', NOW(), FALSE)", [steamId]);
        await grantSeasonReward(seasonId, playerId, steamId, `${seasonSlug}_fragbox_lvl10`, "level", { level: lvl, reward: "fragbox" });
      } else if (lvl === 15) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'm4a1-s', $2, NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId, `${seasonSlug}_epic_lvl15`]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `${seasonSlug}_epic_lvl15`, "level", { level: lvl, reward: "epic_skin" });
      } else if (lvl === 20) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'knife_karambit', $2, NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId, `${seasonSlug}_knife_lvl20`]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `${seasonSlug}_knife_lvl20`, "level", { level: lvl, reward: "knife_skin" });
      } else if (lvl === 30) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'gloves_sport', $2, NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId, `${seasonSlug}_gloves_lvl30`]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `${seasonSlug}_gloves_lvl30`, "level", { level: lvl, reward: "gloves" });
      } else if (lvl === 40) {
        await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'legendary_creatorbox', NOW(), FALSE)", [steamId]);
        await grantSeasonReward(seasonId, playerId, steamId, `${seasonSlug}_legendary_box_lvl40`, "level", { level: lvl, reward: "legendary_box" });
      } else if (lvl === 50) {
        await grantSeasonReward(
          seasonId,
          playerId,
          steamId,
          `${seasonSlug}_exclusive_lvl50`,
          "level",
          { level: lvl, reward: "exclusive_seasonal_item" }
        );
      }
    }
  }

  async function grantSeasonLeaderboardRewards(seasonId: string): Promise<Array<{ rank: number; steam_id: string }>> {
    const top = await db.query(
      `SELECT sl.rank, sl.steam_id, p.id AS player_id
       FROM season_leaderboard sl
       LEFT JOIN players p ON p.steam_id = sl.steam_id
       WHERE sl.season_id = $1
       ORDER BY sl.rank ASC
       LIMIT 100`,
      [seasonId]
    );
    for (const row of top.rows) {
      const rank = Number(row.rank ?? 9999);
      const playerId = row.player_id ? String(row.player_id) : null;
      const steamId = String(row.steam_id);
      if (!playerId) continue;
      if (rank <= 100) {
        await grantSeasonReward(seasonId, playerId, steamId, `season_top100_badge`, "leaderboard", { rank });
      }
      if (rank <= 50) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'awp', 'season_top50_epic', NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `season_top50_epic_skin`, "leaderboard", { rank });
      }
      if (rank <= 10) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'm4a4', 'season_top10_legendary', NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `season_top10_legendary_skin`, "leaderboard", { rank });
      }
      if (rank <= 3) {
        await db.query(
          `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
           VALUES ($1, 'knife_karambit', 'season_top3_exclusive_knife', NOW())
           ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
          [playerId]
        );
        await grantSeasonReward(seasonId, playerId, steamId, `season_top3_exclusive_knife`, "leaderboard", { rank });
      }
    }
    return top.rows.map((r) => ({ rank: Number(r.rank), steam_id: String(r.steam_id) }));
  }

  async function performSeasonSoftReset(): Promise<void> {
    const players = await db.query("SELECT id, mmr FROM players");
    for (const row of players.rows) {
      const current = Number(row.mmr ?? STARTING_MMR);
      const reset = Math.max(500, Math.round(current * 0.75));
      const rank = rankFromMmr(reset);
      await db.query(
        `UPDATE players
         SET mmr = $2, elo = $2, player_rank = $3
         WHERE id = $1`,
        [row.id, reset, rank]
      );
    }
  }

  async function performClanSeasonReset(): Promise<void> {
    await db.query(
      `INSERT INTO clan_ratings (clan_id, rating, wins, losses, matches_played, last_match)
       SELECT c.clan_id, $1, 0, 0, 0, NULL
       FROM clans c
       ON CONFLICT (clan_id)
       DO UPDATE SET
         rating = EXCLUDED.rating,
         wins = 0,
         losses = 0,
         matches_played = 0,
         last_match = NULL`,
      [clanRatingStart]
    );
  }

  async function ensureActiveSeason(): Promise<{ season_id: string; name: string; start_date: string; end_date: string; status: string }> {
    const lockKey = "season:rollover:lock";
    const lock = await redis.set(lockKey, "1", "EX", 15, "NX");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const active = await db.query(
        `SELECT season_id, name, start_date, end_date, status
         FROM seasons
         WHERE status = 'active'
         ORDER BY start_date DESC
         LIMIT 1`
      );
      if (active.rowCount) {
        const row = active.rows[0];
        const end = String(row.end_date);
        if (end >= today) {
          return {
            season_id: String(row.season_id),
            name: String(row.name),
            start_date: String(row.start_date),
            end_date: end,
            status: "active"
          };
        }

        await recomputeSeasonLeaderboard(String(row.season_id));
        await db.query(
          `UPDATE season_leaderboard
           SET frozen = TRUE, updated_at = NOW()
           WHERE season_id = $1`,
          [row.season_id]
        );
        const winners = await grantSeasonLeaderboardRewards(String(row.season_id));
        await recomputeClanLeaderboard(String(row.season_id));
        const clanWinners = await grantClanSeasonRewards(String(row.season_id));
        await db.query(
          `UPDATE seasons
           SET status = 'frozen', updated_at = NOW()
           WHERE season_id = $1`,
          [row.season_id]
        );
        await redis.publish(
          "season-events",
          JSON.stringify({
            type: "season_ended",
            season_id: row.season_id,
            season_name: row.name,
            top_players: winners.slice(0, 3),
            top_clans: clanWinners.slice(0, 3)
          })
        );
      }

      const countRows = await db.query("SELECT COUNT(*)::int AS count FROM seasons");
      const total = Number(countRows.rows[0]?.count ?? 0);
      const latest = await db.query(
        `SELECT season_id, name, start_date, end_date
         FROM seasons
         ORDER BY start_date DESC
         LIMIT 1`
      );
      const nextStartDate = today;
      const endDateObj = new Date(`${nextStartDate}T00:00:00.000Z`);
      endDateObj.setUTCDate(endDateObj.getUTCDate() + seasonDurationDays);
      const nextEndDate = endDateObj.toISOString().slice(0, 10);
      const name = nextSeasonName(latest.rowCount ? String(latest.rows[0].name) : null, total);

      await performSeasonSoftReset();
      await performClanSeasonReset();
      const inserted = await db.query(
        `INSERT INTO seasons (name, start_date, end_date, status, updated_at)
         VALUES ($1, $2::date, $3::date, 'active', NOW())
         RETURNING season_id, name, start_date, end_date, status`,
        [name, nextStartDate, nextEndDate]
      );
      await redis.publish(
        "season-events",
        JSON.stringify({
          type: "season_started",
          season_id: inserted.rows[0].season_id,
          season_name: inserted.rows[0].name,
          start_date: inserted.rows[0].start_date,
          end_date: inserted.rows[0].end_date
        })
      );
      return {
        season_id: String(inserted.rows[0].season_id),
        name: String(inserted.rows[0].name),
        start_date: String(inserted.rows[0].start_date),
        end_date: String(inserted.rows[0].end_date),
        status: String(inserted.rows[0].status)
      };
    } finally {
      if (lock === "OK") {
        await redis.del(lockKey);
      }
    }
  }

  async function applySeasonProgressForMatch(matchId: string, results: Array<{
    player_id: string;
    result: "win" | "loss";
    mvps: number;
  }>): Promise<void> {
    if (!results.length) return;
    const season = await ensureActiveSeason();
    const multiplier = seasonXpMultiplierNow();
    for (const entry of results) {
      const player = await db.query("SELECT id, steam_id, mmr FROM players WHERE id = $1", [entry.player_id]);
      if (!player.rowCount) continue;
      const playerId = String(player.rows[0].id);
      const steamId = String(player.rows[0].steam_id);
      const mmr = Number(player.rows[0].mmr ?? STARTING_MMR);
      const baseXp = entry.result === "win" ? 150 : 75;
      const bonusXp = Math.max(0, Number(entry.mvps ?? 0)) * 50;
      const gained = Math.round((baseXp + bonusXp) * multiplier);

      const current = await db.query(
        `SELECT season_xp, season_level, wins, matches
         FROM season_progress
         WHERE season_id = $1 AND player_id = $2`,
        [season.season_id, playerId]
      );
      const oldXp = Number(current.rows[0]?.season_xp ?? 0);
      const oldLevel = Number(current.rows[0]?.season_level ?? 1);
      const newXp = oldXp + gained;
      const newLevel = seasonLevelFromXp(newXp);
      const wins = Number(current.rows[0]?.wins ?? 0) + (entry.result === "win" ? 1 : 0);
      const matches = Number(current.rows[0]?.matches ?? 0) + 1;

      await db.query(
        `INSERT INTO season_progress (season_id, player_id, steam_id, season_xp, season_level, wins, matches, mmr, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (season_id, player_id)
         DO UPDATE SET
           season_xp = EXCLUDED.season_xp,
           season_level = EXCLUDED.season_level,
           wins = EXCLUDED.wins,
           matches = EXCLUDED.matches,
           mmr = EXCLUDED.mmr,
           updated_at = NOW()`,
        [season.season_id, playerId, steamId, newXp, newLevel, wins, matches, mmr]
      );

      await grantSeasonLevelMilestones(season.season_id, season.name, playerId, steamId, oldLevel, newLevel);
    }
    await recomputeSeasonLeaderboard(season.season_id);
  }

  async function grantBattlepassTrackReward(
    seasonId: string,
    steamId: string,
    track: "free" | "premium",
    level: number,
    rewardCode: string,
    applyReward: () => Promise<void>
  ): Promise<void> {
    const claim = await db.query(
      `INSERT INTO battlepass_reward_claims (steam_id, season_id, track, level, reward_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (steam_id, season_id, track, level, reward_code) DO NOTHING
       RETURNING id`,
      [steamId, seasonId, track, level, rewardCode]
    );
    if (!claim.rowCount) return;
    await applyReward();
  }

  async function applyBattlepassLevelRewards(
    seasonId: string,
    seasonName: string,
    playerId: string,
    steamId: string,
    oldLevel: number,
    newLevel: number,
    isPremium: boolean
  ): Promise<void> {
    const seasonSlug = seasonName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    for (let level = oldLevel + 1; level <= newLevel; level += 1) {
      if (level === 1) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_badge_lvl1`, async () => {
          await db.query(
            `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
             VALUES ($1, $2, 'basic_skins', 'Battlepass free level 1')
             ON CONFLICT (player_id, reward_code) DO NOTHING`,
            [playerId, `${seasonSlug}_bp_free_badge_lvl1`]
          );
        });
      }
      if (level === 5) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_skin_lvl5`, async () => {
          await db.query(
            `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
             VALUES ($1, 'famas', $2, NOW())
             ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
            [playerId, `${seasonSlug}_bp_basic_lvl5`]
          );
        });
      }
      if (level === 10) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_fragbox_lvl10`, async () => {
          await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'fragbox', NOW(), FALSE)", [steamId]);
        });
      }
      if (level === 15) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_badge_lvl15`, async () => {
          await db.query(
            `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
             VALUES ($1, $2, 'basic_skins', 'Battlepass free level 15')
             ON CONFLICT (player_id, reward_code) DO NOTHING`,
            [playerId, `${seasonSlug}_bp_free_badge_lvl15`]
          );
        });
      }
      if (level === 20) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_box_lvl20`, async () => {
          await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'fragbox', NOW(), FALSE)", [steamId]);
        });
      }
      if (level === 30) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_skin_lvl30`, async () => {
          await db.query(
            `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
             VALUES ($1, 'galil', $2, NOW())
             ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
            [playerId, `${seasonSlug}_bp_basic_lvl30`]
          );
        });
      }
      if (level === 40) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_fragbox_lvl40`, async () => {
          await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'fragbox', NOW(), FALSE)", [steamId]);
        });
      }
      if (level === 50) {
        await grantBattlepassTrackReward(seasonId, steamId, "free", level, `${seasonSlug}_bp_free_badge_lvl50`, async () => {
          await db.query(
            `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
             VALUES ($1, $2, 'exclusive_skins', 'Battlepass free level 50')
             ON CONFLICT (player_id, reward_code) DO NOTHING`,
            [playerId, `${seasonSlug}_bp_free_badge_lvl50`]
          );
        });
      }

      if (!isPremium) continue;

      if (level === 5) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_rare_lvl5`, async () => {
          await db.query(
            `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
             VALUES ($1, 'ak47', $2, NOW())
             ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
            [playerId, `${seasonSlug}_bp_rare_lvl5`]
          );
        });
      }
      if (level === 10) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_creatorbox_lvl10`, async () => {
          await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'creatorbox', NOW(), FALSE)", [steamId]);
        });
      }
      if (level === 15) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_rare_lvl15`, async () => {
          await db.query(
            `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
             VALUES ($1, 'm4a1-s', $2, NOW())
             ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
            [playerId, `${seasonSlug}_bp_rare_lvl15`]
          );
        });
      }
      if (level === 20) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_knife_lvl20`, async () => {
          await db.query(
            `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
             VALUES ($1, 'knife_karambit', $2, NOW())
             ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
            [playerId, `${seasonSlug}_bp_knife_lvl20`]
          );
        });
      }
      if (level === 30) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_gloves_lvl30`, async () => {
          await db.query(
            `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
             VALUES ($1, 'gloves_sport', $2, NOW())
             ON CONFLICT (player_id, weapon) DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
            [playerId, `${seasonSlug}_bp_gloves_lvl30`]
          );
        });
      }
      if (level === 40) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_legendary_box_lvl40`, async () => {
          await db.query("INSERT INTO player_boxes (steam_id, box_type, date_received, opened) VALUES ($1, 'legendary_creatorbox', NOW(), FALSE)", [steamId]);
        });
      }
      if (level === 50) {
        await grantBattlepassTrackReward(seasonId, steamId, "premium", level, `${seasonSlug}_bp_premium_exclusive_lvl50`, async () => {
          await db.query(
            `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
             VALUES ($1, $2, 'exclusive_skins', 'Battlepass premium level 50')
             ON CONFLICT (player_id, reward_code) DO NOTHING`,
            [playerId, `${seasonSlug}_bp_premium_exclusive_lvl50`]
          );
        });
      }
    }
  }

  async function applyBattlepassProgressForMatch(
    results: Array<{ player_id: string; result: "win" | "loss"; mvps: number }>
  ): Promise<void> {
    if (!results.length) return;
    const season = await ensureActiveSeason();
    const multiplier = seasonXpMultiplierNow();
    for (const entry of results) {
      const player = await db.query("SELECT id, steam_id FROM players WHERE id = $1", [entry.player_id]);
      if (!player.rowCount) continue;
      const playerId = String(player.rows[0].id);
      const steamId = String(player.rows[0].steam_id);
      const xpGain = Math.round(((entry.result === "win" ? 120 : 60) + Math.max(0, entry.mvps) * 40) * multiplier);

      const current = await db.query(
        `SELECT level, xp, is_premium
         FROM battlepass_progress
         WHERE steam_id = $1 AND season_id = $2`,
        [steamId, season.season_id]
      );
      const oldLevel = Number(current.rows[0]?.level ?? 1);
      const oldXp = Number(current.rows[0]?.xp ?? 0);
      const isPremium = Boolean(current.rows[0]?.is_premium ?? false);
      const newXp = oldXp + xpGain;
      const newLevel = Math.min(50, Math.max(1, Math.floor(newXp / 400) + 1));

      await db.query(
        `INSERT INTO battlepass_progress (steam_id, season_id, level, xp, is_premium, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (steam_id, season_id)
         DO UPDATE SET level = EXCLUDED.level, xp = EXCLUDED.xp, is_premium = battlepass_progress.is_premium, updated_at = NOW()`,
        [steamId, season.season_id, newLevel, newXp, isPremium]
      );

      await applyBattlepassLevelRewards(season.season_id, season.name, playerId, steamId, oldLevel, newLevel, isPremium);
    }
  }

  async function redeemBattlepassTokenForSeason(steamId: string): Promise<{
    redeemed: boolean;
    season: { season_id: string; name: string };
    reason?: string;
  }> {
    const season = await ensureActiveSeason();
    const token = await db.query(
      `SELECT id
       FROM battlepass_tokens
       WHERE steam_id = $1
         AND season_id = $2
         AND consumed = FALSE
       ORDER BY obtained_at ASC
       LIMIT 1`,
      [steamId, season.season_id]
    );
    if (!token.rowCount) {
      return { redeemed: false, season: { season_id: season.season_id, name: season.name }, reason: "No token found" };
    }

    const player = await db.query("SELECT id FROM players WHERE steam_id = $1 LIMIT 1", [steamId]);
    if (!player.rowCount) {
      return { redeemed: false, season: { season_id: season.season_id, name: season.name }, reason: "Player not found" };
    }
    const playerId = String(player.rows[0].id);

    const current = await db.query(
      `SELECT level, xp, is_premium
       FROM battlepass_progress
       WHERE steam_id = $1 AND season_id = $2`,
      [steamId, season.season_id]
    );
    const level = Number(current.rows[0]?.level ?? 1);
    const xp = Number(current.rows[0]?.xp ?? 0);
    const alreadyPremium = Boolean(current.rows[0]?.is_premium ?? false);
    if (alreadyPremium) {
      await db.query(
        `UPDATE battlepass_tokens
         SET consumed = TRUE, consumed_at = NOW()
         WHERE id = $1`,
        [token.rows[0].id]
      );
      await db.query(
        `DELETE FROM player_inventory
         WHERE steam_id = $1
           AND item_type = 'premium_battlepass_token'
           AND season_id = $2
         ORDER BY obtained_at ASC
         LIMIT 1`,
        [steamId, season.season_id]
      );
      return { redeemed: true, season: { season_id: season.season_id, name: season.name } };
    }

    await db.query(
      `INSERT INTO battlepass_progress (steam_id, season_id, level, xp, is_premium, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       ON CONFLICT (steam_id, season_id)
       DO UPDATE SET is_premium = TRUE, updated_at = NOW()`,
      [steamId, season.season_id, level, xp]
    );
    await db.query(
      `UPDATE battlepass_tokens
       SET consumed = TRUE, consumed_at = NOW()
       WHERE id = $1`,
      [token.rows[0].id]
    );
    await db.query(
      `DELETE FROM player_inventory
       WHERE steam_id = $1
         AND item_type = 'premium_battlepass_token'
         AND season_id = $2
       ORDER BY obtained_at ASC
       LIMIT 1`,
      [steamId, season.season_id]
    );

    await applyBattlepassLevelRewards(season.season_id, season.name, playerId, steamId, 0, level, true);

    return { redeemed: true, season: { season_id: season.season_id, name: season.name } };
  }
  async function assertModerator(request: any, reply: any): Promise<boolean> {
    if (!hasPrivilegedRole(String(request.user.role))) {
      await reply.code(403).send({ error: "Forbidden" });
      return false;
    }
    return true;
  }

  async function createBanLog(input: {
    targetPlayerId: string;
    reason: string;
    matchId?: string | null;
    caseId?: string | null;
    evidenceUrl?: string | null;
    demoTimestampSeconds?: number | null;
  }): Promise<void> {
    const target = await db.query("SELECT steam_id, display_name FROM players WHERE id = $1", [input.targetPlayerId]);
    if (!target.rowCount) return;
    const steamId = String(target.rows[0].steam_id);
    const playerName = String(target.rows[0].display_name ?? steamId);
    const link = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1", [steamId]);
    const discordId = link.rowCount ? String(link.rows[0].discord_id ?? "") : "";

    const inserted = await db.query(
      `INSERT INTO ban_logs (steam_id, discord_id, reason, evidence_url, match_id, case_id, demo_timestamp_seconds, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        steamId,
        discordId || null,
        input.reason,
        input.evidenceUrl ?? null,
        input.matchId ?? null,
        input.caseId ?? null,
        input.demoTimestampSeconds ?? null
      ]
    );

    await redis.publish(
      "overwatch-events",
      JSON.stringify({
        type: "ban_logged",
        ban: inserted.rows[0],
        player_name: playerName
      })
    );
  }

  async function createModerationLog(input: {
    action: string;
    playerId?: string | null;
    moderatorId?: string | null;
    reason?: string | null;
    matchId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      const inserted = await db.query(
        `INSERT INTO moderation_logs (action, player_id, moderator_id, reason, match_id, timestamp)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [input.action, input.playerId ?? null, input.moderatorId ?? null, input.reason ?? null, input.matchId ?? null]
      );
      const row = inserted.rows[0];
      const player =
        row.player_id
          ? await db.query("SELECT id, steam_id, display_name FROM players WHERE id = $1", [row.player_id])
          : { rowCount: 0, rows: [] as any[] };
      const moderator =
        row.moderator_id
          ? await db.query("SELECT id, steam_id, display_name FROM players WHERE id = $1", [row.moderator_id])
          : { rowCount: 0, rows: [] as any[] };
      const playerRow = player.rowCount ? player.rows[0] : null;
      const moderatorRow = moderator.rowCount ? moderator.rows[0] : null;
      await redis.publish(
        "moderation-events",
        JSON.stringify({
          type: "moderation_log",
          log_id: row.log_id,
          action: row.action,
          reason: row.reason,
          match_id: row.match_id,
          timestamp: row.timestamp,
          player_id: row.player_id,
          moderator_id: row.moderator_id,
          metadata: input.metadata ?? null,
          player: playerRow
            ? { id: playerRow.id, steam_id: playerRow.steam_id, display_name: playerRow.display_name }
            : null,
          moderator: moderatorRow
            ? { id: moderatorRow.id, steam_id: moderatorRow.steam_id, display_name: moderatorRow.display_name }
            : null
        })
      );
    } catch (error) {
      eventLogger.error("moderation_log_failed", {
        action: input.action,
        player_id: input.playerId ?? null,
        moderator_id: input.moderatorId ?? null,
        reason: input.reason ?? null,
        error: String((error as any)?.message ?? error)
      });
    }
  }

  async function applyPunishment(
    targetPlayerId: string,
    moderatorId: string,
    punishment: "timeout_24h" | "ban_7d" | "permanent_ban",
    context?: {
      reason?: string;
      matchId?: string | null;
      caseId?: string | null;
      evidenceUrl?: string | null;
      demoTimestampSeconds?: number | null;
    }
  ) {
    if (punishment === "timeout_24h") {
      await db.query(
        "UPDATE players SET banned_until = NOW() + INTERVAL '24 hours' WHERE id = $1",
        [targetPlayerId]
      );
      await db.query(
        `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
         VALUES ($1, $2, 'timeout', '24 hours by overwatch vote')`,
        [moderatorId, targetPlayerId]
      );
      await createModerationLog({
        action: "timeout",
        playerId: targetPlayerId,
        moderatorId,
        reason: context?.reason ?? "Overwatch timeout 24h",
        matchId: context?.matchId ?? null
      });
      return;
    }

    if (punishment === "ban_7d") {
      await db.query(
        "UPDATE players SET banned_until = NOW() + INTERVAL '7 days' WHERE id = $1",
        [targetPlayerId]
      );
      await db.query(
        `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
         VALUES ($1, $2, 'ban', '7 days by overwatch vote')`,
        [moderatorId, targetPlayerId]
      );
      await createBanLog({
        targetPlayerId,
        reason: context?.reason ?? "Cheating",
        matchId: context?.matchId ?? null,
        caseId: context?.caseId ?? null,
        evidenceUrl: context?.evidenceUrl ?? null,
        demoTimestampSeconds: context?.demoTimestampSeconds ?? null
      });
      await createModerationLog({
        action: "ban",
        playerId: targetPlayerId,
        moderatorId,
        reason: context?.reason ?? "Overwatch ban 7d",
        matchId: context?.matchId ?? null
      });
      return;
    }

    await db.query("UPDATE players SET permanent_ban = TRUE, banned_until = NULL WHERE id = $1", [targetPlayerId]);
    await db.query(
      `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
       VALUES ($1, $2, 'ban', 'Permanent by overwatch vote')`,
      [moderatorId, targetPlayerId]
    );
    await createBanLog({
      targetPlayerId,
      reason: context?.reason ?? "Cheating",
      matchId: context?.matchId ?? null,
      caseId: context?.caseId ?? null,
      evidenceUrl: context?.evidenceUrl ?? null,
      demoTimestampSeconds: context?.demoTimestampSeconds ?? null
    });
    await createModerationLog({
      action: "ban",
      playerId: targetPlayerId,
      moderatorId,
      reason: context?.reason ?? "Overwatch permanent ban",
      matchId: context?.matchId ?? null
    });
  }

  async function ensureConfirmedCheatingCase(caseId: string, moderatorId: string): Promise<void> {
    const caseRow = await db.query(
      "SELECT id, reported_player_id, match_id FROM overwatch_cases WHERE id = $1",
      [caseId]
    );
    if (!caseRow.rowCount) {
      throw new Error("Case not found");
    }
    await db.query(
      `INSERT INTO confirmed_cases (case_id, player_id, match_id, confirmation_type, confirmed_by)
       VALUES ($1, $2, $3, 'cheating_ban', $4)
       ON CONFLICT (case_id) DO NOTHING`,
      [caseId, caseRow.rows[0].reported_player_id, caseRow.rows[0].match_id, moderatorId]
    );
  }

  async function rewardReportersForCase(caseId: string, reputationPoints: number, bountyScore: number) {
    const caseRow = await db.query(
      `SELECT cc.case_id, cc.player_id, cc.match_id
       FROM confirmed_cases cc
       WHERE cc.case_id = $1 AND cc.confirmation_type = 'cheating_ban'`,
      [caseId]
    );
    if (!caseRow.rowCount) {
      throw new Error("Confirmed cheating case not found");
    }

    const reporters = await db.query(
      `SELECT DISTINCT reporter_id
       FROM reports
       WHERE match_id = $1 AND reported_player_id = $2`,
      [caseRow.rows[0].match_id, caseRow.rows[0].player_id]
    );

    let rewarded = 0;
    for (const reporter of reporters.rows) {
      const inserted = await db.query(
        `INSERT INTO bounty_rewards (case_id, reporter_id, reputation_points, bounty_score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (case_id, reporter_id) DO NOTHING
         RETURNING id`,
        [caseId, reporter.reporter_id, reputationPoints, bountyScore]
      );
      if (inserted.rowCount) {
        rewarded += 1;
        await db.query(
          `UPDATE players
           SET reputation_points = reputation_points + $2,
               bounty_score = bounty_score + $3
           WHERE id = $1`,
          [reporter.reporter_id, reputationPoints, bountyScore]
        );
      }
    }

    return rewarded;
  }

  async function createOverwatchCaseFromSuspicion(input: {
    player_id: string;
    match_id: string;
    suspicion_score: number;
    reasons: string[];
    metrics: Record<string, unknown>;
  }) {
    const existing = await db.query(
      "SELECT id FROM overwatch_cases WHERE reported_player_id = $1 AND match_id = $2 AND status = 'open' LIMIT 1",
      [input.player_id, input.match_id]
    );
    if (existing.rowCount) {
      return { caseCreated: false, caseId: existing.rows[0].id };
    }

    const match = await db.query("SELECT demo_url FROM matches WHERE id = $1", [input.match_id]);
    const systemReport = [
      {
        source: "anti_cheat",
        reason: "suspicious_stats",
        suspicion_score: input.suspicion_score,
        reasons: input.reasons,
        metrics: input.metrics,
        created_at: new Date().toISOString()
      }
    ];

    const created = await db.query(
      `INSERT INTO overwatch_cases (reported_player_id, match_id, reports, demo_url, status)
       VALUES ($1, $2, $3::jsonb, $4, 'open')
       RETURNING *`,
      [input.player_id, input.match_id, JSON.stringify(systemReport), match.rows[0]?.demo_url ?? null]
    );

    await redis.publish("overwatch-events", JSON.stringify({ type: "case_created", case: created.rows[0] }));
    return { caseCreated: true, caseId: created.rows[0].id, case: created.rows[0] };
  }

  async function getSystemModeratorId(): Promise<string> {
    const systemSteamId = process.env.ANTI_CHEAT_SYSTEM_STEAM_ID ?? "system_anti_cheat";
    const existing = await db.query("SELECT id FROM players WHERE steam_id = $1 LIMIT 1", [systemSteamId]);
    if (existing.rowCount) {
      return String(existing.rows[0].id);
    }

    const created = await db.query(
      `INSERT INTO players (steam_id, display_name, role)
       VALUES ($1, $2, 'admin')
       RETURNING id`,
      [systemSteamId, "AntiCheat System"]
    );
    return String(created.rows[0].id);
  }

  function prettyMapName(map: string): string {
    if (!map) return "Unknown";
    return map.replace(/^de_/, "").split("_").map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
  }

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false
  });
  await app.register(rateLimit, {
    max: Number(process.env.API_RATE_LIMIT_MAX ?? 150),
    timeWindow: process.env.API_RATE_LIMIT_WINDOW ?? "1 minute",
    allowList: ["127.0.0.1"],
    keyGenerator: (request) => {
      const steamId = String(request.headers["x-steam-id"] ?? "");
      const discordId = String(request.headers["x-discord-user-id"] ?? "");
      const userKey = steamId || discordId || "anon";
      return `${request.ip}:${userKey}`;
    }
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.length === 0) return cb(null, false);
      cb(null, corsOrigins.includes(origin));
    },
    credentials: false
  });
  await app.register(authPlugin);

  app.addHook("preHandler", async (request, reply) => {
    const routePath = request.routeOptions.url;
    if (!routePath) return;

    if (routePath.startsWith("/internal/")) {
      if (!isIpAllowed(request.ip, internalAllowedIps)) {
        metrics.blocked_requests += 1;
        await reply.code(403).send({ error: "Forbidden network" });
        return;
      }
      const ok = await verifyInternalRequest(request, reply, {
        token: internalApiToken,
        secret: internalWebhookSecret,
        redis,
        onFailure: async (reason) => {
          metrics.webhook_signature_failures += 1;
          eventLogger.error("webhook_signature_failure", { route: routePath, reason, ip: request.ip });
          const key = `security:webhook_failures:${new Date().toISOString().slice(0, 16)}`;
          const count = await redis.incr(key);
          await redis.expire(key, 120);
          if (count === webhookFailureSpikeThreshold) {
            await redis.publish(
              "security-events",
              JSON.stringify({
                type: "webhook_signature_failures_spike",
                route: routePath,
                count,
                threshold: webhookFailureSpikeThreshold
              })
            );
          }
        }
      });
      if (!ok) return;
    }

    const throttle = throttleConfig[routePath];
    if (!throttle) return;
    const id = `${request.ip}:${routePath}`;
    const now = Date.now();
    const current = requestThrottle.get(id);
    if (!current || current.resetAt <= now) {
      requestThrottle.set(id, { count: 1, resetAt: now + throttle.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > throttle.max) {
      metrics.rate_limit_hits += 1;
      metrics.blocked_requests += 1;
      eventLogger.info("request_blocked", { route: routePath, ip: request.ip, reason: "route_throttle" });
      await redis.publish(
        "security-events",
        JSON.stringify({
          type: "high_request_rate_blocked",
          route: routePath,
          ip: request.ip
        })
      );
      await reply.code(429).send({ error: "Too many requests" });
      return;
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = typeof (error as any).statusCode === "number" ? Number((error as any).statusCode) : 500;
    request.log.error({ err: error, route: request.routeOptions.url }, "request_failed");
    if (statusCode >= 500) {
      return reply.code(500).send({ error: "Internal server error" });
    }
    return reply.code(statusCode).send({ error: (error as any).message ?? "Request failed" });
  });

  app.get("/health", async () => ({ status: "ok", ok: true }));
  app.get("/internal/metrics", async () => ({
    ok: true,
    metrics,
    timestamp: new Date().toISOString()
  }));

  app.get("/internal/matchmaking/status", async () => {
    const enabled = await isMatchmakingEnabled();
    return { enabled };
  });

  app.post("/internal/matchmaking/set", async (request) => {
    const body = z.object({
      enabled: z.boolean(),
      reason: z.string().max(256).optional()
    }).parse(request.body ?? {});
    await redis.set(matchmakingFlagKey, body.enabled ? "1" : "0");
    eventLogger.info("matchmaking_toggled", {
      enabled: body.enabled,
      reason: body.reason ?? null
    });
    return { ok: true, enabled: body.enabled };
  });

  app.get("/auth/steam", async (_req, reply) => {
  const authUrl = await createSteamAuthUrl(steamReturnUrl);
  return reply.send({ url: authUrl });
  });

  app.post("/internal/verification/start", async (request, reply) => {
  const body = z
    .object({
      discord_id: z.string().min(3).max(64)
    })
    .parse(request.body ?? {});
  const token = crypto.randomBytes(24).toString("hex");
  await redis.set(`steam-link:token:${token}`, body.discord_id, "EX", steamLinkTokenTtlSeconds);
  const verifyUrl = new URL("/steam/verify", apiPublicBaseUrl);
  verifyUrl.searchParams.set("token", token);
  return {
    url: verifyUrl.toString(),
    verify_url: verifyUrl.toString(),
    expires_in_seconds: steamLinkTokenTtlSeconds
  };
  });

  app.post("/internal/steam-link/start", async (request, reply) => {
  const body = z
    .object({
      discord_id: z.string().min(3).max(64)
    })
    .parse(request.body ?? {});
  const token = crypto.randomBytes(24).toString("hex");
  await redis.set(`steam-link:token:${token}`, body.discord_id, "EX", steamLinkTokenTtlSeconds);
  const verifyUrl = new URL("/steam/verify", apiPublicBaseUrl);
  verifyUrl.searchParams.set("token", token);
  return reply.send({
    verify_url: verifyUrl.toString(),
    token_expires_in_seconds: steamLinkTokenTtlSeconds
  });
  });

  app.get("/steam/verify", async (request, reply) => {
  const query = z.object({ token: z.string().min(32).max(128) }).parse(request.query ?? {});
  const key = `steam-link:token:${query.token}`;
  const discordId = await redis.get(key);
  if (!discordId) {
    await createModerationLog({
      action: "steam_verification_failure",
      reason: "invalid_or_expired_verification_token"
    });
    return reply.code(400).type("text/plain").send("Verification link expired or invalid.");
  }
  const callback = new URL(steamReturnUrl);
  callback.searchParams.set("link_token", query.token);
  const url = await createSteamAuthUrl(callback.toString());
  return reply.redirect(url);
  });

  app.get("/internal/verification/status/:discordId", async (request) => {
  const params = z.object({ discordId: z.string().min(3).max(64) }).parse(request.params);
  const found = await db.query(
    `SELECT
       sl.discord_id,
       sl.steam_id,
       sl.linked_at AS verified_at,
       sl.steam_profile_url,
       sl.steam_account_age,
       sl.cs_hours,
       sl.vac_bans,
       u.username
     FROM steam_links sl
     LEFT JOIN users u ON u.discord_id = sl.discord_id
     WHERE sl.discord_id = $1`,
    [params.discordId]
  );
  if (!found.rowCount) {
    return { verified: false };
  }
  const username = found.rows[0].username ? String(found.rows[0].username) : null;
  const identity = found.rows[0].steam_id ? await getPlayerIdentityBySteamId(String(found.rows[0].steam_id)) : null;
  return {
    verified: true,
    discord_id: found.rows[0].discord_id,
    steam_id: found.rows[0].steam_id,
    username,
    username_required: !username,
    clan_tag: identity?.clan_tag ?? null,
    staff_tag: identity?.staff_tag ?? null,
    selected_tag_type: identity?.selected_tag_type ?? "none",
    available_tag_types: identity?.available_tag_types ?? ["none"],
    display_name: identity?.display_name ?? (username ?? null),
    verified_at: found.rows[0].verified_at,
    steam_profile_url: found.rows[0].steam_profile_url,
    steam_account_age: found.rows[0].steam_account_age,
    cs_hours: found.rows[0].cs_hours,
    vac_bans: found.rows[0].vac_bans
  };
  });

  app.post("/internal/player/username", async (request, reply) => {
  const body = z
    .object({
      username: z.string().min(3).max(32)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  let username: string;
  try {
    username = validateUsernameOrThrow(body.username);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }

  const existing = await db.query("SELECT username FROM users WHERE discord_id = $1", [verified.discordId]);
  if (existing.rowCount) {
    return reply.code(409).send({ error: "Username already set. Use username-change." });
  }
  const taken = await db.query("SELECT 1 FROM users WHERE lower(username) = lower($1) LIMIT 1", [username]);
  if (taken.rowCount) {
    return reply.code(409).send({ error: "Username is already taken." });
  }

  try {
    await db.query(
      `INSERT INTO users (discord_id, steam_id, username, selected_tag_type, created_at, username_changed_at)
       VALUES ($1, $2, $3, 'none', NOW(), NOW())`,
      [verified.discordId, verified.steamId, username]
    );
  } catch (error: any) {
    if (String(error?.code) === "23505") {
      return reply.code(409).send({ error: "Username is already taken." });
    }
    throw error;
  }

  await refreshPlayerDisplayName(verified.steamId);
  return { ok: true, steam_id: verified.steamId, username };
  });

  app.post("/internal/player/tag", async (request, reply) => {
  const body = z
    .object({
      selected_tag_type: z.enum(["dev", "admin", "mod", "clan", "none"])
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;
  const identity = await getPlayerIdentityBySteamId(verified.steamId);
  if (!identity) {
    return reply.code(404).send({ error: "Profile not found." });
  }
  if (!canUseTagType(identity.role, body.selected_tag_type, identity.clan_tag)) {
    return reply.code(403).send({ error: "Selected tag type is not allowed for your role/profile." });
  }
  await db.query("UPDATE users SET selected_tag_type = $1 WHERE steam_id = $2", [
    body.selected_tag_type,
    verified.steamId
  ]);
  await refreshPlayerDisplayName(verified.steamId);
  const updated = await getPlayerIdentityBySteamId(verified.steamId);
  return {
    ok: true,
    selected_tag_type: updated?.selected_tag_type ?? body.selected_tag_type,
    display_name: updated?.display_name ?? identity.display_name
  };
  });

  app.post("/internal/player/username/change", async (request, reply) => {
  const body = z
    .object({
      username: z.string().min(3).max(32)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  let username: string;
  try {
    username = validateUsernameOrThrow(body.username);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }

  const existing = await db.query(
    "SELECT username, username_changed_at FROM users WHERE discord_id = $1",
    [verified.discordId]
  );
  if (!existing.rowCount) {
    return reply.code(400).send({ error: "Username not set. Use username first." });
  }

  const currentUsername = String(existing.rows[0].username ?? "");
  if (currentUsername.toLowerCase() === username.toLowerCase()) {
    return reply.code(200).send({ ok: true, steam_id: verified.steamId, username: currentUsername });
  }
  const taken = await db.query(
    "SELECT 1 FROM users WHERE lower(username) = lower($1) AND discord_id <> $2 LIMIT 1",
    [username, verified.discordId]
  );
  if (taken.rowCount) {
    return reply.code(409).send({ error: "Username is already taken." });
  }

  const lastChangedAt = existing.rows[0].username_changed_at
    ? new Date(existing.rows[0].username_changed_at as string).getTime()
    : 0;
  if (lastChangedAt > 0) {
    const elapsedMs = Date.now() - lastChangedAt;
    const minIntervalMs = 30 * 24 * 60 * 60 * 1000;
    if (elapsedMs < minIntervalMs) {
      const retryAfterDays = Math.ceil((minIntervalMs - elapsedMs) / (24 * 60 * 60 * 1000));
      return reply.code(429).send({ error: "Username can only be changed once every 30 days.", retry_after_days: retryAfterDays });
    }
  }

  try {
    await db.query(
      `UPDATE users
       SET username = $1,
           username_changed_at = NOW()
       WHERE discord_id = $2`,
      [username, verified.discordId]
    );
  } catch (error: any) {
    if (String(error?.code) === "23505") {
      return reply.code(409).send({ error: "Username is already taken." });
    }
    throw error;
  }

  await refreshPlayerDisplayName(verified.steamId);
  return { ok: true, steam_id: verified.steamId, username };
  });

  app.get("/auth/steam/callback", async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  const returnTo = String(query["openid.return_to"] ?? "");
  const rpForVerify =
    returnTo && returnTo.startsWith(steamReturnUrl)
      ? buildRelyingParty(returnTo)
      : relyingParty;
  const result = await new Promise<{ authenticated: boolean; claimedIdentifier?: string }>((resolve, reject) => {
    rpForVerify.verifyAssertion(request.raw, (error: any, authResult: any) => {
      if (error || !authResult) {
        reject(error ?? new Error("Steam verification failed"));
        return;
      }
      resolve(authResult);
    });
  });

  if (!result.authenticated || !result.claimedIdentifier) {
    await createModerationLog({
      action: "steam_verification_failure",
      reason: "steam_openid_auth_failed"
    });
    return reply.code(401).send({ error: "Steam auth failed" });
  }

  const steamId = result.claimedIdentifier.split("/").at(-1);
  if (!steamId) {
    return reply.code(400).send({ error: "Invalid Steam ID" });
  }

  const existing = await db.query("SELECT * FROM players WHERE steam_id = $1", [steamId]);
  const player = existing.rowCount
    ? existing.rows[0]
    : (
        await db.query(
          "INSERT INTO players (steam_id, display_name) VALUES ($1, $2) RETURNING *",
          [steamId, `Steam-${steamId.slice(-6)}`]
        )
      ).rows[0];

  if (!existing.rowCount) {
    await db.query(
      `INSERT INTO rank_history (player_id, previous_rank, new_rank, mmr_delta)
       VALUES ($1, $2, $2, 0)`,
      [player.id, player.player_rank ?? rankFromMmr(STARTING_MMR)]
    );
    await db.query(
      `INSERT INTO player_stats (player_id, wins, losses, matches_played)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (player_id) DO NOTHING`,
      [player.id]
    );
  }

  let returnToUrl: URL | null = null;
  if (returnTo) {
    try {
      returnToUrl = new URL(returnTo);
    } catch {
      returnToUrl = null;
    }
  }
  const linkToken = String(query.link_token ?? returnToUrl?.searchParams.get("link_token") ?? "");
  let linkedDiscordId = "";
  if (linkToken) {
    linkedDiscordId = String((await redis.get(`steam-link:token:${linkToken}`)) ?? "");
  }
  const verificationState = readDiscordVerificationState(String(query.state ?? ""));
  if (!linkedDiscordId && verificationState) {
    linkedDiscordId = verificationState.discord_id;
  }

  if (linkedDiscordId) {
    await db.query("DELETE FROM verified_users WHERE steam_id = $1 AND discord_id <> $2", [
      steamId,
      linkedDiscordId
    ]);
    await db.query("DELETE FROM users WHERE steam_id = $1 AND discord_id <> $2", [
      steamId,
      linkedDiscordId
    ]);
    const rawIp = String(request.ip ?? "");
    const ipHash = hashIp(rawIp);
    const ipRangeHash = hashOptional(ipRangeBucket(rawIp));
    const profile = await fetchSteamProfileSecurity(steamId);
    const accountIsNew = typeof profile.steam_account_age === "number" && profile.steam_account_age < 30;
    const hasVacBans = Number(profile.vac_bans ?? 0) > 0;

    await db.query(
      `INSERT INTO verified_users (discord_id, steam_id, verified_at, ip_hash)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (discord_id)
       DO UPDATE SET steam_id = EXCLUDED.steam_id,
                     verified_at = EXCLUDED.verified_at,
                     ip_hash = EXCLUDED.ip_hash`,
      [linkedDiscordId, steamId, ipHash]
    );
    await db.query(
      `INSERT INTO steam_links (discord_id, steam_id, steam_profile_url, steam_account_age, cs_hours, vac_bans, linked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (discord_id)
       DO UPDATE SET steam_id = EXCLUDED.steam_id,
                     steam_profile_url = EXCLUDED.steam_profile_url,
                     steam_account_age = EXCLUDED.steam_account_age,
                     cs_hours = EXCLUDED.cs_hours,
                     vac_bans = EXCLUDED.vac_bans,
                     linked_at = NOW()`,
      [
        linkedDiscordId,
        steamId,
        profile.steam_profile_url,
        profile.steam_account_age,
        profile.cs_hours,
        profile.vac_bans
      ]
    );
    await db.query(
      `INSERT INTO player_identifiers (steam_id, discord_id, ip_hash, ip_range_hash, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (steam_id) DO UPDATE
       SET discord_id = EXCLUDED.discord_id,
           ip_hash = EXCLUDED.ip_hash,
           ip_range_hash = EXCLUDED.ip_range_hash,
           updated_at = NOW()`,
      [steamId, linkedDiscordId, ipHash, ipRangeHash]
    );
    await db.query("UPDATE users SET steam_id = $1 WHERE discord_id = $2", [steamId, linkedDiscordId]);
    if (linkToken) {
      await redis.del(`steam-link:token:${linkToken}`);
    }
    await redis.publish(
      "verification-events",
      JSON.stringify({
        type: "user_verified",
        discord_id: linkedDiscordId,
        steam_id: steamId,
        verified_at: new Date().toISOString(),
        steam_profile_url: profile.steam_profile_url,
        steam_account_age: profile.steam_account_age,
        cs_hours: profile.cs_hours,
        vac_bans: profile.vac_bans
      })
    );
    if (hasVacBans || accountIsNew) {
      await redis.publish(
        "overwatch-events",
        JSON.stringify({
          type: "steam_link_flagged",
          steam_id: steamId,
          discord_id: linkedDiscordId,
          reasons: [
            ...(hasVacBans ? [`vac_bans:${profile.vac_bans}`] : []),
            ...(accountIsNew ? ["new_steam_account"] : [])
          ],
          steam_account_age: profile.steam_account_age,
          cs_hours: profile.cs_hours,
          steam_profile_url: profile.steam_profile_url
        })
      );
      await createModerationLog({
        action: "steam_verification_failure",
        playerId: String(player.id),
        reason: [
          ...(hasVacBans ? [`vac_bans=${profile.vac_bans}`] : []),
          ...(accountIsNew ? ["steam_account_age_lt_30d"] : [])
        ].join("; ")
      });
    }

    const verificationSuccessRedirect = process.env.DISCORD_VERIFICATION_SUCCESS_URL;
    if (verificationSuccessRedirect) {
      return reply.redirect(verificationSuccessRedirect);
    }
    return reply.type("text/plain").send("Steam account linked successfully. You can return to Discord.");
  }

  const token = app.jwt.sign({ playerId: player.id, steamId: player.steam_id, role: player.role }, { expiresIn: "7d" });
  const callbackRedirect = process.env.AUTH_CALLBACK_REDIRECT_URL;
  if (callbackRedirect) {
    const safePath = normalizeSafeRelativePath("/auth/callback");
    const url = new URL(safePath, callbackRedirect);
    url.searchParams.set("token", token);
    return reply.redirect(url.toString());
  }

  return reply.send({
    token,
    player: {
      id: player.id,
      steam_id: player.steam_id,
      display_name: player.display_name,
      role: player.role
    }
  });
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (request) => {
  const result = await db.query(
    `SELECT id, steam_id, display_name, avatar_url, player_rank, report_score, reputation_points, bounty_score, role, created_at
     FROM players
     WHERE id = $1`,
    [request.user.playerId]
  );
  return result.rows[0] ?? null;
  });

  app.get("/players/:id", async (request) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const result = await db.query(
    `SELECT id, steam_id, display_name, avatar_url, player_rank, report_score, reputation_points, bounty_score, role, created_at
     FROM players
     WHERE id = $1`,
    [params.id]
  );
  return result.rows[0] ?? null;
  });

  app.get("/skins/catalog", async (request) => {
  const query = z
    .object({
      category: z.enum(skinCategories).optional(),
      weapon: z.string().min(2).max(64).optional()
    })
    .parse(request.query ?? {});

  const where: string[] = [];
  const params: string[] = [];
  if (query.category) {
    params.push(query.category);
    where.push(`category = $${params.length}`);
  }
  if (query.weapon) {
    params.push(query.weapon.toLowerCase());
    where.push(`weapon_name = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db.query(
    `SELECT weapon_name, category, skin_name, skin_id, rarity, image_url, is_default
     FROM weapon_skins
     ${whereSql}
     ORDER BY category, weapon_name, skin_name`,
    params
  );

  const grouped: Record<string, Array<{
    weapon_name: string;
    skins: Array<{ skin_name: string; skin_id: string; rarity: string; image_url: string | null; is_default: boolean }>;
  }>> = { primary: [], pistol: [], knife: [], gloves: [] };
  const byKey = new Map<string, { weapon_name: string; category: string; skins: any[] }>();
  for (const row of rows.rows) {
    const key = `${row.category}:${row.weapon_name}`;
    if (!byKey.has(key)) {
      byKey.set(key, { weapon_name: row.weapon_name, category: row.category, skins: [] });
    }
    byKey.get(key)?.skins.push({
      skin_name: row.skin_name,
      skin_id: row.skin_id,
      rarity: row.rarity,
      image_url: row.image_url ?? null,
      is_default: Boolean(row.is_default)
    });
  }
  for (const item of byKey.values()) {
    grouped[item.category].push({ weapon_name: item.weapon_name, skins: item.skins });
  }
  return {
    categories: grouped
  };
  });

  app.get("/player/skins/:steamid", async (request) => {
  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const player = await db.query("SELECT id, steam_id FROM players WHERE steam_id = $1", [params.steamid]);
  if (!player.rowCount) {
    return { steam_id: params.steamid, skins: [] };
  }

  await ensureDefaultSkins(String(player.rows[0].id));

  const skins = await db.query(
    `SELECT ps.weapon, ps.skin_id, ws.skin_name, ws.rarity, ws.image_url
     FROM player_skins ps
     LEFT JOIN weapon_skins ws ON ws.weapon_name = ps.weapon AND ws.skin_id = ps.skin_id
     WHERE ps.player_id = $1
     ORDER BY ps.weapon`,
    [player.rows[0].id]
  );

  return {
    steam_id: params.steamid,
    skins: skins.rows
  };
  });

  app.post("/player/skins", async (request, reply) => {
  const body = z
    .object({
      steam_id: z.string().min(3).max(64),
      weapon: z.string().min(2).max(64).transform((w: string) => w.toLowerCase()),
      skin_id: z.string().min(2).max(64)
    })
    .parse(request.body);

  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  const verified = await assertVerifiedDiscordSteam(request, reply, body.steam_id);
  if (!verified) return;
  if (!(await skinExists(body.weapon, body.skin_id))) {
    return reply.code(400).send({ error: "Unknown weapon/skin selection" });
  }

  let player = await db.query("SELECT id FROM players WHERE steam_id = $1", [body.steam_id]);
  if (!player.rowCount) {
    player = await db.query(
      "INSERT INTO players (steam_id, display_name) VALUES ($1, $2) RETURNING id",
      [body.steam_id, `Steam-${body.steam_id.slice(-6)}`]
    );
    await db.query(
      `INSERT INTO player_stats (player_id, wins, losses, matches_played)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (player_id) DO NOTHING`,
      [player.rows[0].id]
    );
    await ensureDefaultSkins(String(player.rows[0].id));
  }
  await ensureDefaultSkins(String(player.rows[0].id));

  const upsert = await db.query(
    `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (player_id, weapon)
     DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()
     RETURNING player_id, weapon, skin_id`,
    [player.rows[0].id, body.weapon, body.skin_id]
  );

  return { ok: true, selection: upsert.rows[0] };
  });

  app.get("/player/boxes/:steamid", async (request) => {
  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const summary = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE opened = FALSE) AS unopened,
       COUNT(*) FILTER (WHERE opened = TRUE) AS opened
     FROM player_boxes
     WHERE steam_id = $1`,
    [params.steamid]
  );
  const recent = await db.query(
    `SELECT id, box_type, date_received, opened, opened_at, reward_id
     FROM player_boxes
     WHERE steam_id = $1
     ORDER BY date_received DESC
     LIMIT 25`,
    [params.steamid]
  );
  return {
    steam_id: params.steamid,
    unopened: Number(summary.rows[0]?.unopened ?? 0),
    opened: Number(summary.rows[0]?.opened ?? 0),
    boxes: recent.rows
  };
  });

  app.post("/player/boxes/open", async (request, reply) => {
  const body = z
    .object({
      steam_id: z.string().min(3).max(64)
    })
    .parse(request.body ?? {});

  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  const verified = await assertVerifiedDiscordSteam(request, reply, body.steam_id);
  if (!verified) return;
  if (
    !(await enforceAccountRateLimit({
      route: "/openbox",
      request,
      reply,
      steamId: body.steam_id,
      discordId: verified.discordId,
      max: 2,
      windowSec: 10
    }))
  ) {
    return;
  }

  const nextBox = await db.query(
    `SELECT id, box_type, date_received
     FROM player_boxes
     WHERE steam_id = $1 AND opened = FALSE
     ORDER BY date_received ASC
     LIMIT 1`,
    [body.steam_id]
  );
  if (!nextBox.rowCount) {
    return reply.code(404).send({ error: "No unopened FragBox available" });
  }

  const boxType = String(nextBox.rows[0].box_type ?? "fragbox");
  const activeSeason = await ensureActiveSeason();
  const tokenEligible = boxType.toLowerCase() === "fragbox";
  const droppedPremiumToken = tokenEligible && Math.random() < premiumBattlepassTokenDropChance;
  const rarity = droppedPremiumToken ? "mythic" : rollFragBoxRarity(boxType);
  const reward = droppedPremiumToken
    ? {
        reward_id: null,
        reward_type: "premium_battlepass_token",
        skin_name: "Premium Battle Pass Token",
        rarity: "mythic",
        image_url: null
      }
    : await chooseFragBoxReward(rarity, boxType);
  await db.query(
    `UPDATE player_boxes
     SET opened = TRUE, opened_at = NOW(), reward_id = $2
     WHERE id = $1`,
    [nextBox.rows[0].id, reward.reward_id]
  );
  if (droppedPremiumToken) {
    await db.query(
      `INSERT INTO battlepass_tokens (steam_id, season_id, consumed, obtained_at)
       VALUES ($1, $2, FALSE, NOW())
       ON CONFLICT (steam_id, season_id, consumed) DO NOTHING`,
      [body.steam_id, activeSeason.season_id]
    );
    await db.query(
      `INSERT INTO player_inventory (steam_id, item_id, rarity, item_type, season_id, obtained_at)
       VALUES ($1, NULL, 'mythic', 'premium_battlepass_token', $2, NOW())`,
      [body.steam_id, activeSeason.season_id]
    );
  } else {
    await db.query(
      `INSERT INTO player_inventory (steam_id, item_id, rarity, item_type, season_id, obtained_at)
       VALUES ($1, $2, $3, 'box_reward', $4, NOW())`,
      [body.steam_id, reward.reward_id, reward.rarity, activeSeason.season_id]
    );
  }
  const remaining = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM player_boxes
     WHERE steam_id = $1 AND opened = FALSE`,
    [body.steam_id]
  );

  return {
    ok: true,
    box_id: nextBox.rows[0].id,
    reward: {
      reward_id: reward.reward_id,
      reward_type: reward.reward_type,
      skin_name: reward.skin_name,
      rarity: reward.rarity,
      image_url: reward.image_url ?? null,
      box_type: boxType,
      season_id: activeSeason.season_id
    },
    premium_battlepass_token: droppedPremiumToken,
    unopened_boxes: Number(remaining.rows[0]?.count ?? 0)
  };
  });

  app.post("/openbox", async (request, reply) => {
    const body = z
      .object({
        steam_id: z.string().min(3).max(64)
      })
      .parse(request.body ?? {});
    const headers: Record<string, string> = {};
    for (const key of ["x-bot-token", "x-discord-user-id", "x-steam-id", "x-forwarded-for"]) {
      const value = request.headers[key];
      if (typeof value === "string" && value.length > 0) headers[key] = value;
    }
    const res = await app.inject({
      method: "POST",
      url: "/player/boxes/open",
      headers,
      payload: body
    });
    const payload = res.body ? JSON.parse(res.body) : {};
    return reply.code(res.statusCode).send(payload);
  });

  app.get("/player/inventory/:steamid", async (request) => {
  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const rows = await db.query(
    `SELECT pi.id, pi.item_id, pi.item_type, pi.season_id, pi.rarity, pi.obtained_at, pi.created_at, br.reward_type, br.skin_name, br.image_url
     FROM player_inventory pi
     LEFT JOIN box_rewards br ON br.reward_id = pi.item_id
     WHERE pi.steam_id = $1
     ORDER BY pi.obtained_at DESC, pi.created_at DESC
     LIMIT 100`,
    [params.steamid]
  );
  return {
    steam_id: params.steamid,
    items: rows.rows
  };
  });

  app.get("/season/current", async () => {
  const season = await ensureActiveSeason();
  return season;
  });

  app.get("/season/leaderboard", async (request) => {
  const season = await ensureActiveSeason();
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query ?? {});
  const rows = await db.query(
    `SELECT sl.rank, sl.steam_id, sl.mmr, sl.wins, sl.matches, p.display_name
     FROM season_leaderboard sl
     LEFT JOIN players p ON p.steam_id = sl.steam_id
     WHERE sl.season_id = $1
     ORDER BY sl.rank ASC
     LIMIT $2`,
    [season.season_id, query.limit]
  );
  return {
    season,
    leaderboard: rows.rows
  };
  });

  app.get("/internal/season/status/:steamid", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const season = await ensureActiveSeason();
  const player = await db.query("SELECT id, steam_id, display_name FROM players WHERE steam_id = $1", [params.steamid]);
  if (!player.rowCount) {
    return {
      season,
      player: null,
      progress: null,
      leaderboard_rank: null
    };
  }
  const progress = await db.query(
    `SELECT season_xp, season_level, wins, matches, mmr, updated_at
     FROM season_progress
     WHERE season_id = $1 AND player_id = $2`,
    [season.season_id, player.rows[0].id]
  );
  const lb = await db.query(
    `SELECT rank
     FROM season_leaderboard
     WHERE season_id = $1 AND steam_id = $2`,
    [season.season_id, params.steamid]
  );
  const currentXp = Number(progress.rows[0]?.season_xp ?? 0);
  const currentLevel = Number(progress.rows[0]?.season_level ?? 1);
  const nextLevelXp = Math.min(50, currentLevel + 1) * 500;
  return {
    season,
    player: player.rows[0],
    progress: {
      season_xp: currentXp,
      season_level: currentLevel,
      wins: Number(progress.rows[0]?.wins ?? 0),
      matches: Number(progress.rows[0]?.matches ?? 0),
      mmr: Number(progress.rows[0]?.mmr ?? STARTING_MMR),
      xp_to_next_level: Math.max(0, nextLevelXp - currentXp)
    },
    leaderboard_rank: lb.rowCount ? Number(lb.rows[0].rank) : null
  };
  });

  app.get("/internal/season/leaderboard", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) }).parse(request.query ?? {});
  const season = await ensureActiveSeason();
  const rows = await db.query(
    `SELECT sl.rank, sl.steam_id, sl.mmr, sl.wins, sl.matches, p.display_name
     FROM season_leaderboard sl
     LEFT JOIN players p ON p.steam_id = sl.steam_id
     WHERE sl.season_id = $1
     ORDER BY sl.rank ASC
     LIMIT $2`,
    [season.season_id, query.limit]
  );
  return { season, leaderboard: rows.rows };
  });

  app.post("/internal/season/rollover", async (request, reply) => {
  if (internalApiToken) {
    const token = String(request.headers["x-internal-token"] ?? "");
    if (token !== internalApiToken) {
      return reply.code(401).send({ error: "Unauthorized internal token" });
    }
  }
  const season = await ensureActiveSeason();
  return { ok: true, season };
  });

  app.get("/battlepass/current/:steamid", async (request) => {
  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const season = await ensureActiveSeason();
  const progress = await db.query(
    `SELECT level, xp, is_premium, updated_at
     FROM battlepass_progress
     WHERE steam_id = $1 AND season_id = $2`,
    [params.steamid, season.season_id]
  );
  const level = Number(progress.rows[0]?.level ?? 1);
  const xp = Number(progress.rows[0]?.xp ?? 0);
  const nextLevelXp = Math.min(50, level + 1) * 400;
  return {
    season,
    steam_id: params.steamid,
    level,
    xp,
    is_premium: Boolean(progress.rows[0]?.is_premium ?? false),
    xp_to_next_level: Math.max(0, nextLevelXp - xp)
  };
  });

  app.get("/internal/battlepass/status/:steamid", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const season = await ensureActiveSeason();
  const progress = await db.query(
    `SELECT level, xp, is_premium, updated_at
     FROM battlepass_progress
     WHERE steam_id = $1 AND season_id = $2`,
    [params.steamid, season.season_id]
  );
  const level = Number(progress.rows[0]?.level ?? 1);
  const xp = Number(progress.rows[0]?.xp ?? 0);
  const nextLevelXp = Math.min(50, level + 1) * 400;
  return {
    season,
    steam_id: params.steamid,
    level,
    xp,
    is_premium: Boolean(progress.rows[0]?.is_premium ?? false),
    xp_to_next_level: Math.max(0, nextLevelXp - xp)
  };
  });

  app.post("/internal/battlepass/premium/activate", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  return reply.code(403).send({
    error: "Premium Battle Pass is token-only. Redeem a Premium Battle Pass Token instead."
  });
  });

  app.post("/player/battlepass/redeem", async (request, reply) => {
  const body = z.object({ steam_id: z.string().min(3).max(64) }).parse(request.body ?? {});
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }
  const verified = await assertVerifiedDiscordSteam(request, reply, body.steam_id);
  if (!verified) return;

  const redeemed = await redeemBattlepassTokenForSeason(body.steam_id);
  if (!redeemed.redeemed) {
    return reply.code(404).send({ error: redeemed.reason ?? "No token available" });
  }
  return {
    ok: true,
    steam_id: body.steam_id,
    season: redeemed.season,
    is_premium: true
  };
  });

  app.get("/player/rewards", { preHandler: [app.authenticate] }, async (request) => {
  const rewards = await db.query(
    `SELECT reward_code, reward_type, unlock_reason, created_at
     FROM player_rewards
     WHERE player_id = $1
     ORDER BY created_at DESC`,
    [request.user.playerId]
  );
  const stats = await db.query(
    `SELECT wins, losses, matches_played
     FROM player_stats
     WHERE player_id = $1`,
    [request.user.playerId]
  );
  const skins = await db.query(
    `SELECT weapon, skin_id, updated_at
     FROM player_skins
     WHERE player_id = $1
     ORDER BY weapon`,
    [request.user.playerId]
  );

  return {
    stats: stats.rows[0] ?? { wins: 0, losses: 0, matches_played: 0 },
    rewards: rewards.rows,
    skins: skins.rows
  };
  });

  app.post("/player/unlock", { preHandler: [app.authenticate] }, async (request) => {
  const player = await db.query(
    `SELECT id, player_rank
     FROM players
     WHERE id = $1`,
    [request.user.playerId]
  );
  if (!player.rowCount) {
    throw new Error("Player not found");
  }

  await db.query(
    `INSERT INTO player_stats (player_id, wins, losses, matches_played)
     VALUES ($1, 0, 0, 0)
     ON CONFLICT (player_id) DO NOTHING`,
    [request.user.playerId]
  );
  const stats = await db.query(
    `SELECT wins
     FROM player_stats
     WHERE player_id = $1`,
    [request.user.playerId]
  );

  const wins = Number(stats.rows[0]?.wins ?? 0);
  const rank = String(player.rows[0].player_rank ?? "Silver");
  const targets = [...rewardFromWins(wins), ...rewardFromRank(rank)];

  const unlockedRewards: Array<{ reward_code: string; reward_type: string }> = [];
  const unlockedSkins: Array<{ weapon: string; skin_id: string }> = [];

  for (const target of targets) {
    const inserted = await db.query(
      `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id, reward_code) DO NOTHING
       RETURNING reward_code, reward_type`,
      [request.user.playerId, target.code, target.type, target.reason]
    );

    if (!inserted.rowCount) continue;
    unlockedRewards.push(inserted.rows[0]);

    const pool = progressionSkinPools[target.type] ?? {};
    for (const weapon of Object.keys(pool)) {
      const firstSkin = pool[weapon]?.[0];
      if (!firstSkin) continue;

      const skinInserted = await db.query(
        `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (player_id, weapon)
         DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()
         RETURNING weapon, skin_id`,
        [request.user.playerId, weapon, firstSkin]
      );
      unlockedSkins.push(skinInserted.rows[0]);
    }
  }

  return {
    ok: true,
    wins,
    rank,
    unlocked_rewards: unlockedRewards,
    unlocked_skins: unlockedSkins
  };
  });

  app.get("/me/rank-history", { preHandler: [app.authenticate] }, async (request) => {
  const result = await db.query(
    `SELECT player_id, match_id, previous_rank, new_rank, mmr_delta, created_at
     FROM rank_history
     WHERE player_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [request.user.playerId]
  );
  return result.rows;
  });

  app.post("/queue/join", {
    preHandler: [app.authenticate],
    config: { rateLimit: RATE_LIMIT_POLICIES.queueJoin }
  }, async (request, reply) => {
  if (!(await isMatchmakingEnabled())) {
    return reply.code(503).send({ error: matchmakingDisabledMessage });
  }
  const playerId = request.user.playerId;
  const linkedSteam = await db.query("SELECT 1 FROM steam_links WHERE steam_id = $1 LIMIT 1", [request.user.steamId]);
  if (!linkedSteam.rowCount) {
    return reply.code(403).send({ error: "Steam account must be linked before joining queue" });
  }
  const username = await getUsernameBySteamId(request.user.steamId);
  if (!username) {
    return reply.code(403).send({ error: "Please choose a username before joining matchmaking." });
  }
  const body = z
    .object({
      region: z.string().min(2).max(16),
      mode: z.enum(queueModes).default("ranked")
    })
    .parse(request.body ?? {});
  if (body.mode === "clanwars" && !clanWarsEnabled) {
    return reply.code(503).send({ error: "Clan Wars is currently disabled." });
  }
  if (
    !(await enforceAccountRateLimit({
      route: "/queue/join",
      request,
      reply,
      steamId: request.user.steamId,
      discordId: String(request.headers["x-discord-user-id"] ?? ""),
      max: 4,
      windowSec: 10
    }))
  ) {
    return;
  }
  const player = await db.query(
    "SELECT id, mmr, wingman_mmr, creator_badge, permanent_ban, banned_until FROM players WHERE id = $1",
    [playerId]
  );
  if (!player.rowCount) {
    return reply.code(404).send({ error: "Player not found" });
  }
  if (Boolean(player.rows[0].permanent_ban)) {
    return reply.code(403).send({ error: "Account is permanently banned" });
  }
  if (player.rows[0].banned_until && new Date(player.rows[0].banned_until).getTime() > Date.now()) {
    return reply.code(403).send({ error: "Account is currently banned" });
  }

  const providedIpHash = normalizeProvidedHash(String(request.headers["x-ip-hash"] ?? "")) ?? hashIp(request.ip);
  const providedDeviceHash = normalizeProvidedHash(String(request.headers["x-device-fingerprint-hash"] ?? "")) ?? null;
  await db.query(
    `INSERT INTO identifier_links (steam_id, discord_id, ip_hash, device_hash, created_at)
     VALUES ($1, NULL, $2, $3, NOW())`,
    [request.user.steamId, providedIpHash, providedDeviceHash]
  );
  const smurfRisk = await resolveSmurfRiskForPlayer({
    playerId,
    steamId: request.user.steamId,
    ipHash: providedIpHash,
    deviceHash: providedDeviceHash
  });
  if (smurfRisk.status === "ban_evasion_likely") {
    return reply.code(403).send({ error: "Queue blocked due to ban-evasion likelihood", risk: smurfRisk });
  }
  if (smurfRisk.status === "high_suspicion" && (body.mode === "ranked" || body.mode === "wingman")) {
    return reply.code(403).send({ error: "Ranked queue restricted pending review", risk: smurfRisk });
  }
  const smurfPool = body.mode === "clanwars" ? false : smurfRisk.status === "suspected_smurf";
  let clanMeta: { clan_id: string; clan_tag: string } | null = null;
  if (body.mode === "clanwars") {
    const clanRow = await db.query(
      `SELECT c.clan_id, c.clan_tag
       FROM clan_members cm
       JOIN clans c ON c.clan_id = cm.clan_id
       WHERE cm.steam_id = $1
       LIMIT 1`,
      [request.user.steamId]
    );
    if (!clanRow.rowCount) {
      return reply.code(403).send({ error: "Clan Wars requires clan membership and a full 5-player clan team." });
    }
    clanMeta = {
      clan_id: String(clanRow.rows[0].clan_id),
      clan_tag: String(clanRow.rows[0].clan_tag)
    };
  }

  const entriesKey = queueEntriesKey(body.mode, smurfPool ? "smurf" : "normal");
  const orderKey = queueOrderKey(body.mode, smurfPool ? "smurf" : "normal");
  const cooldownKey = `queue:cooldown:${playerId}:${body.mode}`;
  const cooldownActive = await redis.ttl(cooldownKey);
  if (cooldownActive > 0) {
    metrics.queue_spam_blocks += 1;
    metrics.blocked_requests += 1;
    await redis.publish(
      "security-events",
      JSON.stringify({
        type: "queue_join_spam_detected",
        player_id: playerId,
        mode: body.mode,
        retry_after_seconds: cooldownActive
      })
    );
    return reply.code(429).send({ error: "Queue join cooldown active", retry_after_seconds: cooldownActive });
  }
  const alreadyQueued =
    (await redis.hexists(entriesKey, playerId)) === 1 ||
    (await redis.hexists(queueEntriesKey(body.mode, smurfPool ? "normal" : "smurf"), playerId)) === 1;
  if (alreadyQueued) {
    return reply.send({ queued: true, duplicate: true });
  }

  const burstKey = `throttle:queue_join:${playerId}:${body.mode}`;
  const burstCount = await redis.incr(burstKey);
  if (burstCount === 1) {
    await redis.expire(burstKey, 10);
  }
  if (burstCount > RATE_LIMIT_POLICIES.queueJoin.max) {
    metrics.queue_spam_blocks += 1;
    metrics.blocked_requests += 1;
    await redis.publish(
      "security-events",
      JSON.stringify({ type: "queue_join_spam_detected", player_id: playerId, mode: body.mode, burstCount })
    );
    return reply.code(429).send({ error: "Too many queue join attempts" });
  }

  const modeElo =
    body.mode === "wingman"
      ? Number(player.rows[0].wingman_mmr ?? 1000)
      : Number(player.rows[0].mmr ?? 1000);
  const queueEntry = {
    player_id: playerId,
    elo: modeElo,
    mode: body.mode,
    smurf_pool: smurfPool,
    clan_id: clanMeta?.clan_id ?? null,
    clan_tag: clanMeta?.clan_tag ?? null,
    priority: Boolean(player.rows[0].creator_badge),
    region: body.region,
    timestamp: new Date().toISOString()
  };
  if (body.mode === "clanwars" && clanMeta?.clan_id) {
    const queuedValues = await redis.hvals(entriesKey);
    const sameClanQueued = queuedValues
      .map((v) => {
        try {
          return JSON.parse(String(v)) as { clan_id?: string | null };
        } catch {
          return { clan_id: null };
        }
      })
      .filter((x) => String(x.clan_id ?? "") === clanMeta?.clan_id).length;
    if (sameClanQueued >= 5) {
      return reply.code(409).send({ error: "Your clan already has a full team queued for Clan Wars." });
    }
  }
  const score = Date.now() - (queueEntry.priority ? 300000 : 0);
  await redis
    .multi()
    .hset(entriesKey, playerId, JSON.stringify(queueEntry))
    .zadd(orderKey, score, playerId)
    .exec();

  const size = await redis.zcard(orderKey);
  await redis.publish(
    "queue-events",
    JSON.stringify({ type: "queue_join", playerId, mode: body.mode, size, entry: queueEntry, smurf_pool: smurfPool })
  );
  eventLogger.info("queue_join", {
    player_id: playerId,
    mode: body.mode,
    priority: queueEntry.priority,
    region: body.region,
    size,
    smurf_pool: smurfPool
  });

  return { queued: true, size, entry: queueEntry, risk: smurfRisk };
  });

  app.post("/internal/queue/join", async (request, reply) => {
  if (!(await isMatchmakingEnabled())) {
    return reply.code(503).send({ error: matchmakingDisabledMessage });
  }
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      steam_id: z.string().min(3).max(64),
      region: z.string().min(2).max(16).default("eu"),
      mode: z.enum(queueModes).default("ranked"),
      steam_account_age_days: z.number().min(0).max(10000).optional(),
      discord_account_created_at: z.string().datetime().optional(),
      discord_invite_source: z.string().min(1).max(128).optional()
    })
    .parse(request.body ?? {});
  if (body.mode === "clanwars" && !clanWarsEnabled) {
    return reply.code(503).send({ error: "Clan Wars is currently disabled." });
  }
  if (
    !(await enforceAccountRateLimit({
      route: "/internal/queue/join",
      request,
      reply,
      steamId: body.steam_id,
      discordId: String(request.headers["x-discord-user-id"] ?? ""),
      max: 4,
      windowSec: 10
    }))
  ) {
    return;
  }
  const verified = await assertVerifiedDiscordSteam(request, reply, body.steam_id);
  if (!verified) return;
  const username = await getUsernameBySteamId(body.steam_id);
  if (!username) {
    return reply.code(403).send({ error: "Please choose a username before joining matchmaking." });
  }

  let player = await db.query(
    "SELECT id, mmr, wingman_mmr, creator_badge, permanent_ban, banned_until, created_at FROM players WHERE steam_id = $1",
    [body.steam_id]
  );
  if (!player.rowCount) {
    const inserted = await db.query(
      "INSERT INTO players (steam_id, display_name) VALUES ($1, $2) RETURNING id, mmr, wingman_mmr, creator_badge, permanent_ban, banned_until, created_at",
      [body.steam_id, `Steam-${body.steam_id.slice(-6)}`]
    );
    player = inserted;
    await db.query(
      `INSERT INTO player_stats (player_id, wins, losses, matches_played)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (player_id) DO NOTHING`,
      [inserted.rows[0].id]
    );
  }

  const playerId = String(player.rows[0].id);
  if (Boolean(player.rows[0].permanent_ban)) {
    return reply.code(403).send({ error: "Account is permanently banned" });
  }
  if (player.rows[0].banned_until && new Date(player.rows[0].banned_until).getTime() > Date.now()) {
    return reply.code(403).send({ error: "Account is currently banned" });
  }

  const evasion = await detectBanEvasion({
    steamId: body.steam_id,
    discordId: verified.discordId,
    playerId,
    steamAccountAgeDays:
      typeof body.steam_account_age_days === "number"
        ? body.steam_account_age_days
        : Math.floor((Date.now() - new Date(player.rows[0].created_at).getTime()) / (24 * 60 * 60 * 1000)),
    discordAccountCreatedAt: body.discord_account_created_at ?? null,
    discordInviteSource: body.discord_invite_source ?? null,
    hardwareHash: String(request.headers["x-hardware-hash"] ?? "") || null,
    ipRangeHash: String(request.headers["x-ip-range-hash"] ?? "") || null
  });
  if (evasion.blocked) {
    return reply.code(403).send({
      error: "Queue access blocked due to possible ban evasion",
      suspicion_score: evasion.suspicion_score,
      matched_account: evasion.matched_account ?? null
    });
  }
  if (evasion.flagged) {
    eventLogger.info("ban_evasion_flagged", {
      steam_id: body.steam_id,
      discord_id: verified.discordId,
      suspicion_score: evasion.suspicion_score,
      matched_account: evasion.matched_account ?? null
    });
  }

  const providedIpHash = normalizeProvidedHash(String(request.headers["x-ip-hash"] ?? "")) ?? null;
  const providedDeviceHash = normalizeProvidedHash(String(request.headers["x-device-fingerprint-hash"] ?? "")) ?? null;
  await db.query(
    `INSERT INTO identifier_links (steam_id, discord_id, ip_hash, device_hash, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [body.steam_id, verified.discordId, providedIpHash, providedDeviceHash]
  );

  const smurfRisk = await resolveSmurfRiskForPlayer({
    playerId,
    steamId: body.steam_id,
    discordId: verified.discordId,
    ipHash: providedIpHash,
    deviceHash: providedDeviceHash
  });
  if (smurfRisk.status === "ban_evasion_likely") {
    return reply.code(403).send({
      error: "Queue access blocked due to ban-evasion likelihood",
      smurf_score: smurfRisk.smurf_score,
      reasons: smurfRisk.reasons
    });
  }
  if (smurfRisk.status === "high_suspicion" && (body.mode === "ranked" || body.mode === "wingman")) {
    return reply.code(403).send({
      error: "Ranked queue is restricted pending manual smurf review",
      smurf_score: smurfRisk.smurf_score,
      reasons: smurfRisk.reasons
    });
  }
  const smurfPool = body.mode === "clanwars" ? false : smurfRisk.status === "suspected_smurf";
  let clanMeta: { clan_id: string; clan_tag: string } | null = null;
  if (body.mode === "clanwars") {
    const clanRow = await db.query(
      `SELECT c.clan_id, c.clan_tag
       FROM clan_members cm
       JOIN clans c ON c.clan_id = cm.clan_id
       WHERE cm.steam_id = $1
       LIMIT 1`,
      [body.steam_id]
    );
    if (!clanRow.rowCount) {
      return reply.code(403).send({ error: "Clan Wars requires a full team from the same clan." });
    }
    clanMeta = {
      clan_id: String(clanRow.rows[0].clan_id),
      clan_tag: String(clanRow.rows[0].clan_tag)
    };
  }

  const entriesKey = queueEntriesKey(body.mode, smurfPool ? "smurf" : "normal");
  const orderKey = queueOrderKey(body.mode, smurfPool ? "smurf" : "normal");
  const cooldownKey = `queue:cooldown:${playerId}:${body.mode}`;
  const cooldownActive = await redis.ttl(cooldownKey);
  if (cooldownActive > 0) {
    metrics.queue_spam_blocks += 1;
    metrics.blocked_requests += 1;
    await redis.publish(
      "security-events",
      JSON.stringify({
        type: "queue_join_spam_detected",
        player_id: playerId,
        mode: body.mode,
        retry_after_seconds: cooldownActive
      })
    );
    return reply.code(429).send({ error: "Queue join cooldown active", retry_after_seconds: cooldownActive });
  }
  const alreadyQueued =
    (await redis.hexists(entriesKey, playerId)) === 1 ||
    (await redis.hexists(queueEntriesKey(body.mode, smurfPool ? "normal" : "smurf"), playerId)) === 1;
  if (alreadyQueued) {
    const size = await redis.zcard(orderKey);
    return { queued: true, duplicate: true, size, player_id: playerId };
  }

  const burstKey = `throttle:queue_join:${playerId}:${body.mode}`;
  const burstCount = await redis.incr(burstKey);
  if (burstCount === 1) {
    await redis.expire(burstKey, 10);
  }
  if (burstCount > RATE_LIMIT_POLICIES.queueJoin.max) {
    metrics.queue_spam_blocks += 1;
    metrics.blocked_requests += 1;
    await redis.publish(
      "security-events",
      JSON.stringify({ type: "queue_join_spam_detected", player_id: playerId, mode: body.mode, burstCount })
    );
    return reply.code(429).send({ error: "Too many queue join attempts" });
  }

  const modeElo =
    body.mode === "wingman"
      ? Number(player.rows[0].wingman_mmr ?? 1000)
      : Number(player.rows[0].mmr ?? 1000);
  const queueEntry = {
    player_id: playerId,
    elo: modeElo,
    mode: body.mode,
    smurf_pool: smurfPool,
    clan_id: clanMeta?.clan_id ?? null,
    clan_tag: clanMeta?.clan_tag ?? null,
    priority: Boolean(player.rows[0].creator_badge),
    region: body.region,
    timestamp: new Date().toISOString()
  };
  if (body.mode === "clanwars" && clanMeta?.clan_id) {
    const queuedValues = await redis.hvals(entriesKey);
    const sameClanQueued = queuedValues
      .map((v) => {
        try {
          return JSON.parse(String(v)) as { clan_id?: string | null };
        } catch {
          return { clan_id: null };
        }
      })
      .filter((x) => String(x.clan_id ?? "") === clanMeta?.clan_id).length;
    if (sameClanQueued >= 5) {
      return reply.code(409).send({ error: "Your clan already has a full team queued for Clan Wars." });
    }
  }
  const score = Date.now() - (queueEntry.priority ? 300000 : 0);
  await redis
    .multi()
    .hset(entriesKey, playerId, JSON.stringify(queueEntry))
    .zadd(orderKey, score, playerId)
    .exec();

  const size = await redis.zcard(orderKey);
  await redis.publish(
    "queue-events",
    JSON.stringify({ type: "queue_join", playerId, mode: body.mode, size, entry: queueEntry, smurf_pool: smurfPool })
  );
  eventLogger.info("queue_join", {
    player_id: playerId,
    mode: body.mode,
    priority: queueEntry.priority,
    region: body.region,
    size,
    source: "discord_bot",
    smurf_pool: smurfPool
  });
  return { queued: true, size, player_id: playerId, smurf_pool: smurfPool, risk: smurfRisk };
  });

  app.post("/internal/queue/leave", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      steam_id: z.string().min(3).max(64),
      mode: z.enum(queueModes).default("ranked")
    })
    .parse(request.body ?? {});
  if (
    !(await enforceAccountRateLimit({
      route: "/internal/queue/leave",
      request,
      reply,
      steamId: body.steam_id,
      discordId: String(request.headers["x-discord-user-id"] ?? ""),
      max: 4,
      windowSec: 10
    }))
  ) {
    return;
  }
  const verified = await assertVerifiedDiscordSteam(request, reply, body.steam_id);
  if (!verified) return;
  const player = await db.query("SELECT id FROM players WHERE steam_id = $1", [body.steam_id]);
  if (!player.rowCount) {
    const size = await redis.zcard(queueOrderKey(body.mode));
    return { queued: false, size };
  }

  const playerId = String(player.rows[0].id);
  const entriesKey = queueEntriesKey(body.mode);
  const orderKey = queueOrderKey(body.mode);
  const smurfEntriesKey = queueEntriesKey(body.mode, "smurf");
  const smurfOrderKey = queueOrderKey(body.mode, "smurf");
  await redis
    .multi()
    .hdel(entriesKey, playerId)
    .zrem(orderKey, playerId)
    .hdel(smurfEntriesKey, playerId)
    .zrem(smurfOrderKey, playerId)
    .set(`queue:cooldown:${playerId}:${body.mode}`, "1", "EX", queueJoinCooldownSeconds)
    .exec();
  const size = (await redis.zcard(orderKey)) + (await redis.zcard(smurfOrderKey));
  await redis.publish("queue-events", JSON.stringify({ type: "queue_leave", playerId, mode: body.mode, size }));
  return { queued: false, size };
  });

  app.get("/internal/player/stats/:steamid", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const player = await db.query(
    `SELECT id, steam_id, display_name, player_rank, report_score, reputation_points, bounty_score, creator_badge, creator_code
     FROM players
     WHERE steam_id = $1`,
    [params.steamid]
  );
  if (!player.rowCount) {
    return reply.code(404).send({ error: "Player not found" });
  }

  const playerId = player.rows[0].id;
  const stats = await db.query(
    `SELECT wins, losses, matches_played
     FROM player_stats
     WHERE player_id = $1`,
    [playerId]
  );
  const skins = await db.query(
    `SELECT weapon, skin_id
     FROM player_skins
     WHERE player_id = $1
     ORDER BY weapon`,
    [playerId]
  );

  return {
    player: player.rows[0],
    stats: stats.rows[0] ?? { wins: 0, losses: 0, matches_played: 0 },
    skins: skins.rows
  };
  });

  app.get("/internal/player/username", async (request, reply) => {
  const query = z
    .object({
      steam_id: z.string().min(3).max(64)
    })
    .parse(request.query ?? {});
  const identity = await getPlayerIdentityBySteamId(query.steam_id);
  if (!identity) {
    return reply.code(404).send({ error: "Username not set" });
  }
  return {
    username: identity.username,
    clan_tag: identity.clan_tag,
    staff_tag: identity.staff_tag,
    selected_tag_type: identity.selected_tag_type,
    available_tag_types: identity.available_tag_types,
    display_name: identity.display_name
  };
  });

  app.get("/internal/player/profile", async (request, reply) => {
  const query = z
    .object({
      steam_id: z.string().min(3).max(64)
    })
    .parse(request.query ?? {});
  const identity = await getPlayerIdentityBySteamId(query.steam_id);
  if (!identity) {
    return reply.code(404).send({ error: "Profile not found" });
  }
  return {
    steam_id: identity.steam_id,
    username: identity.username,
    clan_tag: identity.clan_tag,
    staff_tag: identity.staff_tag,
    selected_tag_type: identity.selected_tag_type,
    available_tag_types: identity.available_tag_types,
    display_name: identity.display_name
  };
  });

  app.post("/internal/clan/create-request", async (request, reply) => {
  const body = z
    .object({
      clan_name: z.string().min(3).max(64),
      clan_tag: z.string().min(3).max(12)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  const username = await getUsernameBySteamId(verified.steamId);
  if (!username) {
    return reply.code(403).send({ error: "Set username first using /username." });
  }

  let clanName: string;
  let clanTag: string;
  try {
    clanName = validateClanNameOrThrow(body.clan_name);
    clanTag = validateClanTagOrThrow(body.clan_tag);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }

  const currentClan = await db.query("SELECT clan_id FROM clan_members WHERE steam_id = $1 LIMIT 1", [verified.steamId]);
  if (currentClan.rowCount) {
    return reply.code(409).send({ error: "You are already in a clan." });
  }

  const taken = await db.query(
    "SELECT 1 FROM clans WHERE upper(clan_tag) = $1 OR lower(clan_name) = lower($2) LIMIT 1",
    [clanTag, clanName]
  );
  if (taken.rowCount) {
    return reply.code(409).send({ error: "Clan name or tag is already taken." });
  }

  const pending = await db.query(
    `SELECT request_id
     FROM clan_creation_requests
     WHERE applicant_steam_id = $1
       AND status = 'pending'
     LIMIT 1`,
    [verified.steamId]
  );
  if (pending.rowCount) {
    return reply.code(409).send({ error: "You already have a pending clan request." });
  }

  const inserted = await db.query(
    `INSERT INTO clan_creation_requests (applicant_steam_id, clan_name, clan_tag, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING request_id, clan_name, clan_tag, created_at`,
    [verified.steamId, clanName, clanTag]
  );
  const row = inserted.rows[0];
  await redis.publish(
    "moderation-events",
    JSON.stringify({
      type: "clan_request_created",
      request_id: row.request_id,
      applicant_steam_id: verified.steamId,
      applicant_discord_id: verified.discordId,
      applicant_username: username,
      clan_name: row.clan_name,
      clan_tag: row.clan_tag,
      created_at: row.created_at
    })
  );
  return {
    ok: true,
    request_id: row.request_id,
    clan_name: row.clan_name,
    clan_tag: row.clan_tag,
    status: "pending"
  };
  });

  app.post("/internal/clan/request/:requestId/approve", async (request, reply) => {
  const params = z.object({ requestId: z.string().uuid() }).parse(request.params);
  const actor = await assertVerifiedDiscordSteam(request, reply);
  if (!actor) return;
  const actorPlayer = await db.query("SELECT role FROM players WHERE steam_id = $1 LIMIT 1", [actor.steamId]);
  const actorRole = actorPlayer.rowCount ? String(actorPlayer.rows[0].role ?? "player") : "player";
  if (!hasPrivilegedRole(actorRole)) {
    return reply.code(403).send({ error: "Moderator/admin role required." });
  }

  const requestRow = await db.query(
    `SELECT request_id, applicant_steam_id, clan_name, clan_tag, status
     FROM clan_creation_requests
     WHERE request_id = $1
     LIMIT 1`,
    [params.requestId]
  );
  if (!requestRow.rowCount) {
    return reply.code(404).send({ error: "Clan request not found." });
  }
  const reqRow = requestRow.rows[0];
  if (String(reqRow.status) !== "pending") {
    return reply.code(409).send({ error: `Clan request already ${reqRow.status}.` });
  }

  const clanTag = String(reqRow.clan_tag);
  const clanName = String(reqRow.clan_name);
  const applicantSteamId = String(reqRow.applicant_steam_id);
  const taken = await db.query(
    "SELECT 1 FROM clans WHERE upper(clan_tag) = $1 OR lower(clan_name) = lower($2) LIMIT 1",
    [clanTag, clanName]
  );
  if (taken.rowCount) {
    return reply.code(409).send({ error: "Clan name or tag is already taken." });
  }

  const ownerAlreadyInClan = await db.query("SELECT 1 FROM clan_members WHERE steam_id = $1 LIMIT 1", [applicantSteamId]);
  if (ownerAlreadyInClan.rowCount) {
    return reply.code(409).send({ error: "Applicant is already in a clan." });
  }

  const createdClan = await db.query(
    `INSERT INTO clans (clan_name, clan_tag, owner_steam_id, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING clan_id, clan_name, clan_tag, owner_steam_id, created_at`,
    [clanName, clanTag, applicantSteamId]
  );
  const clan = createdClan.rows[0];
  await ensureClanRatingRow(String(clan.clan_id));
  await db.query(
    `INSERT INTO clan_members (clan_id, steam_id, role, created_at)
     VALUES ($1, $2, 'owner', NOW())`,
    [clan.clan_id, applicantSteamId]
  );
  await db.query(
    `UPDATE clan_creation_requests
     SET status = 'approved',
         reviewer_steam_id = $2,
         reviewed_at = NOW()
     WHERE request_id = $1`,
    [params.requestId, actor.steamId]
  );
  await refreshPlayerDisplayName(applicantSteamId);
  const ownerDiscord = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1 LIMIT 1", [applicantSteamId]);
  await redis.publish(
    "moderation-events",
    JSON.stringify({
      type: "clan_request_resolved",
      request_id: params.requestId,
      decision: "approved",
      reviewer_steam_id: actor.steamId,
      owner_steam_id: applicantSteamId,
      clan_id: clan.clan_id,
      clan_name: clan.clan_name,
      clan_tag: clan.clan_tag
    })
  );
  return {
    ok: true,
    decision: "approved",
    clan_id: clan.clan_id,
    clan_name: clan.clan_name,
    clan_tag: clan.clan_tag,
    owner_steam_id: clan.owner_steam_id,
    owner_discord_id: ownerDiscord.rowCount ? String(ownerDiscord.rows[0].discord_id) : null
  };
  });

  app.post("/internal/clan/request/:requestId/reject", async (request, reply) => {
  const params = z.object({ requestId: z.string().uuid() }).parse(request.params);
  const body = z.object({ reason: z.string().min(2).max(200).optional() }).parse(request.body ?? {});
  const actor = await assertVerifiedDiscordSteam(request, reply);
  if (!actor) return;
  const actorPlayer = await db.query("SELECT role FROM players WHERE steam_id = $1 LIMIT 1", [actor.steamId]);
  const actorRole = actorPlayer.rowCount ? String(actorPlayer.rows[0].role ?? "player") : "player";
  if (!hasPrivilegedRole(actorRole)) {
    return reply.code(403).send({ error: "Moderator/admin role required." });
  }

  const requestRow = await db.query(
    `UPDATE clan_creation_requests
     SET status = 'rejected',
         reviewer_steam_id = $2,
         rejection_reason = $3,
         reviewed_at = NOW()
     WHERE request_id = $1
       AND status = 'pending'
     RETURNING applicant_steam_id, clan_name, clan_tag`,
    [params.requestId, actor.steamId, body.reason ?? "Rejected by moderator"]
  );
  if (!requestRow.rowCount) {
    return reply.code(404).send({ error: "Pending clan request not found." });
  }
  const reqRow = requestRow.rows[0];
  await redis.publish(
    "moderation-events",
    JSON.stringify({
      type: "clan_request_resolved",
      request_id: params.requestId,
      decision: "rejected",
      reviewer_steam_id: actor.steamId,
      owner_steam_id: String(reqRow.applicant_steam_id),
      clan_name: String(reqRow.clan_name),
      clan_tag: String(reqRow.clan_tag),
      reason: body.reason ?? "Rejected by moderator"
    })
  );
  return { ok: true, decision: "rejected" };
  });

  app.post("/internal/clan/join-request", async (request, reply) => {
  const body = z
    .object({
      clan_tag: z.string().min(3).max(12)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  const clanTag = normalizeClanTag(body.clan_tag);
  const clan = await db.query(
    `SELECT clan_id, clan_name, clan_tag, owner_steam_id
     FROM clans
     WHERE upper(clan_tag) = $1
     LIMIT 1`,
    [clanTag]
  );
  if (!clan.rowCount) {
    return reply.code(404).send({ error: "Clan not found." });
  }
  const clanRow = clan.rows[0];
  const memberCount = await db.query("SELECT COUNT(*)::int AS cnt FROM clan_members WHERE clan_id = $1", [clanRow.clan_id]);
  if (Number(memberCount.rows[0]?.cnt ?? 0) >= clanMaxMembers) {
    return reply.code(409).send({ error: "Clan is at maximum capacity." });
  }

  const member = await db.query("SELECT 1 FROM clan_members WHERE steam_id = $1 LIMIT 1", [verified.steamId]);
  if (member.rowCount) {
    return reply.code(409).send({ error: "You are already in a clan." });
  }

  const pending = await db.query(
    `SELECT request_id
     FROM clan_join_requests
     WHERE clan_id = $1
       AND player_steam_id = $2
       AND status = 'pending'
     LIMIT 1`,
    [clanRow.clan_id, verified.steamId]
  );
  if (pending.rowCount) {
    return reply.code(409).send({ error: "Join request already pending." });
  }

  const inserted = await db.query(
    `INSERT INTO clan_join_requests (clan_id, player_steam_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING request_id, created_at`,
    [clanRow.clan_id, verified.steamId]
  );
  const ownerDiscord = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1 LIMIT 1", [
    String(clanRow.owner_steam_id)
  ]);
  return {
    ok: true,
    request_id: inserted.rows[0].request_id,
    clan_id: clanRow.clan_id,
    clan_name: clanRow.clan_name,
    clan_tag: clanRow.clan_tag,
    owner_steam_id: clanRow.owner_steam_id,
    owner_discord_id: ownerDiscord.rowCount ? String(ownerDiscord.rows[0].discord_id) : null
  };
  });

  app.post("/internal/clan/approve-member", async (request, reply) => {
  const body = z
    .object({
      player: z.string().min(3).max(64)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  const ownerClan = await db.query(
    `SELECT clan_id, clan_name, clan_tag
     FROM clans
     WHERE owner_steam_id = $1
     LIMIT 1`,
    [verified.steamId]
  );
  if (!ownerClan.rowCount) {
    return reply.code(403).send({ error: "Only clan owner can approve join requests." });
  }
  const clan = ownerClan.rows[0];
  const memberCount = await db.query("SELECT COUNT(*)::int AS cnt FROM clan_members WHERE clan_id = $1", [clan.clan_id]);
  if (Number(memberCount.rows[0]?.cnt ?? 0) >= clanMaxMembers) {
    return reply.code(409).send({ error: "Clan is at maximum capacity." });
  }

  const candidateRaw = body.player.trim();
  let targetSteamId = candidateRaw;
  if (!/^\d{10,20}$/.test(candidateRaw)) {
    const byUsername = await db.query(
      "SELECT steam_id FROM users WHERE lower(username) = lower($1) LIMIT 1",
      [candidateRaw]
    );
    if (!byUsername.rowCount) {
      return reply.code(404).send({ error: "Player not found by Steam ID or username." });
    }
    targetSteamId = String(byUsername.rows[0].steam_id);
  }

  const pending = await db.query(
    `SELECT request_id
     FROM clan_join_requests
     WHERE clan_id = $1
       AND player_steam_id = $2
       AND status = 'pending'
     LIMIT 1`,
    [clan.clan_id, targetSteamId]
  );
  if (!pending.rowCount) {
    return reply.code(404).send({ error: "No pending join request for that player." });
  }

  const inAnotherClan = await db.query("SELECT clan_id FROM clan_members WHERE steam_id = $1 LIMIT 1", [targetSteamId]);
  if (inAnotherClan.rowCount) {
    return reply.code(409).send({ error: "Player is already in a clan." });
  }

  await db.query(
    `INSERT INTO clan_members (clan_id, steam_id, role, created_at)
     VALUES ($1, $2, 'member', NOW())`,
    [clan.clan_id, targetSteamId]
  );
  await db.query(
    `UPDATE clan_join_requests
     SET status = 'approved',
         reviewer_steam_id = $2,
         reviewed_at = NOW()
     WHERE request_id = $1`,
    [pending.rows[0].request_id, verified.steamId]
  );
  await refreshPlayerDisplayName(targetSteamId);
  const targetDiscord = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1 LIMIT 1", [targetSteamId]);
  return {
    ok: true,
    clan_id: clan.clan_id,
    clan_name: clan.clan_name,
    clan_tag: clan.clan_tag,
    player_steam_id: targetSteamId,
    player_discord_id: targetDiscord.rowCount ? String(targetDiscord.rows[0].discord_id) : null
  };
  });

  app.post("/internal/clan/invite", async (request, reply) => {
  const body = z
    .object({
      player: z.string().min(3).max(64)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  const ownerClan = await db.query(
    `SELECT clan_id, clan_name, clan_tag
     FROM clans
     WHERE owner_steam_id = $1
     LIMIT 1`,
    [verified.steamId]
  );
  if (!ownerClan.rowCount) {
    return reply.code(403).send({ error: "Only clan owner can invite members." });
  }
  const clan = ownerClan.rows[0];

  const memberCount = await db.query("SELECT COUNT(*)::int AS cnt FROM clan_members WHERE clan_id = $1", [clan.clan_id]);
  if (Number(memberCount.rows[0]?.cnt ?? 0) >= clanMaxMembers) {
    return reply.code(409).send({ error: "Clan is at maximum capacity." });
  }

  const candidateRaw = body.player.trim();
  let targetSteamId = candidateRaw;
  if (!/^\d{10,20}$/.test(candidateRaw)) {
    const byUsername = await db.query(
      "SELECT steam_id FROM users WHERE lower(username) = lower($1) LIMIT 1",
      [candidateRaw]
    );
    if (!byUsername.rowCount) {
      return reply.code(404).send({ error: "Player not found by Steam ID or username." });
    }
    targetSteamId = String(byUsername.rows[0].steam_id);
  }
  if (targetSteamId === verified.steamId) {
    return reply.code(409).send({ error: "You are already in your own clan." });
  }

  const inAnotherClan = await db.query("SELECT clan_id FROM clan_members WHERE steam_id = $1 LIMIT 1", [targetSteamId]);
  if (inAnotherClan.rowCount) {
    return reply.code(409).send({ error: "Player is already in a clan." });
  }

  await db.query(
    `INSERT INTO clan_members (clan_id, steam_id, role, created_at)
     VALUES ($1, $2, 'member', NOW())`,
    [clan.clan_id, targetSteamId]
  );
  await db.query(
    `UPDATE clan_join_requests
     SET status = 'approved',
         reviewer_steam_id = $2,
         reviewed_at = NOW()
     WHERE clan_id = $1
       AND player_steam_id = $3
       AND status = 'pending'`,
    [clan.clan_id, verified.steamId, targetSteamId]
  );
  await refreshPlayerDisplayName(targetSteamId);
  const targetDiscord = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1 LIMIT 1", [targetSteamId]);
  return {
    ok: true,
    clan_id: clan.clan_id,
    clan_name: clan.clan_name,
    clan_tag: clan.clan_tag,
    player_steam_id: targetSteamId,
    player_discord_id: targetDiscord.rowCount ? String(targetDiscord.rows[0].discord_id) : null
  };
  });

  app.post("/internal/clan/kick", async (request, reply) => {
  const body = z
    .object({
      player: z.string().min(3).max(64)
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  const ownerClan = await db.query(
    `SELECT clan_id, clan_name, clan_tag
     FROM clans
     WHERE owner_steam_id = $1
     LIMIT 1`,
    [verified.steamId]
  );
  if (!ownerClan.rowCount) {
    return reply.code(403).send({ error: "Only clan owner can kick members." });
  }
  const clan = ownerClan.rows[0];

  const candidateRaw = body.player.trim();
  let targetSteamId = candidateRaw;
  if (!/^\d{10,20}$/.test(candidateRaw)) {
    const byUsername = await db.query(
      "SELECT steam_id FROM users WHERE lower(username) = lower($1) LIMIT 1",
      [candidateRaw]
    );
    if (!byUsername.rowCount) {
      return reply.code(404).send({ error: "Player not found by Steam ID or username." });
    }
    targetSteamId = String(byUsername.rows[0].steam_id);
  }
  if (targetSteamId === verified.steamId) {
    return reply.code(409).send({ error: "Owner cannot kick themselves. Use /clan leave after ownership transfer." });
  }

  const member = await db.query(
    `SELECT role
     FROM clan_members
     WHERE clan_id = $1
       AND steam_id = $2
     LIMIT 1`,
    [clan.clan_id, targetSteamId]
  );
  if (!member.rowCount) {
    return reply.code(404).send({ error: "Player is not a member of your clan." });
  }
  if (String(member.rows[0].role) === "owner") {
    return reply.code(409).send({ error: "Cannot kick clan owner." });
  }

  await db.query("DELETE FROM clan_members WHERE clan_id = $1 AND steam_id = $2", [clan.clan_id, targetSteamId]);
  await db.query(
    `UPDATE clan_join_requests
     SET status = 'rejected',
         reviewer_steam_id = $2,
         rejection_reason = 'Kicked by owner',
         reviewed_at = NOW()
     WHERE clan_id = $1
       AND player_steam_id = $3
       AND status = 'pending'`,
    [clan.clan_id, verified.steamId, targetSteamId]
  );
  await refreshPlayerDisplayName(targetSteamId);
  const targetDiscord = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1 LIMIT 1", [targetSteamId]);
  return {
    ok: true,
    clan_id: clan.clan_id,
    clan_name: clan.clan_name,
    clan_tag: clan.clan_tag,
    player_steam_id: targetSteamId,
    player_discord_id: targetDiscord.rowCount ? String(targetDiscord.rows[0].discord_id) : null
  };
  });

  app.post("/internal/clan/leave", async (request, reply) => {
  const verified = await assertVerifiedDiscordSteam(request, reply);
  if (!verified) return;

  const membership = await db.query(
    `SELECT cm.clan_id, cm.role, c.clan_name, c.clan_tag, c.owner_steam_id
     FROM clan_members cm
     JOIN clans c ON c.clan_id = cm.clan_id
     WHERE cm.steam_id = $1
     LIMIT 1`,
    [verified.steamId]
  );
  if (!membership.rowCount) {
    return reply.code(404).send({ error: "You are not in a clan." });
  }
  const row = membership.rows[0];
  if (String(row.role) === "owner") {
    const count = await db.query("SELECT COUNT(*)::int AS cnt FROM clan_members WHERE clan_id = $1", [row.clan_id]);
    const members = Number(count.rows[0]?.cnt ?? 0);
    if (members > 1) {
      return reply.code(409).send({ error: "Owner must transfer ownership before leaving." });
    }
    await db.query("DELETE FROM clans WHERE clan_id = $1", [row.clan_id]);
    await refreshPlayerDisplayName(verified.steamId);
    return { ok: true, left: true, disbanded: true, clan_tag: row.clan_tag, clan_name: row.clan_name };
  }

  await db.query("DELETE FROM clan_members WHERE clan_id = $1 AND steam_id = $2", [row.clan_id, verified.steamId]);
  await refreshPlayerDisplayName(verified.steamId);
  return { ok: true, left: true, disbanded: false, clan_tag: row.clan_tag, clan_name: row.clan_name };
  });

  app.get("/internal/clan/leaderboard", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(10)
    })
    .parse(request.query ?? {});
  const season = await ensureActiveSeason();
  await recomputeClanLeaderboard(season.season_id);
  const rows = await db.query(
    `SELECT cl.rank, c.clan_name, c.clan_tag, cl.rating, cl.wins, cl.losses, cl.matches_played
     FROM clan_leaderboard cl
     JOIN clans c ON c.clan_id = cl.clan_id
     WHERE cl.season_id = $1
     ORDER BY cl.rank ASC
     LIMIT $2`,
    [season.season_id, query.limit]
  );
  return {
    season,
    leaderboard: rows.rows
  };
  });

  app.get("/leaderboard/clans", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(10)
    })
    .parse(request.query ?? {});
  const season = await ensureActiveSeason();
  await recomputeClanLeaderboard(season.season_id);
  const rows = await db.query(
    `SELECT cl.rank, c.clan_name, c.clan_tag, cl.rating, cl.wins, cl.losses, cl.matches_played
     FROM clan_leaderboard cl
     JOIN clans c ON c.clan_id = cl.clan_id
     WHERE cl.season_id = $1
     ORDER BY cl.rank ASC
     LIMIT $2`,
    [season.season_id, query.limit]
  );
  return {
    season,
    leaderboard: rows.rows
  };
  });

  app.get("/internal/clan/info", async (request, reply) => {
  const query = z
    .object({
      steam_id: z.string().min(3).max(64).optional(),
      tag: z.string().min(3).max(12).optional()
    })
    .parse(request.query ?? {});
  let clanRow;
  if (query.tag) {
    clanRow = await db.query(
      `SELECT c.clan_id, c.clan_name, c.clan_tag, c.owner_steam_id
       FROM clans c
       WHERE UPPER(c.clan_tag) = $1
       LIMIT 1`,
      [String(query.tag).toUpperCase()]
    );
  } else if (query.steam_id) {
    clanRow = await db.query(
      `SELECT c.clan_id, c.clan_name, c.clan_tag, c.owner_steam_id
       FROM clan_members cm
       JOIN clans c ON c.clan_id = cm.clan_id
       WHERE cm.steam_id = $1
       LIMIT 1`,
      [query.steam_id]
    );
  } else {
    return reply.code(400).send({ error: "Provide steam_id or tag." });
  }
  if (!clanRow.rowCount) {
    return reply.code(404).send({ error: "Clan not found." });
  }
  const clan = clanRow.rows[0];
  await ensureClanRatingRow(String(clan.clan_id));
  const season = await ensureActiveSeason();
  await recomputeClanLeaderboard(season.season_id);
  const rating = await db.query(
    `SELECT rating, wins, losses, matches_played, last_match
     FROM clan_ratings
     WHERE clan_id = $1`,
    [clan.clan_id]
  );
  const rank = await db.query(
    `SELECT rank
     FROM clan_leaderboard
     WHERE season_id = $1 AND clan_id = $2`,
    [season.season_id, clan.clan_id]
  );
  const members = await db.query(
    `SELECT cm.steam_id, cm.role, u.username
     FROM clan_members cm
     LEFT JOIN users u ON u.steam_id = cm.steam_id
     WHERE cm.clan_id = $1
     ORDER BY cm.role DESC, u.username ASC NULLS LAST, cm.steam_id ASC`,
    [clan.clan_id]
  );
  return {
    clan: {
      clan_id: clan.clan_id,
      clan_name: clan.clan_name,
      clan_tag: clan.clan_tag,
      owner_steam_id: clan.owner_steam_id
    },
    rating: {
      rating: Number(rating.rows[0]?.rating ?? clanRatingStart),
      wins: Number(rating.rows[0]?.wins ?? 0),
      losses: Number(rating.rows[0]?.losses ?? 0),
      matches_played: Number(rating.rows[0]?.matches_played ?? 0),
      last_match: rating.rows[0]?.last_match ?? null,
      rank: rank.rowCount ? Number(rank.rows[0].rank) : null
    },
    members: members.rows
  };
  });

  app.get("/internal/clan/match/:id/result", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const row = await db.query(
    `SELECT
       cwm.match_id,
       cwm.clan_a_score,
       cwm.clan_b_score,
       cwm.winner_clan_id,
       ca.clan_tag AS clan_a_tag,
       cb.clan_tag AS clan_b_tag,
       wa.clan_tag AS winner_clan_tag
     FROM clan_war_matches cwm
     JOIN clans ca ON ca.clan_id = cwm.clan_a_id
     JOIN clans cb ON cb.clan_id = cwm.clan_b_id
     LEFT JOIN clans wa ON wa.clan_id = cwm.winner_clan_id
     WHERE cwm.match_id = $1
     LIMIT 1`,
    [params.id]
  );
  if (!row.rowCount) {
    return reply.code(404).send({ error: "Clan war result not found." });
  }
  const res = row.rows[0];
  return {
    match_id: res.match_id,
    clan_a_tag: res.clan_a_tag,
    clan_b_tag: res.clan_b_tag,
    clan_a_score: Number(res.clan_a_score ?? 0),
    clan_b_score: Number(res.clan_b_score ?? 0),
    winner_clan_id: res.winner_clan_id ?? null,
    winner_clan_tag: res.winner_clan_tag ?? null
  };
  });

  app.get("/internal/clan/match/:id/teams", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const rows = await db.query(
    `SELECT mp.team, c.clan_tag
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     JOIN clan_members cm ON cm.steam_id = p.steam_id
     JOIN clans c ON c.clan_id = cm.clan_id
     WHERE mp.match_id = $1
     GROUP BY mp.team, c.clan_tag`,
    [params.id]
  );
  const teamA = rows.rows.filter((r) => String(r.team) === "A");
  const teamB = rows.rows.filter((r) => String(r.team) === "B");
  if (teamA.length !== 1 || teamB.length !== 1) {
    return reply.code(404).send({ error: "Clan matchup not available." });
  }
  return {
    match_id: params.id,
    clan_a_tag: String(teamA[0].clan_tag),
    clan_b_tag: String(teamB[0].clan_tag)
  };
  });

  app.post("/internal/player/cards", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      player_ids: z.array(z.string().uuid()).min(1).max(20)
    })
    .parse(request.body ?? {});

  const result = await db.query(
    `SELECT
       p.id AS player_id,
       p.display_name,
       p.player_rank,
       p.creator_badge,
       p.creator_code,
       COALESCE(p.level, 1) AS level,
       COALESCE(ps.wins, 0) AS wins,
       COALESCE(ps.matches_played, 0) AS matches_played
     FROM players p
     LEFT JOIN player_stats ps ON ps.player_id = p.id
     WHERE p.id = ANY($1::uuid[])`,
    [body.player_ids]
  );

  return {
    cards: result.rows
  };
  });

  app.get("/internal/player/history/:steamid", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const params = z.object({ steamid: z.string().min(3).max(64) }).parse(request.params);
  const player = await db.query(
    `SELECT id, steam_id, display_name, trust_score
     FROM players
     WHERE steam_id = $1`,
    [params.steamid]
  );
  if (!player.rowCount) {
    return reply.code(404).send({ error: "Player not found" });
  }

  const playerId = String(player.rows[0].id);
  const discord = await db.query("SELECT discord_id FROM steam_links WHERE steam_id = $1", [params.steamid]);
  const stats = await db.query(
    `SELECT matches_played
     FROM player_stats
     WHERE player_id = $1`,
    [playerId]
  );
  const reports = await db.query(
    `SELECT COUNT(*)::int AS reports_received
     FROM reports
     WHERE reported_player_id = $1`,
    [playerId]
  );
  const bans = await db.query(
    `SELECT COUNT(*)::int AS previous_bans
     FROM moderation_actions
     WHERE target_player_id = $1 AND action_type = 'ban'`,
    [playerId]
  );
  const logs = await db.query(
    `SELECT action, reason, match_id, timestamp
     FROM moderation_logs
     WHERE player_id = $1
     ORDER BY timestamp DESC
     LIMIT 30`,
    [playerId]
  );

  return {
    player: {
      id: playerId,
      steam_id: String(player.rows[0].steam_id),
      display_name: String(player.rows[0].display_name ?? params.steamid),
      discord_id: discord.rowCount ? String(discord.rows[0].discord_id ?? "") : null,
      trust_score: Number(player.rows[0].trust_score ?? 100)
    },
    summary: {
      matches_played: Number(stats.rows[0]?.matches_played ?? 0),
      reports_received: Number(reports.rows[0]?.reports_received ?? 0),
      previous_bans: Number(bans.rows[0]?.previous_bans ?? 0)
    },
    moderation_logs: logs.rows
  };
  });

  app.post("/internal/server-crashes", async (request) => {
  const body = z
    .object({
      server_id: z.string().min(2).max(128),
      match_id: z.string().uuid().optional(),
      map: z.string().optional(),
      reason: z.string().min(3).max(500),
      status: z.string().min(2).max(64).optional()
    })
    .parse(request.body ?? {});

  await db.query(
    `INSERT INTO server_crashes (server_id, match_id, reason, timestamp)
     VALUES ($1, $2, $3, NOW())`,
    [body.server_id, body.match_id ?? null, body.reason]
  );

  await createModerationLog({
    action: "server_crash",
    reason: body.reason,
    matchId: body.match_id ?? null,
    metadata: {
      server_id: body.server_id,
      map: body.map ?? null,
      status: body.status ?? "restarting"
    }
  });

  return { ok: true };
  });

  app.post("/internal/creator/apply", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      steam_id: z.string().min(3).max(64),
      requested_code: z.string().min(2).max(32).optional()
    })
    .parse(request.body ?? {});

  let player = await db.query("SELECT id, creator_badge, creator_code FROM players WHERE steam_id = $1", [body.steam_id]);
  if (!player.rowCount) {
    const inserted = await db.query(
      "INSERT INTO players (steam_id, display_name) VALUES ($1, $2) RETURNING id, creator_badge, creator_code",
      [body.steam_id, `Steam-${body.steam_id.slice(-6)}`]
    );
    player = inserted;
  }
  const playerId = String(player.rows[0].id);
  if (player.rows[0].creator_badge) {
    return { ok: true, status: "approved", creator_code: player.rows[0].creator_code };
  }

  const requestedCode = body.requested_code ? normalizeCreatorCode(body.requested_code) : null;
  await db.query(
    `INSERT INTO creator_applications (player_id, requested_code, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (player_id)
     DO UPDATE SET requested_code = EXCLUDED.requested_code, status = 'pending', reviewed_by = NULL, reviewed_at = NULL`,
    [playerId, requestedCode]
  );
  return { ok: true, status: "pending", requested_code: requestedCode };
  });

  app.post("/internal/creator/approve", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      steam_id: z.string().min(3).max(64),
      creator_code: z.string().min(2).max(32),
      reviewer_player_id: z.string().uuid().optional()
    })
    .parse(request.body ?? {});

  const creatorCode = normalizeCreatorCode(body.creator_code);
  const player = await db.query("SELECT id FROM players WHERE steam_id = $1", [body.steam_id]);
  if (!player.rowCount) {
    return reply.code(404).send({ error: "Player not found" });
  }
  const playerId = String(player.rows[0].id);

  const existingCode = await db.query("SELECT id FROM players WHERE creator_code = $1 AND id <> $2", [creatorCode, playerId]);
  if (existingCode.rowCount) {
    return reply.code(409).send({ error: "Creator code already in use" });
  }

  await db.query(
    `UPDATE players
     SET creator_badge = TRUE,
         creator_code = $2
     WHERE id = $1`,
    [playerId, creatorCode]
  );
  await db.query(
    `INSERT INTO creator_stats (creator_id, creator_referrals, creator_matches, creator_views, updated_at)
     VALUES ($1, 0, 0, 0, NOW())
     ON CONFLICT (creator_id) DO NOTHING`,
    [playerId]
  );
  await db.query(
    `UPDATE creator_applications
     SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
     WHERE player_id = $1`,
    [playerId, body.reviewer_player_id ?? null]
  );
  await db.query(
    `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
     VALUES ($1, 'creator_exclusive_pack', 'exclusive_skins', 'Creator program approval')
     ON CONFLICT (player_id, reward_code) DO NOTHING`,
    [playerId]
  );
  await db.query(
    `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
     VALUES ($1, 'ak47', 'creator_ember', NOW())
     ON CONFLICT (player_id, weapon)
     DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
    [playerId]
  );

  return { ok: true, steam_id: body.steam_id, creator_code: creatorCode, creator_badge: true };
  });

  app.post("/internal/creator/use", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      steam_id: z.string().min(3).max(64),
      creator_code: z.string().min(2).max(32)
    })
    .parse(request.body ?? {});
  const creatorCode = normalizeCreatorCode(body.creator_code);

  const creator = await db.query(
    "SELECT id FROM players WHERE creator_code = $1 AND creator_badge = TRUE LIMIT 1",
    [creatorCode]
  );
  if (!creator.rowCount) {
    return reply.code(404).send({ error: "Creator code not found" });
  }
  const creatorId = String(creator.rows[0].id);

  let player = await db.query("SELECT id FROM players WHERE steam_id = $1", [body.steam_id]);
  if (!player.rowCount) {
    const inserted = await db.query(
      "INSERT INTO players (steam_id, display_name) VALUES ($1, $2) RETURNING id",
      [body.steam_id, `Steam-${body.steam_id.slice(-6)}`]
    );
    player = inserted;
  }
  const playerId = String(player.rows[0].id);
  if (playerId === creatorId) {
    return reply.code(400).send({ error: "Cannot use your own creator code" });
  }

  const exists = await db.query("SELECT id FROM creator_referrals WHERE referred_player_id = $1", [playerId]);
  if (!exists.rowCount) {
    await db.query("UPDATE players SET referred_by_creator_id = $2 WHERE id = $1", [playerId, creatorId]);
    await db.query(
      `INSERT INTO creator_referrals (creator_id, referred_player_id, code_used)
       VALUES ($1, $2, $3)`,
      [creatorId, playerId, creatorCode]
    );
    await db.query(
      `UPDATE creator_stats
       SET creator_referrals = creator_referrals + 1, updated_at = NOW()
       WHERE creator_id = $1`,
      [creatorId]
    );
  }

  return { ok: true, creator_code: creatorCode, referred_player_id: playerId };
  });

  app.post("/internal/creator/view", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z.object({ creator_code: z.string().min(2).max(32) }).parse(request.body ?? {});
  const creatorCode = normalizeCreatorCode(body.creator_code);
  const creator = await db.query("SELECT id FROM players WHERE creator_code = $1 AND creator_badge = TRUE", [creatorCode]);
  if (!creator.rowCount) {
    return reply.code(404).send({ error: "Creator code not found" });
  }
  await db.query(
    `UPDATE creator_stats
     SET creator_views = creator_views + 1, updated_at = NOW()
     WHERE creator_id = $1`,
    [creator.rows[0].id]
  );
  return { ok: true, creator_code: creatorCode };
  });

  app.post("/internal/creator/viewer-reward", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      viewer_steam_id: z.string().min(3).max(64),
      viewer_discord_id: z.string().min(3).max(64),
      creator_steam_id: z.string().min(3).max(64).optional(),
      match_id: z.string().uuid().optional()
    })
    .parse(request.body ?? {});

  const rewardRoll = Math.random();
  const rewardType =
    rewardRoll < 0.35
      ? "creator_box"
      : rewardRoll < 0.65
      ? "xp_reward"
      : rewardRoll < 0.85
      ? "badge_reward"
      : "title_reward";

  await db.query(
    `INSERT INTO viewer_rewards (steam_id, discord_id, reward_type, date, match_id)
     VALUES ($1, $2, $3, NOW(), $4)`,
    [body.viewer_steam_id, body.viewer_discord_id, rewardType, body.match_id ?? null]
  );

  if (rewardType === "creator_box") {
    await db.query(
      `INSERT INTO player_boxes (steam_id, box_type, date_received, opened)
       VALUES ($1, 'creatorbox', NOW(), FALSE)`,
      [body.viewer_steam_id]
    );
  } else if (rewardType === "xp_reward") {
    const player = await db.query("SELECT id FROM players WHERE steam_id = $1 LIMIT 1", [body.viewer_steam_id]);
    if (player.rowCount) {
      await db.query("UPDATE players SET xp = xp + 100 WHERE id = $1", [player.rows[0].id]);
    }
  } else if (rewardType === "badge_reward") {
    const player = await db.query("SELECT id FROM players WHERE steam_id = $1 LIMIT 1", [body.viewer_steam_id]);
    if (player.rowCount) {
      await db.query(
        `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
         VALUES ($1, 'creator_viewer_badge', 'exclusive_skins', 'Creator stream viewer reward')
         ON CONFLICT (player_id, reward_code) DO NOTHING`,
        [player.rows[0].id]
      );
    }
  } else {
    const player = await db.query("SELECT id FROM players WHERE steam_id = $1 LIMIT 1", [body.viewer_steam_id]);
    if (player.rowCount) {
      await db.query(
        `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
         VALUES ($1, 'creator_viewer_title', 'exclusive_skins', 'Creator stream viewer title reward')
         ON CONFLICT (player_id, reward_code) DO NOTHING`,
        [player.rows[0].id]
      );
    }
  }

  return { ok: true, reward_type: rewardType };
  });

  app.post("/internal/report", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      reporter_steam_id: z.string().min(3).max(64),
      reported_steam_id: z.string().min(3).max(64),
      match_id: z.string().uuid(),
      reason: z.enum(reportReasons)
    })
    .parse(request.body);
  if (
    !(await enforceAccountRateLimit({
      route: "/internal/report",
      request,
      reply,
      steamId: body.reporter_steam_id,
      discordId: String(request.headers["x-discord-user-id"] ?? ""),
      max: 3,
      windowSec: 60
    }))
  ) {
    return;
  }
  const reportCooldownKey = `report:once:${body.match_id}:${body.reporter_steam_id}:${body.reported_steam_id}`;
  const reportCooldownOk = await redis.set(reportCooldownKey, "1", "EX", 24 * 60 * 60, "NX");
  if (reportCooldownOk !== "OK") {
    metrics.blocked_requests += 1;
    return reply.code(409).send({ error: "Duplicate report for this match target" });
  }

  const reporter = await db.query("SELECT id FROM players WHERE steam_id = $1", [body.reporter_steam_id]);
  const reported = await db.query("SELECT id FROM players WHERE steam_id = $1", [body.reported_steam_id]);
  if (!reporter.rowCount || !reported.rowCount) {
    await redis.del(reportCooldownKey);
    return reply.code(404).send({ error: "Reporter or reported player not found" });
  }

  const existingReport = await db.query(
    `SELECT id
     FROM reports
     WHERE match_id = $1 AND reporter_id = $2 AND reported_player_id = $3
     LIMIT 1`,
    [body.match_id, reporter.rows[0].id, reported.rows[0].id]
  );
  if (existingReport.rowCount) {
    metrics.blocked_requests += 1;
    return reply.code(409).send({ error: "Duplicate report for this match target" });
  }

  await db.query(
    `INSERT INTO reports (match_id, reporter_id, reported_player_id, reason)
     VALUES ($1, $2, $3, $4)`,
    [body.match_id, reporter.rows[0].id, reported.rows[0].id, body.reason]
  );
  await createModerationLog({
    action: "report",
    playerId: String(reported.rows[0].id),
    moderatorId: String(reporter.rows[0].id),
    reason: body.reason,
    matchId: body.match_id
  });
  const update = await db.query(
    `UPDATE players
     SET report_score = report_score + 1
     WHERE id = $1
     RETURNING report_score`,
    [reported.rows[0].id]
  );
  eventLogger.info("report_created", {
    reporter_id: reporter.rows[0].id,
    reported_player_id: reported.rows[0].id,
    match_id: body.match_id,
    reason: body.reason,
    report_score: Number(update.rows[0]?.report_score ?? 0),
    source: "discord_bot"
  });

  return {
    ok: true,
    match_id: body.match_id,
    reported_steam_id: body.reported_steam_id,
    report_score: Number(update.rows[0]?.report_score ?? 0)
  };
  });

  app.post("/internal/test/fake-players", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      count: z.number().int().min(2).max(10).default(10),
      region: z.string().min(2).max(16).default("eu")
    })
    .parse(request.body ?? {});
  const verified = await assertVerifiedDiscordSteam(request, reply, body.reporter_steam_id);
  if (!verified) return;

  const players: Array<{ player_id: string; steam_id: string; elo: number; region: string; timestamp: string }> = [];
  for (let i = 0; i < body.count; i += 1) {
    const steamId = `test_${Date.now()}_${i}_${crypto.randomBytes(2).toString("hex")}`;
    const mmr = 900 + Math.floor(Math.random() * 500);
    const inserted = await db.query(
      `INSERT INTO players (steam_id, display_name, mmr, elo, player_rank)
       VALUES ($1, $2, $3, $3, calculate_rank_from_mmr($3))
       RETURNING id`,
      [steamId, `TestPlayer${i + 1}`, mmr]
    );
    const playerId = String(inserted.rows[0].id);
    await db.query(
      `INSERT INTO player_stats (player_id, wins, losses, matches_played)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (player_id) DO NOTHING`,
      [playerId]
    );
    players.push({
      player_id: playerId,
      steam_id: steamId,
      elo: mmr,
      region: body.region,
      timestamp: new Date().toISOString()
    });
  }

  return { ok: true, players };
  });

  app.post("/queue/leave", { preHandler: [app.authenticate] }, async (request, reply) => {
  const playerId = request.user.playerId;
  const body = z.object({ mode: z.enum(queueModes).default("ranked") }).parse(request.body ?? {});
  if (
    !(await enforceAccountRateLimit({
      route: "/queue/leave",
      request,
      reply,
      steamId: request.user.steamId,
      discordId: String(request.headers["x-discord-user-id"] ?? ""),
      max: 4,
      windowSec: 10
    }))
  ) {
    return;
  }
  const entriesKey = queueEntriesKey(body.mode);
  const orderKey = queueOrderKey(body.mode);
  const smurfEntriesKey = queueEntriesKey(body.mode, "smurf");
  const smurfOrderKey = queueOrderKey(body.mode, "smurf");
  await redis
    .multi()
    .hdel(entriesKey, playerId)
    .zrem(orderKey, playerId)
    .hdel(smurfEntriesKey, playerId)
    .zrem(smurfOrderKey, playerId)
    .set(`queue:cooldown:${playerId}:${body.mode}`, "1", "EX", queueJoinCooldownSeconds)
    .exec();
  const size = (await redis.zcard(orderKey)) + (await redis.zcard(smurfOrderKey));
  await redis.publish("queue-events", JSON.stringify({ type: "queue_leave", playerId, mode: body.mode, size }));
  return { queued: false, size };
  });

  app.get("/queue/status", async (request) => {
  const query = z.object({ mode: z.enum(queueModes).default("ranked") }).parse(request.query ?? {});
  const mode = query.mode as QueueMode;
  const size = (await redis.zcard(queueOrderKey(mode))) + (await redis.zcard(queueOrderKey(mode, "smurf")));
  return { mode, size, needed: Math.max(0, modeConfig[mode].playersPerMatch - size) };
  });

  async function getTodayMapPool() {
    const today = new Date().toISOString().slice(0, 10);
    const row = await db.query("SELECT maps FROM daily_map_pool WHERE date = $1", [today]);
    if (row.rowCount) {
      return {
        date: today,
        maps: row.rows[0].maps
      };
    }
    return {
      date: today,
      maps: [...communityMaps]
    };
  }

  app.get("/maps/today", async () => {
    const result = await getTodayMapPool();
    return { maps: result.maps };
  });

  app.get("/maps/daily", async () => {
    return getTodayMapPool();
  });

  app.post("/internal/maps/daily", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      date: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional(),
      maps: z.array(z.enum(communityMaps)).min(1).max(5)
    })
    .parse(request.body);

  const date = body.date ?? new Date().toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO daily_map_pool (date, maps, updated_at)
     VALUES ($1::date, $2::text[], NOW())
     ON CONFLICT (date)
     DO UPDATE SET maps = EXCLUDED.maps, updated_at = NOW()`,
    [date, body.maps]
  );

  return { ok: true, date, maps: body.maps };
  });

  app.get("/matches/live", async () => {
  const result = await db.query(
    `SELECT
       m.*,
       COALESCE(m.team_a_score, 0) AS team_a_score,
       COALESCE(m.team_b_score, 0) AS team_b_score,
       COALESCE(m.round_number, 0) AS round_number,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', p.id,
               'display_name', p.display_name,
               'player_rank', p.player_rank,
               'team', mp.team
             )
             ORDER BY mp.team, p.display_name
           )
           FROM match_players mp
           JOIN players p ON p.id = mp.player_id
           WHERE mp.match_id = m.id
         ),
         '[]'::json
       ) AS players
     FROM matches m
     WHERE m.status = 'live'
     ORDER BY m.created_at DESC
     LIMIT 20`
  );

  return result.rows.map((row) => ({
    match_id: row.id,
    map: row.map,
    map_display: prettyMapName(row.map),
    creator_match: Boolean(row.creator_match),
    creator_player_id: row.creator_player_id ?? null,
    creator_stream_url: row.creator_stream_url ?? null,
    score: `${row.team_a_score}-${row.team_b_score}`,
    team_a_score: Number(row.team_a_score ?? 0),
    team_b_score: Number(row.team_b_score ?? 0),
    round: Number(row.round_number ?? 0),
    players: row.players ?? [],
    spectate_connect_command: null
  }));
  });

  app.get("/matches/history", { preHandler: [app.authenticate] }, async (request) => {
  const result = await db.query(
    `SELECT m.*
     FROM matches m
     JOIN match_players mp ON mp.match_id = m.id
     WHERE mp.player_id = $1
     ORDER BY m.created_at DESC
     LIMIT 50`,
    [request.user.playerId]
  );
  return result.rows;
  });

  app.get("/matches/:id", { config: { rateLimit: RATE_LIMIT_POLICIES.matchRead } }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const match = await db.query("SELECT * FROM matches WHERE id = $1", [params.id]);
  if (!match.rowCount) {
    return reply.code(404).send({ error: "Match not found" });
  }

  const players = await db.query(
    `SELECT mp.team, p.id, p.display_name, p.player_rank
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = $1
     ORDER BY mp.team, p.display_name`,
    [params.id]
  );
  const creator = match.rows[0].creator_player_id
    ? await db.query(
        `SELECT p.id, p.steam_id, p.display_name, sl.discord_id
         FROM players p
         LEFT JOIN steam_links sl ON sl.steam_id = p.steam_id
         WHERE p.id = $1`,
        [match.rows[0].creator_player_id]
      )
    : { rowCount: 0, rows: [] as any[] };

  return {
    id: match.rows[0].id,
    map: match.rows[0].map,
    status: match.rows[0].status,
    mode: match.rows[0].mode ?? "ranked",
    unranked: Boolean(match.rows[0].unranked),
    team_a_score: match.rows[0].team_a_score ?? null,
    team_b_score: match.rows[0].team_b_score ?? null,
    round_number: match.rows[0].round_number ?? 0,
    demo_url: match.rows[0].demo_url ?? null,
    created_at: match.rows[0].created_at,
    started_at: match.rows[0].started_at,
    ended_at: match.rows[0].ended_at,
    creator_match: Boolean(match.rows[0].creator_match),
    creator_stream_url: match.rows[0].creator_stream_url ?? null,
    creator: creator.rowCount ? creator.rows[0] : null,
    players: players.rows,
    connection_data: {
      server_ip: match.rows[0].server_ip,
      port: match.rows[0].server_port
    }
  };
  });

  app.get("/matches/:id/highlights", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db.query(
      `SELECT h.*, p.display_name
       FROM match_highlights h
       JOIN players p ON p.id = h.player_id
       WHERE h.match_id = $1
       ORDER BY h.timestamp_seconds ASC, h.created_at ASC`,
      [params.id]
    );
    return rows.rows;
  });

  app.get("/highlights/:id/clip", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.query(
      `SELECT id, clip_url, demo_url, timestamp_seconds
       FROM match_highlights
       WHERE id = $1`,
      [params.id]
    );
    if (!row.rowCount) {
      return reply.code(404).send({ error: "Highlight not found" });
    }
    const h = row.rows[0];
    const clipUrl = h.clip_url ?? buildClipUrl(h.demo_url ?? null, Number(h.timestamp_seconds ?? 0));
    if (!clipUrl) {
      return reply.code(404).send({ error: "Clip URL not available" });
    }
    return {
      highlight_id: h.id,
      download_url: clipUrl
    };
  });

  app.post("/report", {
    preHandler: [app.authenticate],
    config: { rateLimit: RATE_LIMIT_POLICIES.report }
  }, async (request, reply) => {
    const linkedSteam = await db.query("SELECT 1 FROM steam_links WHERE steam_id = $1 LIMIT 1", [request.user.steamId]);
    if (!linkedSteam.rowCount) {
      return reply.code(403).send({ error: "Steam account must be linked before reporting players" });
    }
    const body = z
      .object({
        match_id: z.string().uuid(),
        player_id: z.string().uuid(),
        reason: z.enum(reportReasons)
      })
      .parse(request.body);
    if (
      !(await enforceAccountRateLimit({
        route: "/report",
        request,
        reply,
        steamId: request.user.steamId,
        discordId: String(request.headers["x-discord-user-id"] ?? ""),
        max: 3,
        windowSec: 60
      }))
    ) {
      return;
    }
    const reportBurstKey = `throttle:report:${request.user.playerId}`;
    const reportBurst = await redis.incr(reportBurstKey);
    if (reportBurst === 1) {
      await redis.expire(reportBurstKey, 60);
    }
    if (reportBurst > RATE_LIMIT_POLICIES.report.max) {
      metrics.rate_limit_hits += 1;
      metrics.blocked_requests += 1;
      await redis.publish(
        "security-events",
        JSON.stringify({ type: "high_request_rate_blocked", route: "/report", player_id: request.user.playerId })
      );
      return reply.code(429).send({ error: "Too many reports" });
    }

    const reporter = await db.query(
      `SELECT id, created_at, report_muted_until, spam_reports_count
       FROM players
       WHERE id = $1`,
      [request.user.playerId]
    );
    if (!reporter.rowCount) {
      return reply.code(404).send({ error: "Reporter not found" });
    }
    const reporterRow = reporter.rows[0];
    if (reporterRow.report_muted_until && new Date(reporterRow.report_muted_until).getTime() > Date.now()) {
      metrics.blocked_requests += 1;
      return reply.code(403).send({ error: "Reporting temporarily muted" });
    }

    const existingReport = await db.query(
      `SELECT id
       FROM reports
       WHERE match_id = $1 AND reporter_id = $2 AND reported_player_id = $3
       LIMIT 1`,
      [body.match_id, request.user.playerId, body.player_id]
    );
    if (existingReport.rowCount) {
      const spamKey = `report:spam:${request.user.playerId}`;
      const spamCount = await redis.incr(spamKey);
      if (spamCount === 1) {
        await redis.expire(spamKey, 3600);
      }
      if (spamCount >= reportSpamThreshold) {
        await db.query(
          `UPDATE players
           SET report_muted_until = NOW() + ($2 || ' seconds')::interval,
               spam_reports_count = spam_reports_count + 1
           WHERE id = $1`,
          [request.user.playerId, String(reportMuteSeconds)]
        );
      }
      metrics.blocked_requests += 1;
      return reply.code(409).send({ error: "Duplicate report for this match target" });
    }

    await db.query(
      `INSERT INTO reports (match_id, reporter_id, reported_player_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [body.match_id, request.user.playerId, body.player_id, body.reason]
    );
    await createModerationLog({
      action: "report",
      playerId: body.player_id,
      moderatorId: request.user.playerId,
      reason: body.reason,
      matchId: body.match_id
    });

    const ageMs = Date.now() - new Date(reporterRow.created_at).getTime();
    const newAccountMs = newAccountReportWeightDays * 24 * 60 * 60 * 1000;
    const reportWeight = ageMs < newAccountMs ? 0.5 : 1;

    const updated = await db.query(
      `UPDATE players
       SET report_score = report_score + 1,
           report_score_weighted = report_score_weighted + $2
       WHERE id = $1
       RETURNING id, report_score, report_score_weighted`,
      [body.player_id, reportWeight]
    );
    const reportScore = Number(updated.rows[0]?.report_score ?? 0);
    const reportScoreWeighted = Number(updated.rows[0]?.report_score_weighted ?? reportScore);
    let createdCase: any = null;

    if (reportScoreWeighted > reportThreshold) {
      const existing = await db.query(
        "SELECT id FROM overwatch_cases WHERE reported_player_id = $1 AND status = 'open' LIMIT 1",
        [body.player_id]
      );

      if (!existing.rowCount) {
        const reportRows = await db.query(
          `SELECT id, reporter_id, reported_player_id, reason, created_at
           FROM reports
           WHERE match_id = $1 AND reported_player_id = $2
           ORDER BY created_at DESC`,
          [body.match_id, body.player_id]
        );
        const match = await db.query("SELECT demo_url FROM matches WHERE id = $1", [body.match_id]);
        const created = await db.query(
          `INSERT INTO overwatch_cases (reported_player_id, match_id, reports, demo_url, status)
           VALUES ($1, $2, $3::jsonb, $4, 'open')
           RETURNING *`,
          [body.player_id, body.match_id, JSON.stringify(reportRows.rows), match.rows[0]?.demo_url ?? null]
        );
        createdCase = created.rows[0];
        await redis.publish("overwatch-events", JSON.stringify({ type: "case_created", case: createdCase }));
      }
    }
    eventLogger.info("report_created", {
      reporter_id: request.user.playerId,
      reported_player_id: body.player_id,
      match_id: body.match_id,
      reason: body.reason,
      report_score: reportScore,
      report_score_weighted: reportScoreWeighted,
      report_weight: reportWeight,
      case_created: Boolean(createdCase)
    });

    return reply.send({
      ok: true,
      report_score: reportScore,
      report_score_weighted: reportScoreWeighted,
      report_weight: reportWeight,
      case_created: Boolean(createdCase),
      case: createdCase
    });
  });

  app.post("/reports", { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = z
      .object({
        matchId: z.string().uuid(),
        reportedPlayerId: z.string().uuid(),
        reason: z.enum(reportReasons)
      })
      .parse(request.body);
    return app.inject({
      method: "POST",
      url: "/report",
      headers: { authorization: request.headers.authorization ?? "" },
      payload: { match_id: body.matchId, player_id: body.reportedPlayerId, reason: body.reason }
    }).then((res) => reply.code(res.statusCode).send(JSON.parse(res.body)));
  });

  const antiCheatSchema = z.object({
    player_id: z.string().uuid(),
    match_id: z.string().uuid(),
    metrics: z.object({
      headshot_rate: z.number().min(0).max(100),
      reaction_time: z.number().positive(),
      wallbang_kills: z.number().int().min(0),
      prefire_kills: z.number().int().min(0).optional(),
      preaim_kills: z.number().int().min(0).optional(),
      adr: z.number().min(0),
      kd: z.number().min(0),
      reports_received: z.number().int().min(0)
    }).transform((m: {
      headshot_rate: number;
      reaction_time: number;
      wallbang_kills: number;
      prefire_kills?: number;
      preaim_kills?: number;
      adr: number;
      kd: number;
      reports_received: number;
    }) => ({
      headshot_rate: m.headshot_rate,
      reaction_time: m.reaction_time,
      wallbang_kills: m.wallbang_kills,
      prefire_kills: m.prefire_kills ?? m.preaim_kills ?? 0,
      adr: m.adr,
      kd: m.kd,
      reports_received: m.reports_received
    }))
  });

  async function analyzeCheating(input: z.infer<typeof antiCheatSchema>) {
    const result = calculateSuspicionScore(input.metrics);

    await db.query(
      `INSERT INTO player_suspicion (player_id, match_id, metrics, suspicion_score, status, reasons)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)`,
      [
        input.player_id,
        input.match_id,
        JSON.stringify(input.metrics),
        result.suspicion_score,
        result.status,
        JSON.stringify(result.reasons)
      ]
    );

    await db.query(
      `INSERT INTO player_suspicion_events (player_id, match_id, metrics, suspicion_score, status, reasons)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)`,
      [
        input.player_id,
        input.match_id,
        JSON.stringify(input.metrics),
        result.suspicion_score,
        result.status,
        JSON.stringify(result.reasons)
      ]
    );

    let caseResult: any = null;
    if (result.suspicion_score >= antiCheatCaseThreshold) {
      caseResult = await createOverwatchCaseFromSuspicion({
        player_id: input.player_id,
        match_id: input.match_id,
        suspicion_score: result.suspicion_score,
        reasons: result.reasons,
        metrics: input.metrics
      });
    }

    if (result.suspicion_score >= antiCheatTimeoutSuggestThreshold) {
      await redis.publish(
        "overwatch-events",
        JSON.stringify({
          type: "anti_cheat_alert",
          player_id: input.player_id,
          match_id: input.match_id,
          score: result.suspicion_score,
          reasons: result.reasons,
          suggest_timeout: true
        })
      );
      await createModerationLog({
        action: "anti_cheat_alert",
        playerId: input.player_id,
        reason: `suspicion_score=${result.suspicion_score}`,
        matchId: input.match_id
      });
    }

    return {
      player_id: input.player_id,
      match_id: input.match_id,
      suspicion_score: result.suspicion_score,
      status: result.status,
      reasons: result.reasons,
      overwatch_case_created: Boolean(caseResult?.caseCreated),
      case_id: caseResult?.caseId ?? null,
      timeout_suggested: result.suspicion_score >= antiCheatTimeoutSuggestThreshold,
      discord_alert_sent: result.suspicion_score >= antiCheatTimeoutSuggestThreshold
    };
  }

  app.post("/anti-cheat/analyze", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const body = antiCheatSchema.parse(request.body);
    return analyzeCheating(body);
  });

  app.post("/internal/anti-cheat/analyze", async (request) => {
    const body = antiCheatSchema.parse(request.body);
    return analyzeCheating(body);
  });

  const telemetryBaseSchema = z.object({
    match_id: z.string().uuid(),
    steam_id: z.string().min(3).max(64),
    ts: z.string().datetime().optional()
  });
  const telemetryEventSchema = z.discriminatedUnion("type", [
    telemetryBaseSchema.extend({
      type: z.literal("player_spawn"),
      payload: z.object({ round: z.number().int().positive() }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("player_death"),
      payload: z.object({
        killer: z.string().min(3).max(64),
        victim: z.string().min(3).max(64),
        weapon: z.string().min(1).max(64),
        headshot: z.boolean(),
        wallbang: z.boolean(),
        smoke: z.boolean().optional(),
        distance: z.number().min(0).max(10000).optional(),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("player_hurt"),
      payload: z.object({
        attacker: z.string().min(3).max(64),
        victim: z.string().min(3).max(64),
        damage: z.number().int().min(0).max(500),
        hitgroup: z.string().min(1).max(32),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("weapon_fire"),
      payload: z.object({
        player: z.string().min(3).max(64),
        weapon: z.string().min(1).max(64),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("bomb_event"),
      payload: z.object({
        event: z.enum(["plant", "defuse", "explode"]),
        player: z.string().min(3).max(64).optional(),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("round_start"),
      payload: z.object({
        round: z.number().int().positive(),
        score_team_a: z.number().int().min(0),
        score_team_b: z.number().int().min(0),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("round_end"),
      payload: z.object({
        round: z.number().int().positive(),
        score_team_a: z.number().int().min(0),
        score_team_b: z.number().int().min(0),
        winner: z.enum(["A", "B"]).optional(),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    }),
    telemetryBaseSchema.extend({
      type: z.literal("player_position"),
      payload: z.object({
        player: z.string().min(3).max(64),
        x: z.number().min(-100000).max(100000),
        y: z.number().min(-100000).max(100000),
        z: z.number().min(-100000).max(100000),
        round: z.number().int().positive().optional(),
        timestamp: z.number().int().min(0).optional()
      }).strict()
    })
  ]);

  type AntiCheatComputedMetrics = {
    kills: number;
    deaths: number;
    headshot_rate: number;
    wallbang_kills: number;
    wallbang_rate: number;
    avg_time_to_first_damage_after_peek: number;
    kill_reaction_proxy_ms: number;
    multi_kill_burst: number;
    smoke_kill_rate: number;
    prefire_proxy: number;
    adr: number;
    kd: number;
    reports_received: number;
    consistency_score: number;
    rounds: number;
  };

  function avg(values: number[]): number {
    if (!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  function bucketByMmr(mmr: number): string {
    if (mmr < 900) return "0_899";
    if (mmr < 1100) return "900_1099";
    if (mmr < 1300) return "1100_1299";
    if (mmr < 1500) return "1300_1499";
    if (mmr < 1700) return "1500_1699";
    if (mmr < 1900) return "1700_1899";
    return "1900_plus";
  }

  function calculateTelemetrySuspicion(metricsIn: AntiCheatComputedMetrics, mmr: number): {
    score: number;
    reasons: string[];
  } {
    const bucket = bucketByMmr(mmr);
    const baselines: Record<string, Record<string, { mean: number; std: number; inverse?: boolean }>> = {
      default: {
        headshot_rate: { mean: 43, std: 12 },
        wallbang_rate: { mean: 0.06, std: 0.05 },
        kill_reaction_proxy_ms: { mean: 260, std: 80, inverse: true },
        prefire_proxy: { mean: 0.18, std: 0.12 },
        multi_kill_burst: { mean: 1.8, std: 1.0 },
        smoke_kill_rate: { mean: 0.07, std: 0.06 },
        adr: { mean: 80, std: 18 },
        kd: { mean: 1.0, std: 0.35 }
      },
      high: {
        headshot_rate: { mean: 50, std: 11 },
        wallbang_rate: { mean: 0.08, std: 0.06 },
        kill_reaction_proxy_ms: { mean: 225, std: 70, inverse: true },
        prefire_proxy: { mean: 0.22, std: 0.14 },
        multi_kill_burst: { mean: 2.0, std: 1.1 },
        smoke_kill_rate: { mean: 0.09, std: 0.07 },
        adr: { mean: 90, std: 18 },
        kd: { mean: 1.15, std: 0.35 }
      }
    };
    const baseline = bucket === "1500_1699" || bucket === "1700_1899" || bucket === "1900_plus"
      ? baselines.high
      : baselines.default;
    const weight: Record<string, number> = {
      headshot_rate: 1.2,
      wallbang_rate: 1.0,
      kill_reaction_proxy_ms: 1.4,
      prefire_proxy: 1.2,
      multi_kill_burst: 1.0,
      smoke_kill_rate: 0.8,
      adr: 0.6,
      kd: 0.8
    };

    let score = 0;
    let strong = 0;
    const reasons: string[] = [];
    const metricRecord = metricsIn as unknown as Record<string, number>;
    for (const [key, cfg] of Object.entries(baseline)) {
      const value = Number(metricRecord[key] ?? 0);
      const z = cfg.inverse
        ? Math.max(0, (cfg.mean - value) / Math.max(1e-6, cfg.std))
        : Math.max(0, (value - cfg.mean) / Math.max(1e-6, cfg.std));
      score += Math.min(z, 4) * (weight[key] ?? 1);
      if (z >= 2.2) strong += 1;
      if (z >= 1.8) reasons.push(`${key} z=${z.toFixed(2)} (${bucket})`);
    }
    const reportFactor = Math.min(3, metricsIn.reports_received / 2);
    score += reportFactor;
    if (reportFactor > 0) reasons.push(`reports factor +${reportFactor.toFixed(2)}`);
    if (strong >= 3) {
      score += 2;
      reasons.push("multi-signal amplification +2");
    }

    return { score: Number(score.toFixed(3)), reasons };
  }

  async function createOrUpdateAntiCheatAlert(input: {
    matchId: string;
    steamId: string;
    playerId: string | null;
    score: number;
    reasons: string[];
    computedMetrics: AntiCheatComputedMetrics;
  }): Promise<{ id: string; status: string; caseId: string | null }> {
    let caseId: string | null = null;
    if (input.score >= antiCheatCaseThreshold && input.playerId) {
      const created = await createOverwatchCaseFromSuspicion({
        player_id: input.playerId,
        match_id: input.matchId,
        suspicion_score: input.score,
        reasons: input.reasons,
        metrics: input.computedMetrics
      });
      caseId = created.caseId ? String(created.caseId) : null;
    }

    const nextStatus =
      input.score >= antiCheatTimeoutSuggestThreshold
        ? "timeout_suggested"
        : caseId
          ? "case_created"
          : "open";

    const stored = await db.query(
      `INSERT INTO anti_cheat_alerts (match_id, steam_id, score, reasons_json, status, case_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (match_id, steam_id)
       DO UPDATE SET
         score = EXCLUDED.score,
         reasons_json = EXCLUDED.reasons_json,
         status = EXCLUDED.status,
         case_id = COALESCE(EXCLUDED.case_id, anti_cheat_alerts.case_id)
       RETURNING id, status, case_id`,
      [
        input.matchId,
        input.steamId,
        input.score,
        JSON.stringify({ reasons: input.reasons, metrics: input.computedMetrics }),
        nextStatus,
        caseId
      ]
    );
    const row = stored.rows[0];
    metrics.anti_cheat_alerts_created += 1;
    await createModerationLog({
      action: "anti_cheat_alert",
      playerId: input.playerId ?? undefined,
      reason: `score=${input.score.toFixed(3)}; steam=${input.steamId}`,
      matchId: input.matchId
    });
    await redis.publish(
      "overwatch-events",
      JSON.stringify({
        type: "anti_cheat_alert",
        alert_id: row.id,
        steam_id: input.steamId,
        player_id: input.playerId,
        match_id: input.matchId,
        score: input.score,
        reasons: input.reasons.slice(0, 6),
        status: String(row.status),
        case_id: row.case_id ?? null,
        suggest_timeout: input.score >= antiCheatTimeoutSuggestThreshold
      })
    );
    return { id: String(row.id), status: String(row.status), caseId: row.case_id ? String(row.case_id) : null };
  }

  async function processAntiCheatTelemetryForMatch(matchId: string): Promise<{ processedPlayers: number; createdAlerts: number }> {
    const events = await db.query(
      `SELECT steam_id, type, payload_json, ts
       FROM telemetry_events
       WHERE match_id = $1
       ORDER BY ts ASC, created_at ASC`,
      [matchId]
    );
    if (!events.rowCount) return { processedPlayers: 0, createdAlerts: 0 };

    const reports = await db.query(
      `SELECT rp.steam_id, COUNT(*)::int AS reports_received
       FROM reports r
       JOIN players rp ON rp.id = r.reported_player_id
       WHERE r.match_id = $1
       GROUP BY rp.steam_id`,
      [matchId]
    );
    const reportsBySteam = new Map<string, number>(reports.rows.map((r) => [String(r.steam_id), Number(r.reports_received ?? 0)]));

    type Agg = {
      kills: number;
      deaths: number;
      headshots: number;
      wallbangKills: number;
      smokeKills: number;
      damage: number;
      killTs: number[];
      fireTs: number[];
      prefireCount: number;
      peekToDamageSamples: number[];
      reactionSamples: number[];
    };
    const agg = new Map<string, Agg>();
    const ensureAgg = (steamId: string): Agg => {
      const existing = agg.get(steamId);
      if (existing) return existing;
      const value: Agg = {
        kills: 0,
        deaths: 0,
        headshots: 0,
        wallbangKills: 0,
        smokeKills: 0,
        damage: 0,
        killTs: [],
        fireTs: [],
        prefireCount: 0,
        peekToDamageSamples: [],
        reactionSamples: []
      };
      agg.set(steamId, value);
      return value;
    };

    let rounds = 0;
    for (const row of events.rows) {
      const type = String(row.type);
      const payload = (row.payload_json ?? {}) as Record<string, unknown>;
      const eventTs = payload.timestamp ? Number(payload.timestamp) : new Date(row.ts).getTime();
      if (type === "round_end") {
        rounds += 1;
      } else if (type === "weapon_fire") {
        const player = String(payload.player ?? row.steam_id);
        ensureAgg(player).fireTs.push(eventTs);
      } else if (type === "player_hurt") {
        const attacker = String(payload.attacker ?? row.steam_id);
        const a = ensureAgg(attacker);
        a.damage += Number(payload.damage ?? 0);
        const lastFire = a.fireTs[a.fireTs.length - 1];
        if (lastFire && eventTs >= lastFire && eventTs - lastFire <= 1000) {
          a.peekToDamageSamples.push(eventTs - lastFire);
        }
      } else if (type === "player_death") {
        const killer = String(payload.killer ?? row.steam_id);
        const victim = String(payload.victim ?? "");
        const k = ensureAgg(killer);
        k.kills += 1;
        k.killTs.push(eventTs);
        if (Boolean(payload.headshot)) k.headshots += 1;
        if (Boolean(payload.wallbang)) k.wallbangKills += 1;
        if (Boolean(payload.smoke)) k.smokeKills += 1;
        const lastFire = k.fireTs[k.fireTs.length - 1];
        if (lastFire && eventTs >= lastFire && eventTs - lastFire <= 2000) {
          k.reactionSamples.push(eventTs - lastFire);
          if (eventTs - lastFire <= 160) k.prefireCount += 1;
        }
        if (victim) {
          ensureAgg(victim).deaths += 1;
        }
      }
    }

    const players = await db.query("SELECT id, steam_id, mmr FROM players WHERE steam_id = ANY($1::text[])", [Array.from(agg.keys())]);
    const playerBySteam = new Map<string, { id: string; mmr: number }>(
      players.rows.map((p) => [String(p.steam_id), { id: String(p.id), mmr: Number(p.mmr ?? 1000) }])
    );

    let createdAlerts = 0;
    for (const [steamId, value] of agg.entries()) {
      const kills = value.kills;
      const deaths = value.deaths;
      const roundsPlayed = Math.max(1, rounds);
      let burst = 0;
      for (let i = 0; i < value.killTs.length; i += 1) {
        let count = 1;
        for (let j = i + 1; j < value.killTs.length; j += 1) {
          if (value.killTs[j] - value.killTs[i] <= 2000) count += 1;
          else break;
        }
        burst = Math.max(burst, count);
      }
      const metricsForMatch: AntiCheatComputedMetrics = {
        kills,
        deaths,
        headshot_rate: kills > 0 ? Number(((value.headshots / kills) * 100).toFixed(3)) : 0,
        wallbang_kills: value.wallbangKills,
        wallbang_rate: kills > 0 ? Number((value.wallbangKills / kills).toFixed(4)) : 0,
        avg_time_to_first_damage_after_peek: Number(avg(value.peekToDamageSamples).toFixed(3)),
        kill_reaction_proxy_ms: Number(avg(value.reactionSamples).toFixed(3)),
        multi_kill_burst: burst,
        smoke_kill_rate: kills > 0 ? Number((value.smokeKills / kills).toFixed(4)) : 0,
        prefire_proxy: kills > 0 ? Number((value.prefireCount / kills).toFixed(4)) : 0,
        adr: Number((value.damage / roundsPlayed).toFixed(3)),
        kd: Number((kills / Math.max(1, deaths)).toFixed(3)),
        reports_received: reportsBySteam.get(steamId) ?? 0,
        consistency_score: 50,
        rounds: roundsPlayed
      };

      await db.query(
        `INSERT INTO player_match_metrics (match_id, steam_id, metrics_json, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW(), NOW())
         ON CONFLICT (match_id, steam_id)
         DO UPDATE SET metrics_json = EXCLUDED.metrics_json, updated_at = NOW()`,
        [matchId, steamId, JSON.stringify(metricsForMatch)]
      );

      const recent = await db.query(
        `SELECT metrics_json
         FROM player_match_metrics
         WHERE steam_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [steamId]
      );
      const recentRows = recent.rows.map((r) => r.metrics_json as any);
      const hsList = recentRows.map((r) => Number(r.headshot_rate ?? 0));
      const kdList = recentRows.map((r) => Number(r.kd ?? 0));
      const adrList = recentRows.map((r) => Number(r.adr ?? 0));
      const hsStd = hsList.length > 1 ? Math.sqrt(avg(hsList.map((x) => (x - avg(hsList)) ** 2))) : 0;
      const kdStd = kdList.length > 1 ? Math.sqrt(avg(kdList.map((x) => (x - avg(kdList)) ** 2))) : 0;
      const adrStd = adrList.length > 1 ? Math.sqrt(avg(adrList.map((x) => (x - avg(adrList)) ** 2))) : 0;
      metricsForMatch.consistency_score = Number(Math.max(0, Math.min(100, 100 - avg([hsStd / 10, kdStd * 20, adrStd / 4]))).toFixed(3));

      await db.query(
        `UPDATE player_match_metrics
         SET metrics_json = $3::jsonb, updated_at = NOW()
         WHERE match_id = $1 AND steam_id = $2`,
        [matchId, steamId, JSON.stringify(metricsForMatch)]
      );

      const p = playerBySteam.get(steamId);
      const suspicion = calculateTelemetrySuspicion(metricsForMatch, p?.mmr ?? 1000);
      const level =
        suspicion.score >= antiCheatTimeoutSuggestThreshold
          ? "critical"
          : suspicion.score >= antiCheatCaseThreshold
            ? "review"
            : suspicion.score >= antiCheatFlagThreshold
              ? "flagged"
              : "normal";
      await db.query(
        `INSERT INTO player_anti_cheat_profile (steam_id, rolling_metrics_json, suspicion_level, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (steam_id)
         DO UPDATE SET rolling_metrics_json = EXCLUDED.rolling_metrics_json,
                       suspicion_level = EXCLUDED.suspicion_level,
                       updated_at = NOW()`,
        [steamId, JSON.stringify({ last_10_matches: recentRows, last_match: metricsForMatch, latest_score: suspicion.score }), level]
      );

      if (suspicion.score >= antiCheatFlagThreshold) {
        await createOrUpdateAntiCheatAlert({
          matchId,
          steamId,
          playerId: p?.id ?? null,
          score: suspicion.score,
          reasons: suspicion.reasons,
          computedMetrics: metricsForMatch
        });
        createdAlerts += 1;
      }
    }
    return { processedPlayers: agg.size, createdAlerts };
  }

  app.post("/telemetry/event", {
    config: { rateLimit: RATE_LIMIT_POLICIES.telemetryIngest }
  }, async (request, reply) => {
    if (!(await verifyTelemetryRequest(request, reply))) return;
    const body = telemetryEventSchema.parse(request.body ?? {});
    await db.query(
      `INSERT INTO telemetry_events (match_id, steam_id, type, payload_json, ts)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        body.match_id,
        body.steam_id,
        body.type,
        JSON.stringify(body.payload),
        body.ts ? new Date(body.ts) : new Date()
      ]
    );
    return { ok: true };
  });

  app.post("/internal/anti-cheat/process", async (request) => {
    const body = z.object({ limit: z.number().int().min(1).max(100).default(10) }).parse(request.body ?? {});
    const pending = await db.query(
      `SELECT match_id, MIN(created_at) AS first_seen
       FROM telemetry_events
       WHERE processed = FALSE
       GROUP BY match_id
       ORDER BY first_seen ASC
       LIMIT $1`,
      [body.limit]
    );
    const results: Array<{ match_id: string; processed_players: number; created_alerts: number }> = [];
    for (const row of pending.rows) {
      const matchId = String(row.match_id);
      const processed = await processAntiCheatTelemetryForMatch(matchId);
      await db.query("UPDATE telemetry_events SET processed = TRUE WHERE match_id = $1 AND processed = FALSE", [matchId]);
      results.push({
        match_id: matchId,
        processed_players: processed.processedPlayers,
        created_alerts: processed.createdAlerts
      });
    }
    return { ok: true, processed_matches: results.length, results };
  });

  app.get("/anti-cheat/player/:steamId", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const params = z.object({ steamId: z.string().min(3).max(64) }).parse(request.params);
    const profile = await db.query(
      `SELECT steam_id, rolling_metrics_json, suspicion_level, updated_at
       FROM player_anti_cheat_profile
       WHERE steam_id = $1`,
      [params.steamId]
    );
    const metricsRows = await db.query(
      `SELECT match_id, metrics_json, created_at
       FROM player_match_metrics
       WHERE steam_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [params.steamId]
    );
    const alertsRows = await db.query(
      `SELECT id, match_id, steam_id, score, reasons_json, status, case_id, created_at, resolved_at
       FROM anti_cheat_alerts
       WHERE steam_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [params.steamId]
    );
    return {
      steam_id: params.steamId,
      profile: profile.rowCount ? profile.rows[0] : null,
      recent_match_metrics: metricsRows.rows,
      alerts: alertsRows.rows
    };
  });

  app.get("/anti-cheat/alerts", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const query = z
      .object({
        status: z.enum(["open", "case_created", "timeout_suggested", "resolved", "false_positive", "timeout_applied"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query ?? {});

    const sql = query.status
      ? `SELECT a.id, a.match_id, a.steam_id, a.score, a.reasons_json, a.status, a.case_id, a.created_at,
                m.server_ip, m.server_port, m.spectator_password, m.status AS match_status
         FROM anti_cheat_alerts a
         JOIN matches m ON m.id = a.match_id
         WHERE a.status = $1
         ORDER BY a.created_at DESC
         LIMIT $2`
      : `SELECT a.id, a.match_id, a.steam_id, a.score, a.reasons_json, a.status, a.case_id, a.created_at,
                m.server_ip, m.server_port, m.spectator_password, m.status AS match_status
         FROM anti_cheat_alerts a
         JOIN matches m ON m.id = a.match_id
         ORDER BY a.created_at DESC
         LIMIT $1`;
    const rows = await db.query(sql, query.status ? [query.status, query.limit] : [query.limit]);
    return rows.rows.map((row) => ({
      ...row,
      spectate_command:
        String(row.match_status) === "live"
          ? `connect ${row.server_ip}:${row.server_port}; password ${row.spectator_password}`
          : null
    }));
  });

  app.post("/anti-cheat/alerts/:id/resolve", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ action: z.enum(["false_positive", "open_case", "timeout_24h", "clean"]) }).parse(request.body ?? {});
    const alert = await db.query(
      "SELECT id, match_id, steam_id, score, reasons_json, status, case_id FROM anti_cheat_alerts WHERE id = $1",
      [params.id]
    );
    if (!alert.rowCount) {
      return reply.code(404).send({ error: "Alert not found" });
    }
    const row = alert.rows[0];
    const player = await db.query("SELECT id FROM players WHERE steam_id = $1 LIMIT 1", [row.steam_id]);
    const playerId = player.rowCount ? String(player.rows[0].id) : null;
    let status = "resolved";
    let caseId = row.case_id ? String(row.case_id) : null;

    if (body.action === "false_positive") {
      status = "false_positive";
    } else if (body.action === "open_case") {
      status = "case_created";
      if (!caseId && playerId) {
        const created = await createOverwatchCaseFromSuspicion({
          player_id: playerId,
          match_id: String(row.match_id),
          suspicion_score: Number(row.score ?? 0),
          reasons: Array.isArray((row.reasons_json ?? {}).reasons) ? row.reasons_json.reasons : [],
          metrics: (row.reasons_json ?? {}).metrics ?? {}
        });
        caseId = created.caseId ? String(created.caseId) : null;
      }
    } else if (body.action === "timeout_24h") {
      status = "timeout_applied";
      if (playerId) {
        await db.query(
          `UPDATE players
           SET banned_until = CASE
             WHEN banned_until IS NULL OR banned_until < NOW() + INTERVAL '24 hours'
               THEN NOW() + INTERVAL '24 hours'
             ELSE banned_until
           END
           WHERE id = $1`,
          [playerId]
        );
      }
    } else {
      status = "resolved";
    }

    await db.query(
      `UPDATE anti_cheat_alerts
       SET status = $2,
           case_id = COALESCE($3, case_id),
           resolved_by = $4,
           resolved_note = $5,
           resolved_at = NOW()
       WHERE id = $1`,
      [params.id, status, caseId, request.user.playerId, body.action]
    );
    await createModerationLog({
      action: "anti_cheat_alert_resolve",
      playerId: playerId ?? undefined,
      moderatorId: request.user.playerId,
      reason: `alert=${params.id}; action=${body.action}`,
      matchId: String(row.match_id)
    });
    return { ok: true, alert_id: params.id, status, case_id: caseId };
  });

  app.post("/internal/highlights/event", async (request, reply) => {
    if (botApiToken) {
      const token = String(request.headers["x-bot-token"] ?? "");
      if (token !== botApiToken) {
        return reply.code(401).send({ error: "Unauthorized bot token" });
      }
    }

    const body = z
      .object({
        match_id: z.string().uuid(),
        player_id: z.string().uuid(),
        event_type: z.enum(highlightEventTypes),
        round_number: z.number().int().positive().optional(),
        timestamp_seconds: z.number().int().min(0),
        metadata: z.record(z.unknown()).optional()
      })
      .parse(request.body ?? {});

    const stored = await storeHighlight({
      match_id: body.match_id,
      player_id: body.player_id,
      event_type: body.event_type,
      round_number: body.round_number ?? null,
      timestamp_seconds: body.timestamp_seconds,
      metadata: body.metadata
    });

    return { ok: true, highlight: stored };
  });

  app.post("/internal/highlights/ingest-round", async (request, reply) => {
    if (botApiToken) {
      const token = String(request.headers["x-bot-token"] ?? "");
      if (token !== botApiToken) {
        return reply.code(401).send({ error: "Unauthorized bot token" });
      }
    }

    const body = z
      .object({
        match_id: z.string().uuid(),
        round_number: z.number().int().positive(),
        round_winner_team: z.enum(["A", "B"]).optional(),
        kills: z.array(
          z.object({
            killer_id: z.string().uuid(),
            victim_id: z.string().uuid(),
            killer_team: z.enum(["A", "B"]),
            timestamp_seconds: z.number().int().min(0),
            is_noscope: z.boolean().optional(),
            attacker_alive: z.number().int().min(0).optional(),
            defender_alive: z.number().int().min(0).optional()
          })
        )
      })
      .parse(request.body ?? {});

    if (body.round_winner_team) {
      const incA = body.round_winner_team === "A" ? 1 : 0;
      const incB = body.round_winner_team === "B" ? 1 : 0;
      await db.query(
        `UPDATE matches
         SET round_number = GREATEST(COALESCE(round_number, 0), $2),
             team_a_score = COALESCE(team_a_score, 0) + $3,
             team_b_score = COALESCE(team_b_score, 0) + $4
         WHERE id = $1`,
        [body.match_id, body.round_number, incA, incB]
      );
    } else {
      await db.query(
        `UPDATE matches
         SET round_number = GREATEST(COALESCE(round_number, 0), $2)
         WHERE id = $1`,
        [body.match_id, body.round_number]
      );
    }

    const created: any[] = [];
    const killsByPlayer = new Map<string, number>();
    const earliestTsByPlayer = new Map<string, number>();
    let clutchCandidate:
      | {
          player_id: string;
          team: "A" | "B";
          timestamp_seconds: number;
          enemy_count: number;
        }
      | null = null;

    for (const k of body.kills) {
      const count = (killsByPlayer.get(k.killer_id) ?? 0) + 1;
      killsByPlayer.set(k.killer_id, count);
      if (!earliestTsByPlayer.has(k.killer_id)) {
        earliestTsByPlayer.set(k.killer_id, k.timestamp_seconds);
      }

      if (k.is_noscope) {
        created.push(
          await storeHighlight({
            match_id: body.match_id,
            player_id: k.killer_id,
            event_type: "noscope_kill",
            round_number: body.round_number,
            timestamp_seconds: k.timestamp_seconds,
            metadata: { victim_id: k.victim_id }
          })
        );
      }

      if (k.attacker_alive !== undefined && k.defender_alive !== undefined) {
        const myAlive = k.killer_team === "A" ? k.attacker_alive : k.defender_alive;
        const enemyAlive = k.killer_team === "A" ? k.defender_alive : k.attacker_alive;
        if (myAlive === 1 && enemyAlive >= 3) {
          clutchCandidate = {
            player_id: k.killer_id,
            team: k.killer_team,
            timestamp_seconds: k.timestamp_seconds,
            enemy_count: enemyAlive
          };
        }
      }
    }

    for (const [playerId, kills] of killsByPlayer.entries()) {
      if (kills >= 4) {
        created.push(
          await storeHighlight({
            match_id: body.match_id,
            player_id: playerId,
            event_type: kills >= 5 ? "ace" : "4k",
            round_number: body.round_number,
            timestamp_seconds: earliestTsByPlayer.get(playerId) ?? 0,
            metadata: { kills_in_round: kills }
          })
        );
      }
    }

    if (clutchCandidate && body.round_winner_team && clutchCandidate.team === body.round_winner_team) {
      created.push(
        await storeHighlight({
          match_id: body.match_id,
          player_id: clutchCandidate.player_id,
          event_type: "clutch_1v3",
          round_number: body.round_number,
          timestamp_seconds: clutchCandidate.timestamp_seconds,
          metadata: { enemy_count: clutchCandidate.enemy_count }
        })
      );
    }

    return { ok: true, count: created.length, highlights: created };
  });

  app.post("/clip", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const body = z
      .object({
        match_id: z.string().uuid(),
        timestamp: z.number().int().min(0),
        player_id: z.string().uuid().optional()
      })
      .parse(request.body ?? {});
    const clip = await generateEvidenceClip({
      match_id: body.match_id,
      timestamp: body.timestamp,
      player_id: body.player_id ?? null
    });
    return {
      ok: true,
      clip_id: clip.clip_id,
      match_id: clip.match_id,
      player_id: clip.player_id,
      timestamp: clip.timestamp,
      clip_url: clip.clip_url,
      created_at: clip.created_at
    };
  });

  app.post("/internal/clip", async (request, reply) => {
    if (botApiToken) {
      const token = String(request.headers["x-bot-token"] ?? "");
      if (token !== botApiToken) {
        return reply.code(401).send({ error: "Unauthorized bot token" });
      }
    }
    const body = z
      .object({
        match_id: z.string().uuid(),
        timestamp: z.number().int().min(0),
        player_id: z.string().uuid().optional()
      })
      .parse(request.body ?? {});
    const clip = await generateEvidenceClip({
      match_id: body.match_id,
      timestamp: body.timestamp,
      player_id: body.player_id ?? null
    });
    return {
      ok: true,
      clip_id: clip.clip_id,
      match_id: clip.match_id,
      player_id: clip.player_id,
      timestamp: clip.timestamp,
      clip_url: clip.clip_url,
      created_at: clip.created_at
    };
  });

  app.get("/cases", {
    preHandler: [app.authenticate],
    config: { rateLimit: RATE_LIMIT_POLICIES.casesRead }
  }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;

    const result = await db.query(
      `SELECT
         oc.id AS case_id,
         oc.reported_player_id AS player_id,
         oc.match_id,
         oc.reports,
         oc.demo_url,
         oc.status,
         m.status AS match_status,
         m.server_ip,
         m.server_port,
         m.spectator_password
       FROM overwatch_cases oc
       JOIN matches m ON m.id = oc.match_id
       ORDER BY oc.created_at DESC`
    );

    return result.rows.map((row) => ({
      case_id: row.case_id,
      player_id: row.player_id,
      match_id: row.match_id,
      reports: row.reports,
      demo_url: row.demo_url,
      status: row.status,
      spectate_command:
        row.match_status === "live"
          ? `connect ${row.server_ip}:${row.server_port}; password ${row.spectator_password}`
          : null
    }));
  });

  app.get("/overwatch/cases", {
    preHandler: [app.authenticate],
    config: { rateLimit: RATE_LIMIT_POLICIES.casesRead }
  }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const response = await app.inject({
      method: "GET",
      url: "/cases",
      headers: { authorization: request.headers.authorization ?? "" }
    });
    return reply.code(response.statusCode).send(JSON.parse(response.body));
  });

  app.get("/ban-evasion/cases", {
    preHandler: [app.authenticate],
    config: { rateLimit: RATE_LIMIT_POLICIES.casesRead }
  }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const rows = await db.query(
      `SELECT case_id, steam_id, discord_id, suspicion_score, matched_account, status, reasons, evidence, created_at, updated_at
       FROM ban_evasion_cases
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return rows.rows;
  });

  app.post("/ban-evasion/cases/:id/action", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        action: z.enum(["allow", "monitor", "ban"]),
        note: z.string().max(500).optional()
      })
      .parse(request.body ?? {});

    const found = await db.query(
      "SELECT case_id, steam_id, status FROM ban_evasion_cases WHERE case_id = $1",
      [params.id]
    );
    if (!found.rowCount) {
      return reply.code(404).send({ error: "Case not found" });
    }

    let nextStatus: "allowed" | "monitoring" | "banned" = "allowed";
    if (body.action === "monitor") nextStatus = "monitoring";
    if (body.action === "ban") nextStatus = "banned";

    await db.query(
      `UPDATE ban_evasion_cases
       SET status = $2, updated_at = NOW(), resolved_by = $3, resolution_note = $4
       WHERE case_id = $1`,
      [params.id, nextStatus, request.user.playerId, body.note ?? null]
    );

    if (body.action === "ban") {
      const target = await db.query("SELECT id FROM players WHERE steam_id = $1", [found.rows[0].steam_id]);
      if (target.rowCount) {
        await db.query("UPDATE players SET permanent_ban = TRUE, banned_until = NULL WHERE id = $1", [target.rows[0].id]);
        await db.query(
          `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
           VALUES ($1, $2, 'ban', $3)`,
          [request.user.playerId, target.rows[0].id, `ban_evasion_case:${params.id}`]
        );
        await createBanLog({
          targetPlayerId: String(target.rows[0].id),
          reason: "Ban Evasion",
          caseId: params.id
        });
        await createModerationLog({
          action: "ban",
          playerId: String(target.rows[0].id),
          moderatorId: request.user.playerId,
          reason: "Ban Evasion"
        });
      }
    }

    await createModerationLog({
      action: "ban_evasion_decision",
      moderatorId: request.user.playerId,
      reason: `case=${params.id}; action=${body.action}; status=${nextStatus}`
    });

    await redis.publish(
      "overwatch-events",
      JSON.stringify({
        type: "ban_evasion_case_updated",
        case_id: params.id,
        action: body.action,
        status: nextStatus,
        moderator_id: request.user.playerId
      })
    );

    return { ok: true, case_id: params.id, status: nextStatus };
  });

  app.get("/risk/smurf/:steamId", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const params = z.object({ steamId: z.string().min(3).max(64) }).parse(request.params);
    const profile = await db.query(
      `SELECT steam_id, smurf_score, ban_evasion_score, reasons_json, status, updated_at
       FROM player_risk_profile
       WHERE steam_id = $1`,
      [params.steamId]
    );
    const alerts = await db.query(
      `SELECT id, type, score, reasons_json, matched_accounts, status, created_at, updated_at, resolved_by, resolution_note
       FROM risk_alerts
       WHERE steam_id = $1
       ORDER BY created_at DESC
       LIMIT 25`,
      [params.steamId]
    );
    if (!profile.rowCount) {
      return {
        steam_id: params.steamId,
        profile: null,
        alerts: alerts.rows
      };
    }
    return {
      steam_id: params.steamId,
      profile: profile.rows[0],
      alerts: alerts.rows
    };
  });

  app.get("/risk/smurf-alerts", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const query = z
      .object({
        status: z.enum(["open", "monitor", "allow", "false_positive", "true_positive", "block_ranked", "blocked", "banned", "resolved"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query ?? {});
    const sql = query.status
      ? `SELECT id, steam_id, type, score, reasons_json, matched_accounts, status, created_at, updated_at
         FROM risk_alerts
         WHERE type = 'smurf' AND status = $1
         ORDER BY created_at DESC
         LIMIT $2`
      : `SELECT id, steam_id, type, score, reasons_json, matched_accounts, status, created_at, updated_at
         FROM risk_alerts
         WHERE type = 'smurf'
         ORDER BY created_at DESC
         LIMIT $1`;
    const rows = await db.query(sql, query.status ? [query.status, query.limit] : [query.limit]);
    return rows.rows;
  });

  app.post("/risk/smurf/:steamId/action", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const params = z.object({ steamId: z.string().min(3).max(64) }).parse(request.params);
    const body = z
      .object({
        action: z.enum(["allow", "monitor", "open_evidence", "block_ranked", "ban", "false_positive", "true_positive"]),
        alert_id: z.string().uuid().optional(),
        note: z.string().max(500).optional()
      })
      .parse(request.body ?? {});

    let targetAlertId = body.alert_id ?? null;
    if (!targetAlertId) {
      const latest = await db.query(
        `SELECT id
         FROM risk_alerts
         WHERE steam_id = $1 AND type = 'smurf'
         ORDER BY created_at DESC
         LIMIT 1`,
        [params.steamId]
      );
      targetAlertId = latest.rowCount ? String(latest.rows[0].id) : null;
    }
    if (!targetAlertId) {
      return reply.code(404).send({ error: "Smurf alert not found" });
    }

    const statusMap: Record<string, string> = {
      allow: "allow",
      monitor: "monitor",
      open_evidence: "resolved",
      block_ranked: "block_ranked",
      ban: "banned",
      false_positive: "false_positive",
      true_positive: "true_positive"
    };
    const nextStatus = statusMap[body.action];
    await db.query(
      `UPDATE risk_alerts
       SET status = $2, updated_at = NOW(), resolved_by = $3, resolution_note = $4
       WHERE id = $1`,
      [targetAlertId, nextStatus, request.user.playerId, body.note ?? body.action]
    );

    if (body.action === "block_ranked" || body.action === "ban") {
      const targetPlayer = await db.query("SELECT id FROM players WHERE steam_id = $1", [params.steamId]);
      if (targetPlayer.rowCount) {
        if (body.action === "ban") {
          await db.query("UPDATE players SET permanent_ban = TRUE, banned_until = NULL WHERE id = $1", [targetPlayer.rows[0].id]);
          await createBanLog({
            targetPlayerId: String(targetPlayer.rows[0].id),
            reason: "Smurf / Alt Ban"
          });
        } else {
          await db.query(
            `UPDATE player_risk_profile
             SET status = 'high_suspicion', updated_at = NOW()
             WHERE steam_id = $1`,
            [params.steamId]
          );
        }
      }
    }

    await createModerationLog({
      action: "smurf_alert_action",
      moderatorId: request.user.playerId,
      reason: `steam=${params.steamId}; action=${body.action}; alert=${targetAlertId}`
    });
    return { ok: true, steam_id: params.steamId, alert_id: targetAlertId, status: nextStatus };
  });

  app.post("/internal/risk/smurf/process", async (request) => {
    const body = z.object({ limit: z.number().int().min(1).max(200).default(50) }).parse(request.body ?? {});
    const candidates = await db.query(
      `SELECT p.id, p.steam_id
       FROM players p
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [body.limit]
    );
    let processed = 0;
    for (const row of candidates.rows) {
      const steamId = String(row.steam_id);
      const latestLink = await db.query(
        `SELECT discord_id, ip_hash, device_hash
         FROM identifier_links
         WHERE steam_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [steamId]
      );
      await resolveSmurfRiskForPlayer({
        playerId: String(row.id),
        steamId,
        discordId: latestLink.rowCount ? String(latestLink.rows[0].discord_id ?? "") : null,
        ipHash: latestLink.rowCount ? String(latestLink.rows[0].ip_hash ?? "") || null : null,
        deviceHash: latestLink.rowCount ? String(latestLink.rows[0].device_hash ?? "") || null : null
      });
      processed += 1;
    }
    return { ok: true, processed };
  });

  app.post("/cases/vote", {
    preHandler: [app.authenticate],
    config: { rateLimit: RATE_LIMIT_POLICIES.casesVote }
  }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;

    const body = z
      .object({
        case_id: z.string().uuid(),
        vote: z.enum(caseVotes)
      })
      .parse(request.body);

    const existingCase = await db.query(
      "SELECT id, reported_player_id, status, match_id, demo_url FROM overwatch_cases WHERE id = $1",
      [body.case_id]
    );
    if (!existingCase.rowCount) {
      return reply.code(404).send({ error: "Case not found" });
    }
    if (existingCase.rows[0].status !== "open") {
      return reply.code(400).send({ error: "Case already resolved" });
    }

    await db.query(
      `INSERT INTO case_votes (case_id, moderator_id, vote)
       VALUES ($1, $2, $3)
       ON CONFLICT (case_id, moderator_id)
       DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()`,
      [body.case_id, request.user.playerId, body.vote]
    );

    const votes = await db.query("SELECT vote FROM case_votes WHERE case_id = $1", [body.case_id]);
    const totalVotes = votes.rowCount ?? 0;
    const cheatingVotes = votes.rows.filter((v) => v.vote === "cheating").length;
    const griefingVotes = votes.rows.filter((v) => v.vote === "griefing").length;
    const guiltyVotes = cheatingVotes + griefingVotes;
    const guiltyRatio = totalVotes > 0 ? guiltyVotes / totalVotes : 0;

    let punishmentApplied: string | null = null;
    if (guiltyRatio >= 0.7 && totalVotes > 0) {
      let punishment: "timeout_24h" | "ban_7d" | "permanent_ban";
      if (cheatingVotes >= griefingVotes) {
        punishment = "permanent_ban";
      } else if (guiltyRatio >= 0.85) {
        punishment = "ban_7d";
      } else {
        punishment = "timeout_24h";
      }
      await applyPunishment(existingCase.rows[0].reported_player_id, request.user.playerId, punishment, {
        reason: punishment === "ban_7d" ? "Griefing" : "Cheating",
        matchId: String(existingCase.rows[0].match_id),
        caseId: body.case_id,
        evidenceUrl: existingCase.rows[0].demo_url ? String(existingCase.rows[0].demo_url) : null
      });
      punishmentApplied = punishment;
      await db.query(
        `UPDATE overwatch_cases
         SET status = 'resolved', resolved_by = $1, resolution = $2
         WHERE id = $3`,
        [request.user.playerId, `guilty:${punishment}`, body.case_id]
      );

      if (punishment === "permanent_ban" && cheatingVotes >= griefingVotes) {
        await ensureConfirmedCheatingCase(body.case_id, request.user.playerId);
        await rewardReportersForCase(body.case_id, 10, 5);
      }
    }

    await createModerationLog({
      action: "overwatch_case_decision",
      playerId: String(existingCase.rows[0].reported_player_id),
      moderatorId: request.user.playerId,
      reason: `vote=${body.vote}; guilty_ratio=${guiltyRatio.toFixed(2)}; punishment=${punishmentApplied ?? "none"}`,
      matchId: String(existingCase.rows[0].match_id)
    });

    return reply.send({
      ok: true,
      case_id: body.case_id,
      total_votes: totalVotes,
      guilty_ratio: guiltyRatio,
      punishment_applied: punishmentApplied
    });
  });

  app.post("/timeout", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const body = z.object({ player_id: z.string().uuid(), hours: z.number().int().positive().default(24) }).parse(request.body);
    await db.query("UPDATE players SET banned_until = NOW() + ($2 || ' hours')::interval WHERE id = $1", [body.player_id, body.hours]);
    await db.query(
      `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
       VALUES ($1, $2, 'timeout', $3)`,
      [request.user.playerId, body.player_id, `${body.hours} hours`]
    );
    await createModerationLog({
      action: "timeout",
      playerId: body.player_id,
      moderatorId: request.user.playerId,
      reason: `${body.hours} hours`
    });
    return { ok: true };
  });

  app.post("/ban", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const body = z
      .object({
        player_id: z.string().uuid(),
        days: z.number().int().positive().optional(),
        permanent: z.boolean().optional(),
        reason: z.string().min(3).max(256).optional(),
        match_id: z.string().uuid().optional(),
        case_id: z.string().uuid().optional(),
        evidence_url: z.string().url().optional(),
        demo_timestamp_seconds: z.number().int().min(0).optional()
      })
      .parse(request.body);

    if (body.permanent) {
      await db.query("UPDATE players SET permanent_ban = TRUE, banned_until = NULL WHERE id = $1", [body.player_id]);
      await db.query(
        `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
         VALUES ($1, $2, 'ban', 'permanent')`,
        [request.user.playerId, body.player_id]
      );
      await createBanLog({
        targetPlayerId: body.player_id,
        reason: body.reason ?? "Cheating",
        matchId: body.match_id ?? null,
        caseId: body.case_id ?? null,
        evidenceUrl: body.evidence_url ?? null,
        demoTimestampSeconds: body.demo_timestamp_seconds ?? null
      });
      await createModerationLog({
        action: "ban",
        playerId: body.player_id,
        moderatorId: request.user.playerId,
        reason: body.reason ?? "Cheating",
        matchId: body.match_id ?? null
      });
    } else {
      const days = body.days ?? 7;
      await db.query("UPDATE players SET banned_until = NOW() + ($2 || ' days')::interval WHERE id = $1", [body.player_id, days]);
      await db.query(
        `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
         VALUES ($1, $2, 'ban', $3)`,
        [request.user.playerId, body.player_id, `${days} days`]
      );
      await createBanLog({
        targetPlayerId: body.player_id,
        reason: body.reason ?? "Cheating",
        matchId: body.match_id ?? null,
        caseId: body.case_id ?? null,
        evidenceUrl: body.evidence_url ?? null,
        demoTimestampSeconds: body.demo_timestamp_seconds ?? null
      });
      await createModerationLog({
        action: "ban",
        playerId: body.player_id,
        moderatorId: request.user.playerId,
        reason: body.reason ?? "Cheating",
        matchId: body.match_id ?? null
      });
    }

    return { ok: true };
  });

  app.post("/unban", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const body = z
      .object({
        player_id: z.string().uuid(),
        reason: z.string().min(3).max(256).optional()
      })
      .parse(request.body ?? {});
    await db.query("UPDATE players SET permanent_ban = FALSE, banned_until = NULL WHERE id = $1", [body.player_id]);
    await db.query(
      `INSERT INTO moderation_actions (moderator_id, target_player_id, action_type, notes)
       VALUES ($1, $2, 'unban', $3)`,
      [request.user.playerId, body.player_id, body.reason ?? "manual unban"]
    );
    await createModerationLog({
      action: "unban",
      playerId: body.player_id,
      moderatorId: request.user.playerId,
      reason: body.reason ?? "manual unban"
    });
    return { ok: true };
  });

  app.get("/creator/applications", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const result = await db.query(
      `SELECT ca.id, ca.player_id, p.steam_id, p.display_name, ca.requested_code, ca.status, ca.created_at
       FROM creator_applications ca
       JOIN players p ON p.id = ca.player_id
       WHERE ca.status = 'pending'
       ORDER BY ca.created_at ASC`
    );
    return result.rows;
  });

  app.post("/creator/approve", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const body = z
      .object({
        player_id: z.string().uuid(),
        creator_code: z.string().min(2).max(32)
      })
      .parse(request.body ?? {});

    const creatorCode = normalizeCreatorCode(body.creator_code);
    const existsCode = await db.query("SELECT id FROM players WHERE creator_code = $1 AND id <> $2", [creatorCode, body.player_id]);
    if (existsCode.rowCount) {
      return reply.code(409).send({ error: "Creator code already in use" });
    }
    await db.query(
      `UPDATE players
       SET creator_badge = TRUE, creator_code = $2
       WHERE id = $1`,
      [body.player_id, creatorCode]
    );
    await db.query(
      `INSERT INTO creator_stats (creator_id, creator_referrals, creator_matches, creator_views, updated_at)
       VALUES ($1, 0, 0, 0, NOW())
       ON CONFLICT (creator_id) DO NOTHING`,
      [body.player_id]
    );
    await db.query(
      `UPDATE creator_applications
       SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
       WHERE player_id = $1`,
      [body.player_id, request.user.playerId]
    );
    await db.query(
      `INSERT INTO player_rewards (player_id, reward_code, reward_type, unlock_reason)
       VALUES ($1, 'creator_exclusive_pack', 'exclusive_skins', 'Creator program approval')
       ON CONFLICT (player_id, reward_code) DO NOTHING`,
      [body.player_id]
    );
    await db.query(
      `INSERT INTO player_skins (player_id, weapon, skin_id, updated_at)
       VALUES ($1, 'ak47', 'creator_ember', NOW())
       ON CONFLICT (player_id, weapon)
       DO UPDATE SET skin_id = EXCLUDED.skin_id, updated_at = NOW()`,
      [body.player_id]
    );

    return { ok: true, player_id: body.player_id, creator_code: creatorCode };
  });

  app.get("/leaderboard/hunters", async () => {
    const result = await db.query(
      `SELECT id, display_name, player_rank, reputation_points, bounty_score
       FROM players
       WHERE bounty_score > 0 OR reputation_points > 0
       ORDER BY bounty_score DESC, reputation_points DESC, display_name ASC
       LIMIT 100`
    );

    return result.rows.map((row, index) => ({
      position: index + 1,
      player_id: row.id,
      display_name: row.display_name,
      player_rank: row.player_rank,
      reputation_points: row.reputation_points,
      bounty_score: row.bounty_score
    }));
  });

  app.get("/leaderboard/creators", async () => {
    const result = await db.query(
      `SELECT
         p.id AS creator_id,
         p.display_name,
         p.creator_code,
         p.player_rank,
         cs.creator_referrals,
         cs.creator_matches,
         cs.creator_views
       FROM creator_stats cs
       JOIN players p ON p.id = cs.creator_id
       WHERE p.creator_badge = TRUE
       ORDER BY cs.creator_referrals DESC, cs.creator_matches DESC, cs.creator_views DESC
       LIMIT 100`
    );
    return result.rows.map((row, idx) => ({
      position: idx + 1,
      creator_id: row.creator_id,
      display_name: row.display_name,
      creator_code: row.creator_code,
      player_rank: row.player_rank,
      creator_referrals: Number(row.creator_referrals ?? 0),
      creator_matches: Number(row.creator_matches ?? 0),
      creator_views: Number(row.creator_views ?? 0)
    }));
  });

  app.post("/reward", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;

    const body = z
      .object({
        case_id: z.string().uuid(),
        reputation_points: z.number().int().positive().default(10),
        bounty_score: z.number().int().positive().default(5)
      })
      .parse(request.body ?? {});

    let rewardedCount = 0;
    try {
      rewardedCount = await rewardReportersForCase(body.case_id, body.reputation_points, body.bounty_score);
    } catch (error: any) {
      return reply.code(400).send({ error: String(error?.message ?? error) });
    }
    return {
      ok: true,
      case_id: body.case_id,
      rewarded_reporters: rewardedCount,
      reputation_points: body.reputation_points,
      bounty_score: body.bounty_score
    };
  });

  app.post("/moderation/timeout", { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ playerId: z.string().uuid(), minutes: z.number().int().positive() }).parse(request.body);
    const hours = Math.max(1, Math.ceil(body.minutes / 60));
    const response = await app.inject({
      method: "POST",
      url: "/timeout",
      headers: { authorization: request.headers.authorization ?? "" },
      payload: { player_id: body.playerId, hours }
    });
    return reply.code(response.statusCode).send(JSON.parse(response.body));
  });

  app.post("/moderation/ban", { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = z.object({ playerId: z.string().uuid(), reason: z.string().min(3).max(300) }).parse(request.body);
    const response = await app.inject({
      method: "POST",
      url: "/ban",
      headers: { authorization: request.headers.authorization ?? "" },
      payload: { player_id: body.playerId, days: 7, permanent: false }
    });
    return reply.code(response.statusCode).send(JSON.parse(response.body));
  });

  app.get("/moderation/logs", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!(await assertModerator(request, reply))) return;
    const query = z
      .object({
        steam_id: z.string().min(3).max(64).optional(),
        player_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20)
      })
      .parse(request.query ?? {});

    let playerId = query.player_id ?? null;
    if (!playerId && query.steam_id) {
      const player = await db.query("SELECT id FROM players WHERE steam_id = $1", [query.steam_id]);
      playerId = player.rowCount ? String(player.rows[0].id) : null;
    }

    const rows = playerId
      ? await db.query(
          `SELECT
             ml.log_id, ml.action, ml.reason, ml.match_id, ml.timestamp,
             ml.player_id, ml.moderator_id,
             p.steam_id AS player_steam_id, p.display_name AS player_name,
             m.steam_id AS moderator_steam_id, m.display_name AS moderator_name
           FROM moderation_logs ml
           LEFT JOIN players p ON p.id = ml.player_id
           LEFT JOIN players m ON m.id = ml.moderator_id
           WHERE ml.player_id = $1
           ORDER BY ml.timestamp DESC
           LIMIT $2`,
          [playerId, query.limit]
        )
      : await db.query(
          `SELECT
             ml.log_id, ml.action, ml.reason, ml.match_id, ml.timestamp,
             ml.player_id, ml.moderator_id,
             p.steam_id AS player_steam_id, p.display_name AS player_name,
             m.steam_id AS moderator_steam_id, m.display_name AS moderator_name
           FROM moderation_logs ml
           LEFT JOIN players p ON p.id = ml.player_id
           LEFT JOIN players m ON m.id = ml.moderator_id
           ORDER BY ml.timestamp DESC
           LIMIT $1`,
          [query.limit]
        );

    return { logs: rows.rows };
  });

  app.post("/internal/matches/:id/live", async (request) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  await db.query(
    `UPDATE matches
     SET status = 'live',
         started_at = COALESCE(started_at, NOW()),
         interrupted_at = NULL,
         recovery_deadline_at = NULL
     WHERE id = $1`,
    [params.id]
  );
  return { ok: true };
  });

  app.get("/internal/match/verify-player", async (request, reply) => {
  const query = z
    .object({
      match_id: z.string().uuid(),
      steam_id: z.string().min(3).max(64)
    })
    .parse(request.query ?? {});

  const match = await db.query(
    `SELECT id, status
     FROM matches
     WHERE id = $1`,
    [query.match_id]
  );
  if (!match.rowCount) {
    return reply.code(404).send({ allowed: false, reason: "match_not_found" });
  }

  const status = String(match.rows[0].status ?? "");
  if (status !== "live" && status !== "interrupted" && status !== "pending_vote" && status !== "pending") {
    return {
      allowed: false,
      reason: "match_not_active"
    };
  }

  const roster = await db.query(
    `SELECT mp.team, mp.slot, p.id AS player_id, p.steam_id, u.username
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     LEFT JOIN users u ON u.steam_id = p.steam_id
     WHERE mp.match_id = $1
       AND p.steam_id = $2
     LIMIT 1`,
    [query.match_id, query.steam_id]
  );
  if (!roster.rowCount) {
    return {
      allowed: false,
      reason: "steam_not_in_roster"
    };
  }

  const teamRaw = String(roster.rows[0].team ?? "");
  const mappedTeam = teamRaw === "A" ? "team1" : teamRaw === "B" ? "team2" : teamRaw;
  const identity = await getPlayerIdentityBySteamId(String(roster.rows[0].steam_id));

  return {
    allowed: true,
    team: mappedTeam,
    slot: Number(roster.rows[0].slot ?? 0),
    player_id: String(roster.rows[0].player_id),
    steam_id: String(roster.rows[0].steam_id),
    username: identity?.username ?? (roster.rows[0].username ? String(roster.rows[0].username) : null),
    clan_tag: identity?.clan_tag ?? null,
    display_name: identity?.display_name ?? null
  };
  });

  app.post("/internal/matches/:id/state", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      team_a_score: z.number().int().min(0).optional(),
      team_b_score: z.number().int().min(0).optional(),
      round_number: z.number().int().min(0).optional()
    })
    .parse(request.body ?? {});
  const updated = await db.query(
    `UPDATE matches
     SET team_a_score = COALESCE($2, team_a_score),
         team_b_score = COALESCE($3, team_b_score),
         round_number = COALESCE($4, round_number)
     WHERE id = $1
     RETURNING id`,
    [params.id, body.team_a_score ?? null, body.team_b_score ?? null, body.round_number ?? null]
  );
  if (!updated.rowCount) {
    return reply.code(404).send({ error: "Match not found" });
  }
  return { ok: true, match_id: params.id };
  });

  app.post("/internal/matches/:id/interrupted", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      reason: z.string().min(3).max(500).optional()
    })
    .parse(request.body ?? {});

  const updated = await db.query(
    `UPDATE matches
     SET status = 'interrupted',
         interrupted_at = NOW(),
         recovery_deadline_at = NOW() + INTERVAL '3 minutes'
     WHERE id = $1
     RETURNING id, map, server_ip, server_port, server_password, team_a_score, team_b_score, round_number, recovery_deadline_at`,
    [params.id]
  );
  if (!updated.rowCount) {
    return reply.code(404).send({ error: "Match not found" });
  }

  const match = updated.rows[0];
  await redis.publish(
    "match-events",
    JSON.stringify({
      type: "match_recovery_started",
      matchId: params.id,
      map: match.map,
      score: `${match.team_a_score ?? 0}-${match.team_b_score ?? 0}`,
      round: Number(match.round_number ?? 0),
      reason: body.reason ?? "Server crash detected",
      reconnect_window_seconds: 180
    })
  );
  return {
    ok: true,
    match_id: params.id,
    recovery_deadline_at: match.recovery_deadline_at
  };
  });

  app.post("/internal/matches/:id/cancel-recovery", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      reason: z.string().min(3).max(500).optional()
    })
    .parse(request.body ?? {});

  const match = await db.query("SELECT id, mode FROM matches WHERE id = $1", [params.id]);
  if (!match.rowCount) {
    return reply.code(404).send({ error: "Match not found" });
  }

  const snapshots = await db.query(
    `SELECT player_id, mmr_before, wingman_mmr_before
     FROM match_mmr_snapshots
     WHERE match_id = $1`,
    [params.id]
  );
  const mode = String(match.rows[0].mode ?? "ranked");
  for (const snap of snapshots.rows) {
    if (mode === "wingman") {
      await db.query("UPDATE players SET wingman_mmr = $2 WHERE id = $1", [snap.player_id, snap.wingman_mmr_before]);
    } else if (mode === "ranked") {
      await db.query("UPDATE players SET mmr = $2 WHERE id = $1", [snap.player_id, snap.mmr_before]);
    }
  }

  await db.query(
    `UPDATE matches
     SET status = 'canceled',
         ended_at = NOW(),
         recovery_deadline_at = NULL
     WHERE id = $1`,
    [params.id]
  );
  await redis.publish(
    "match-events",
    JSON.stringify({
      type: "match_recovery_failed",
      matchId: params.id,
      reason: body.reason ?? "Recovery timeout exceeded",
      mmr_restored: true
    })
  );
  return { ok: true, match_id: params.id };
  });

  app.get("/internal/matches/:id/recovery", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const match = await db.query(
    `SELECT id, map, mode, status, server_id, server_ip, server_port, server_password, spectator_password, connect_string,
            team_a_score, team_b_score, round_number, recovery_deadline_at
     FROM matches
     WHERE id = $1`,
    [params.id]
  );
  if (!match.rowCount) {
    return reply.code(404).send({ error: "Match not found" });
  }

  const players = await db.query(
    `SELECT mp.team, p.id, p.steam_id, p.display_name
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = $1
     ORDER BY mp.team, p.display_name`,
    [params.id]
  );

  const row = match.rows[0];
  return {
    match_id: row.id,
    map: row.map,
    mode: row.mode ?? "ranked",
    status: row.status,
    score_team_a: Number(row.team_a_score ?? 0),
    score_team_b: Number(row.team_b_score ?? 0),
    round: Number(row.round_number ?? 0),
    recovery_deadline_at: row.recovery_deadline_at ?? null,
    server: {
      serverId: row.server_id,
      ip: row.server_ip,
      port: row.server_port,
      serverPassword: row.server_password,
      spectatorPassword: row.spectator_password,
      connectString: row.connect_string
    },
    players: players.rows
  };
  });

  app.post("/internal/matches/:id/end", async (request) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      demoUrl: z.string().url().optional(),
      teamAScore: z.number().int().min(0).optional(),
      teamBScore: z.number().int().min(0).optional(),
      results: z
        .array(
          z.object({
            player_id: z.string().uuid(),
            result: z.enum(["win", "loss"]),
            adr: z.number().min(0),
            mvps: z.number().int().min(0),
            kd: z.number().min(0),
            headshot_rate: z.number().min(0).max(100).optional(),
            reaction_time: z.number().positive().optional(),
            wallbang_kills: z.number().int().min(0).optional(),
            prefire_kills: z.number().int().min(0).optional(),
            preaim_kills: z.number().int().min(0).optional(),
            reports_received: z.number().int().min(0).optional()
          })
        )
        .optional()
    })
    .parse(request.body ?? {});
  const updated = await db.query(
    `UPDATE matches
     SET status = 'finished',
         ended_at = NOW(),
         demo_url = COALESCE($2, demo_url),
         team_a_score = COALESCE($3, team_a_score),
         team_b_score = COALESCE($4, team_b_score)
     WHERE id = $1
     RETURNING team_a_score, team_b_score`,
    [params.id, body.demoUrl ?? null, body.teamAScore ?? null, body.teamBScore ?? null]
  );
  const finalScore = `${updated.rows[0]?.team_a_score ?? 0}-${updated.rows[0]?.team_b_score ?? 0}`;
  await redis.publish(
    "match-events",
    JSON.stringify({ type: "match_finished", matchId: params.id, demoUrl: body.demoUrl ?? null, finalScore })
  );
  eventLogger.info("match_end", {
    match_id: params.id,
    final_score: finalScore,
    demo_url: body.demoUrl ?? null
  });
  const participants = await db.query(
    `SELECT DISTINCT p.steam_id, sl.discord_id
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     LEFT JOIN steam_links sl ON sl.steam_id = p.steam_id
     WHERE mp.match_id = $1`,
    [params.id]
  );
  for (const row of participants.rows) {
    await db.query(
      `INSERT INTO player_boxes (steam_id, box_type, date_received, opened)
       VALUES ($1, 'fragbox', NOW(), FALSE)`,
      [String(row.steam_id)]
    );
  }
  const matchModeRow = await db.query("SELECT mode FROM matches WHERE id = $1", [params.id]);
  const matchMode = String(matchModeRow.rows[0]?.mode ?? "ranked");
  const creatorsInMatch = await db.query(
    `SELECT DISTINCT mp.player_id, p.steam_id, p.display_name, sl.discord_id
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     LEFT JOIN steam_links sl ON sl.steam_id = p.steam_id
     WHERE mp.match_id = $1
       AND p.creator_badge = TRUE`,
    [params.id]
  );
  const isCreatorMatch = creatorsInMatch.rows.length > 0;
  if (isCreatorMatch) {
    const primaryCreator = creatorsInMatch.rows[0];
    await db.query(
      `UPDATE matches
       SET creator_match = TRUE,
           creator_player_id = $2
       WHERE id = $1`,
      [params.id, primaryCreator.player_id]
    );
  }
  for (const row of creatorsInMatch.rows) {
    await db.query(
      `UPDATE creator_stats
       SET creator_matches = creator_matches + 1, updated_at = NOW()
       WHERE creator_id = $1`,
      [row.player_id]
    );
    await db.query(
      `INSERT INTO creator_matches (steam_id, discord_id, reward_type, date, match_id)
       VALUES ($1, $2, 'creator_match', NOW(), $3)`,
      [String(row.steam_id), row.discord_id ? String(row.discord_id) : null, params.id]
    );
    const updatedCreatorStats = await db.query(
      `SELECT creator_matches
       FROM creator_stats
       WHERE creator_id = $1`,
      [row.player_id]
    );
    const streamedMatches = Number(updatedCreatorStats.rows[0]?.creator_matches ?? 0);
    const milestoneRewards: Array<{ threshold: number; reward_type: string; box_type: string }> = [
      { threshold: 10, reward_type: "creatorbox_milestone_10", box_type: "creatorbox" },
      { threshold: 25, reward_type: "elite_creatorbox_milestone_25", box_type: "elite_creatorbox" },
      { threshold: 100, reward_type: "legendary_creatorbox_milestone_100", box_type: "legendary_creatorbox" }
    ];
    for (const milestone of milestoneRewards) {
      if (streamedMatches >= milestone.threshold) {
        const existsMilestone = await db.query(
          `SELECT id
           FROM creator_boxes
           WHERE steam_id = $1
             AND reward_type = $2
           LIMIT 1`,
          [String(row.steam_id), milestone.reward_type]
        );
        if (!existsMilestone.rowCount) {
          await db.query(
            `INSERT INTO creator_boxes (steam_id, discord_id, reward_type, date, match_id)
             VALUES ($1, $2, $3, NOW(), $4)`,
            [
              String(row.steam_id),
              row.discord_id ? String(row.discord_id) : null,
              milestone.reward_type,
              params.id
            ]
          );
          await db.query(
            `INSERT INTO player_boxes (steam_id, box_type, date_received, opened)
             VALUES ($1, $2, NOW(), FALSE)`,
            [String(row.steam_id), milestone.box_type]
          );
        }
      }
    }
  }
  if (isCreatorMatch) {
    const creatorMatchDropChance = Math.min(1, Math.max(0, creatorBoxBaseDropChance + creatorMatchBonusDropChance));
    for (const participant of participants.rows) {
      if (Math.random() <= creatorMatchDropChance) {
        await db.query(
          `INSERT INTO player_boxes (steam_id, box_type, date_received, opened)
           VALUES ($1, 'creatorbox', NOW(), FALSE)`,
          [String(participant.steam_id)]
        );
        await db.query(
          `INSERT INTO creator_boxes (steam_id, discord_id, reward_type, date, match_id)
           VALUES ($1, $2, 'creator_match_drop', NOW(), $3)`,
          [
            String(participant.steam_id),
            participant.discord_id ? String(participant.discord_id) : null,
            params.id
          ]
        );
      }
    }
  }
  if (body.results && body.results.length > 0 && matchMode === "ranked") {
    await app.inject({
      method: "POST",
      url: "/internal/ranking/apply",
      headers: { "x-internal-token": internalApiToken },
      payload: { match_id: params.id, results: body.results }
    });
  }
  if (body.results && body.results.length > 0 && matchMode === "wingman") {
    await app.inject({
      method: "POST",
      url: "/internal/ranking/apply-wingman",
      headers: { "x-internal-token": internalApiToken },
      payload: { match_id: params.id, results: body.results }
    });
  }
  if (body.results && body.results.length > 0 && (matchMode === "ranked" || matchMode === "wingman")) {
    await applySeasonProgressForMatch(
      params.id,
      body.results.map((entry: any) => ({
        player_id: String(entry.player_id),
        result: entry.result,
        mvps: Number(entry.mvps ?? 0)
      }))
    );
  }
  let clanWar: any = null;
  if (matchMode === "clanwars") {
    const teamAScore = Number(updated.rows[0]?.team_a_score ?? body.teamAScore ?? 0);
    const teamBScore = Number(updated.rows[0]?.team_b_score ?? body.teamBScore ?? 0);
    clanWar = await applyClanWarResult({
      matchId: params.id,
      teamAScore,
      teamBScore
    });
    if (clanWar?.updated) {
      await redis.publish(
        "match-events",
        JSON.stringify({
          type: "clan_war_result",
          matchId: params.id,
          team_a_score: teamAScore,
          team_b_score: teamBScore,
          clan_a_tag: clanWar.clan_a_tag,
          clan_b_tag: clanWar.clan_b_tag,
          winner_clan_id: clanWar.winner_clan_id
        })
      );
    }
  }
  if (body.results && body.results.length > 0) {
    await applyBattlepassProgressForMatch(
      body.results.map((entry: any) => ({
        player_id: String(entry.player_id),
        result: entry.result,
        mvps: Number(entry.mvps ?? 0)
      }))
    );
  }
  let antiCheat: any[] = [];
  if (body.results && body.results.length > 0) {
    const reports = await db.query(
      `SELECT reported_player_id, COUNT(*)::int AS reports_received
       FROM reports
       WHERE match_id = $1
       GROUP BY reported_player_id`,
      [params.id]
    );
    const reportsByPlayer = new Map<string, number>(
      reports.rows.map((row) => [String(row.reported_player_id), Number(row.reports_received ?? 0)])
    );

    antiCheat = await Promise.all(
      body.results.map((entry: any) =>
        analyzeCheating({
          player_id: entry.player_id,
          match_id: params.id,
          metrics: {
            headshot_rate: entry.headshot_rate ?? 0,
            reaction_time: entry.reaction_time ?? 250,
            wallbang_kills: entry.wallbang_kills ?? 0,
            prefire_kills: entry.prefire_kills ?? entry.preaim_kills ?? 0,
            adr: entry.adr,
            kd: entry.kd,
            reports_received: entry.reports_received ?? reportsByPlayer.get(entry.player_id) ?? 0
          }
        })
      )
    );
  }
  return {
    ok: true,
    anti_cheat: antiCheat,
    fragboxes_granted: participants.rows.length,
    creator_match: isCreatorMatch,
    clan_war: clanWar
  };
  });

  app.post("/internal/ranking/apply", async (request, reply) => {
  const body = z
    .object({
      match_id: z.string().uuid().optional(),
      results: z.array(
        z.object({
          player_id: z.string().uuid(),
          result: z.enum(["win", "loss"]),
          adr: z.number().min(0),
          mvps: z.number().int().min(0),
          kd: z.number().min(0)
        })
      )
    })
    .parse(request.body);

  const updates: Array<{
    player_id: string;
    rank: string;
    mmr_delta: number;
    win_streak: number;
  }> = [];

  for (const entry of body.results) {
    const current = await db.query("SELECT mmr, win_streak, player_rank FROM players WHERE id = $1", [entry.player_id]);
    if (!current.rowCount) {
      return reply.code(404).send({ error: `Player not found: ${entry.player_id}` });
    }

    const currentMmr = Number(current.rows[0].mmr ?? STARTING_MMR);
    const currentStreak = Number(current.rows[0].win_streak ?? 0);
    const previousRank = String(current.rows[0].player_rank ?? rankFromMmr(currentMmr));
    const rating = applyMatchResult({
      state: { mmr: currentMmr, winStreak: currentStreak },
      result: entry.result,
      performance: { adr: entry.adr, mvps: entry.mvps, kd: entry.kd }
    });
    const rank = rankFromMmr(rating.mmrAfter);

    await db.query(
      `UPDATE players
       SET mmr = $2, player_rank = $3, win_streak = $4, elo = $2
       WHERE id = $1`,
      [entry.player_id, rating.mmrAfter, rank, rating.streakAfter]
    );
    await db.query(
      `INSERT INTO player_stats (player_id, wins, losses, matches_played, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (player_id)
       DO UPDATE SET
         wins = player_stats.wins + EXCLUDED.wins,
         losses = player_stats.losses + EXCLUDED.losses,
         matches_played = player_stats.matches_played + 1,
         updated_at = NOW()`,
      [entry.player_id, entry.result === "win" ? 1 : 0, entry.result === "loss" ? 1 : 0]
    );

    await db.query(
      `INSERT INTO rank_history (player_id, match_id, previous_rank, new_rank, mmr_delta)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.player_id, body.match_id ?? null, previousRank, rank, rating.mmrDelta]
    );

    updates.push({
      player_id: entry.player_id,
      rank,
      mmr_delta: rating.mmrDelta,
      win_streak: rating.streakAfter
    });
  }

  return { ok: true, updates };
  });

  app.post("/internal/ranking/apply-wingman", async (request, reply) => {
  const body = z
    .object({
      match_id: z.string().uuid().optional(),
      results: z.array(
        z.object({
          player_id: z.string().uuid(),
          result: z.enum(["win", "loss"]),
          adr: z.number().min(0),
          mvps: z.number().int().min(0),
          kd: z.number().min(0)
        })
      )
    })
    .parse(request.body);

  const updates: Array<{ player_id: string; wingman_rank: string; wingman_mmr_delta: number }> = [];

  for (const entry of body.results) {
    const current = await db.query("SELECT wingman_mmr, wingman_rank FROM players WHERE id = $1", [entry.player_id]);
    if (!current.rowCount) {
      return reply.code(404).send({ error: `Player not found: ${entry.player_id}` });
    }
    const beforeMmr = Number(current.rows[0].wingman_mmr ?? 1000);
    const delta = entry.result === "win" ? 25 : -25;
    const afterMmr = Math.max(0, beforeMmr + delta);
    const rank = rankFromMmr(afterMmr);
    await db.query(
      `UPDATE players
       SET wingman_mmr = $2, wingman_rank = $3
       WHERE id = $1`,
      [entry.player_id, afterMmr, rank]
    );
    updates.push({ player_id: entry.player_id, wingman_rank: rank, wingman_mmr_delta: delta });
  }

  return { ok: true, updates };
  });

  app.post("/internal/progression/match", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      player_id: z.string().uuid(),
      match_id: z.string().uuid(),
      result: z.enum(["win", "loss"]),
      mvps: z.number().int().min(0).default(0)
    })
    .parse(request.body ?? {});

  const applied = await db.query(
    `SELECT *
     FROM apply_match_progression($1::uuid, $2::uuid, $3::boolean, $4::integer)`,
    [body.player_id, body.match_id, body.result === "win", body.mvps]
  );
  if (!applied.rowCount) {
    return reply.code(404).send({ error: "Player not found" });
  }

  return {
    ok: true,
    progression: applied.rows[0]
  };
  });

  app.post("/internal/progression/trust", async (request, reply) => {
  if (botApiToken) {
    const token = String(request.headers["x-bot-token"] ?? "");
    if (token !== botApiToken) {
      return reply.code(401).send({ error: "Unauthorized bot token" });
    }
  }

  const body = z
    .object({
      player_id: z.string().uuid(),
      event_type: z.enum(["commendation", "accurate_report", "toxic_report", "confirmed_cheating"]),
      count: z.number().int().min(1).default(1),
      match_id: z.string().uuid().optional()
    })
    .parse(request.body ?? {});

  const applied = await db.query(
    `SELECT *
     FROM apply_trust_score_event($1::uuid, $2::text, $3::integer, $4::uuid)`,
    [body.player_id, body.event_type, body.count, body.match_id ?? null]
  );
  if (!applied.rowCount) {
    return reply.code(404).send({ error: "Player not found" });
  }

  return {
    ok: true,
    trust: applied.rows[0]
  };
  });

  app.post("/internal/matches/reserve", async (request, reply) => {
  const body = z
    .object({
      match_id: z.string().uuid(),
      mode: z.enum(queueModes).default("ranked"),
      teamA: z
        .array(
          z.object({
            player_id: z.string().uuid(),
            elo: z.number().int(),
            region: z.string(),
            timestamp: z.string()
          })
        ),
      teamB: z
        .array(
          z.object({
            player_id: z.string().uuid(),
            elo: z.number().int(),
            region: z.string(),
            timestamp: z.string()
          })
        )
    })
    .parse(request.body);

  const mode = body.mode as QueueMode;
  const cfg = modeConfig[mode];
  if (body.teamA.length !== cfg.teamSize || body.teamB.length !== cfg.teamSize) {
    return reply.code(400).send({
      error: `Invalid team sizes for mode ${mode}. Expected ${cfg.teamSize} per team.`
    });
  }

  const exists = await db.query("SELECT id FROM matches WHERE id = $1", [body.match_id]);
  if (!exists.rowCount) {
    await db.query(
      `INSERT INTO matches (id, map, team_a, team_b, status, mode, unranked)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 'pending_vote', $5, $6)`,
      [body.match_id, MAP_POOL[0], JSON.stringify(body.teamA), JSON.stringify(body.teamB), mode, cfg.unranked]
    );
    eventLogger.info("match_creation", {
      match_id: body.match_id,
      mode,
      source: "reserve",
      status: "pending_vote",
      team_a_size: body.teamA.length,
      team_b_size: body.teamB.length
    });
  }

  for (let i = 0; i < body.teamA.length; i += 1) {
    const player = body.teamA[i];
    await db.query(
      `INSERT INTO match_players (match_id, player_id, team, slot)
       VALUES ($1, $2, 'A', $3)
       ON CONFLICT (match_id, player_id)
       DO UPDATE SET team = EXCLUDED.team, slot = EXCLUDED.slot`,
      [body.match_id, player.player_id, i + 1]
    );
  }
  for (let i = 0; i < body.teamB.length; i += 1) {
    const player = body.teamB[i];
    await db.query(
      `INSERT INTO match_players (match_id, player_id, team, slot)
       VALUES ($1, $2, 'B', $3)
       ON CONFLICT (match_id, player_id)
       DO UPDATE SET team = EXCLUDED.team, slot = EXCLUDED.slot`,
      [body.match_id, player.player_id, i + 1]
    );
  }

  const creatorInMatch = await db.query(
    `SELECT p.id, p.display_name, p.steam_id
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = $1
       AND p.creator_badge = TRUE
     ORDER BY p.id
     LIMIT 1`,
    [body.match_id]
  );
  if (creatorInMatch.rowCount) {
    await db.query(
      `UPDATE matches
       SET creator_match = TRUE,
           creator_player_id = $2
       WHERE id = $1`,
      [body.match_id, creatorInMatch.rows[0].id]
    );
  }

  return { ok: true, match_id: body.match_id };
  });

  app.post("/internal/matches/:id/creator-stream", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      stream_url: z.string().url(),
      creator_player_id: z.string().uuid().optional()
    })
    .parse(request.body ?? {});

  const updated = await db.query(
    `UPDATE matches
     SET creator_match = TRUE,
         creator_player_id = COALESCE($3::uuid, creator_player_id),
         creator_stream_url = $2
     WHERE id = $1
     RETURNING id`,
    [params.id, body.stream_url, body.creator_player_id ?? null]
  );
  if (!updated.rowCount) {
    return reply.code(404).send({ error: "Match not found" });
  }
  return { ok: true, match_id: params.id, stream_url: body.stream_url };
  });

  app.post("/internal/matches/activate", async (request, reply) => {
  const body = z
    .object({
      match_id: z.string().uuid(),
      map: z.string(),
      server: z.object({
        serverId: z.string(),
        ip: z.string(),
        port: z.number().int(),
        serverPassword: z.string(),
        spectatorPassword: z.string(),
        connectString: z.string()
      })
    })
    .parse(request.body);

  const previous = await db.query("SELECT status, mode, creator_match, creator_player_id, creator_stream_url FROM matches WHERE id = $1", [body.match_id]);
  if (!previous.rowCount) {
    return reply.code(404).send({ error: "Reserved match not found" });
  }
  const previousStatus = String(previous.rows[0].status ?? "pending");
  await db.query(
    `INSERT INTO match_mmr_snapshots (match_id, player_id, mmr_before, wingman_mmr_before, captured_at)
     SELECT mp.match_id, mp.player_id, COALESCE(p.mmr, 1000), COALESCE(p.wingman_mmr, 1000), NOW()
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = $1
     ON CONFLICT (match_id, player_id) DO NOTHING`,
    [body.match_id]
  );

  const updated = await db.query(
    `UPDATE matches
     SET map = $2,
         status = 'live',
         started_at = COALESCE(started_at, NOW()),
         interrupted_at = NULL,
         recovery_deadline_at = NULL,
         server_id = $3,
         server_ip = $4,
         server_port = $5,
         server_password = $6,
         spectator_password = $7,
         connect_string = $8
     WHERE id = $1
     RETURNING *`,
    [
      body.match_id,
      body.map,
      body.server.serverId,
      body.server.ip,
      body.server.port,
      body.server.serverPassword,
      body.server.spectatorPassword,
      body.server.connectString
    ]
  );

  if (!updated.rowCount) {
    return reply.code(404).send({ error: "Reserved match not found" });
  }

  let match = updated.rows[0];
  let creatorInfo: { player_id: string; steam_id: string; display_name: string; discord_id: string | null } | null = null;
  if (match.creator_match || match.creator_player_id) {
    const creatorRow = await db.query(
      `SELECT p.id AS player_id, p.steam_id, p.display_name, sl.discord_id
       FROM players p
       LEFT JOIN steam_links sl ON sl.steam_id = p.steam_id
       WHERE p.id = COALESCE($2::uuid, p.id)
         AND p.creator_badge = TRUE
         AND EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = $1 AND mp.player_id = p.id)
       ORDER BY p.id
       LIMIT 1`,
      [body.match_id, match.creator_player_id ?? null]
    );
    if (creatorRow.rowCount) {
      creatorInfo = {
        player_id: String(creatorRow.rows[0].player_id),
        steam_id: String(creatorRow.rows[0].steam_id),
        display_name: String(creatorRow.rows[0].display_name),
        discord_id: creatorRow.rows[0].discord_id ? String(creatorRow.rows[0].discord_id) : null
      };
      await db.query(
        `UPDATE matches
         SET creator_match = TRUE,
             creator_player_id = $2
         WHERE id = $1`,
        [body.match_id, creatorInfo.player_id]
      );
      match = { ...match, creator_match: true, creator_player_id: creatorInfo.player_id };
    }
  }
  const eventType = previousStatus === "interrupted" ? "match_recovered" : "match_started";
  await redis.publish(
    "match-events",
    JSON.stringify({
      type: eventType,
      matchId: match.id,
      mode: match.mode ?? "ranked",
      map: match.map,
      creator_match: Boolean(match.creator_match),
      creator: creatorInfo,
      creator_stream_url: match.creator_stream_url ?? null,
      team_a_score: Number(match.team_a_score ?? 0),
      team_b_score: Number(match.team_b_score ?? 0),
      round: Number(match.round_number ?? 0),
      connection_data: {
        server_ip: match.server_ip,
        port: match.server_port,
        server_password: match.server_password,
        spectator_password: match.spectator_password
      },
      spectate: `connect ${match.server_ip}:${match.server_port}; password ${match.spectator_password}`
    })
  );
  eventLogger.info("match_start", {
    match_id: match.id,
    mode: match.mode ?? "ranked",
    map: match.map,
    server_id: match.server_id,
    server_ip: match.server_ip,
    port: match.server_port
  });

  return {
    match_id: match.id,
    map: match.map,
    server_id: match.server_id,
    server_ip: match.server_ip,
    port: match.server_port,
    server_password: match.server_password,
    spectator_password: match.spectator_password
  };
  });

  app.post("/internal/matches/create", async (request) => {
  const body = z
    .object({
      match_id: z.string().uuid().optional(),
      mode: z.enum(queueModes).default("ranked"),
      teamA: z
        .array(
          z.object({
            player_id: z.string().uuid(),
            elo: z.number().int(),
            region: z.string(),
            timestamp: z.string()
          })
        ),
      teamB: z
        .array(
          z.object({
            player_id: z.string().uuid(),
            elo: z.number().int(),
            region: z.string(),
            timestamp: z.string()
          })
        ),
      map: z.string().optional(),
      server: z.object({
        serverId: z.string(),
        ip: z.string(),
        port: z.number().int(),
        serverPassword: z.string(),
        spectatorPassword: z.string(),
        connectString: z.string()
      })
    })
    .parse(request.body);

  const selectedMap = body.map ?? MAP_POOL[Math.floor(Math.random() * MAP_POOL.length)];
  const mode = body.mode as QueueMode;
  const cfg = modeConfig[mode];
  if (body.teamA.length !== cfg.teamSize || body.teamB.length !== cfg.teamSize) {
    return { error: `Invalid team sizes for mode ${mode}. Expected ${cfg.teamSize} per team.` };
  }
  const matchId = body.match_id ?? null;
  const inserted = await db.query(
    `INSERT INTO matches (id, server_id, map, team_a, team_b, status, server_ip, server_port, server_password, spectator_password, connect_string, mode, unranked)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5::jsonb, 'live', $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      matchId,
      body.server.serverId,
      selectedMap,
      JSON.stringify(body.teamA),
      JSON.stringify(body.teamB),
      body.server.ip,
      body.server.port,
      body.server.serverPassword,
      body.server.spectatorPassword,
      body.server.connectString,
      mode,
      cfg.unranked
    ]
  );

  const match = inserted.rows[0];

  for (const player of body.teamA) {
    await db.query("INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, 'A')", [match.id, player.player_id]);
  }
  for (const player of body.teamB) {
    await db.query("INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, 'B')", [match.id, player.player_id]);
  }

  await redis.publish("match-events", JSON.stringify({ type: "match_created", matchId: match.id }));
  eventLogger.info("match_creation", {
    match_id: match.id,
    mode,
    source: "internal_create",
    map: match.map,
    server_id: match.server_id,
    server_ip: match.server_ip,
    port: match.server_port
  });
  return {
    match_id: match.id,
    server_id: match.server_id,
    map: match.map,
    team_a: match.team_a,
    team_b: match.team_b,
    status: match.status,
    server_ip: match.server_ip,
    port: match.server_port,
    server_password: match.server_password,
    spectator_password: match.spectator_password
  };
  });

  return app;
}

const port = Number(process.env.API_PORT ?? 3001);
buildServer()
  .then((app) => app.listen({ port, host: "0.0.0.0" }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
