import {
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  GuildMember,
  EmbedBuilder,
  IntentsBitField,
  PermissionFlagsBits,
  TextChannel,
  VoiceChannel,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction
} from "discord.js";
import crypto from "node:crypto";
import http from "node:http";
import Redis from "ioredis";
import { createServiceLogger } from "@csgofaceit/logger";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://api:3001";
const publicApiUrl = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? "https://api.play.maro.run";
const serverManagerBaseUrl = process.env.SERVER_MANAGER_BASE_URL ?? "http://server-manager:3003";
const liveMatchesChannelId = process.env.DISCORD_CHANNEL_LIVE_MATCHES ?? "";
const queueChannelId = process.env.DISCORD_CHANNEL_QUEUE ?? "";
const overwatchChannelId = process.env.DISCORD_CHANNEL_OVERWATCH ?? "";
const serverStatusChannelId = process.env.DISCORD_CHANNEL_SERVER_STATUS ?? "";
const mapVoteChannelId = process.env.DISCORD_CHANNEL_MAP_VOTE ?? "";
const announcementsChannelId = process.env.DISCORD_CHANNEL_ANNOUNCEMENTS ?? "";
const matchResultsChannelId = process.env.DISCORD_CHANNEL_MATCH_RESULTS ?? "";
const verifyChannelId = process.env.DISCORD_CHANNEL_VERIFY ?? "";
const banLogChannelId = process.env.DISCORD_CHANNEL_BAN_LOG ?? "";
const modLogChannelId = process.env.DISCORD_CHANNEL_MOD_LOG ?? "";
const guildId = process.env.DISCORD_GUILD_ID ?? "";
const unverifiedRoleId = process.env.DISCORD_ROLE_UNVERIFIED_ID ?? "";
const verifiedRoleId = process.env.DISCORD_ROLE_VERIFIED_ID ?? "";
const steamVerifiedRoleId = process.env.DISCORD_ROLE_STEAM_VERIFIED_ID ?? verifiedRoleId;
const botApiToken = process.env.DISCORD_BOT_API_TOKEN ?? "";
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? botApiToken;
const internalWebhookSecret = process.env.INTERNAL_WEBHOOK_SECRET ?? "";
const serverManagerApiToken = process.env.SERVER_MANAGER_API_TOKEN ?? "";
const modJwt = process.env.DISCORD_MOD_JWT ?? "";
const enableTestMode = (process.env.DISCORD_ENABLE_TEST_MODE ?? "false").toLowerCase() === "true";
const moderatorRoleId = process.env.DISCORD_MODERATOR_ROLE_ID ?? "";
const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID ?? "";
const developerRoleId = process.env.DISCORD_DEVELOPER_ROLE_ID ?? "";
const clanRolePrefix = process.env.DISCORD_CLAN_ROLE_PREFIX ?? "Clan ";
const playerLinksRaw = process.env.DISCORD_PLAYER_LINKS_JSON ?? "{}";
const playerDiscordMap: Record<string, string> = (() => {
  try {
    const parsed = JSON.parse(playerLinksRaw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();
const COMMUNITY_MAPS = [
  "de_mirage",
  "de_inferno",
  "de_anubis",
  "de_ancient",
  "de_nuke",
  "de_overpass",
  "de_vertigo",
  "de_cache",
  "de_train",
  "de_tuscan",
  "de_dust2"
];
const REPORT_REASONS = ["cheating", "griefing", "toxic", "afk"] as const;
const GAME_MODES = ["ranked", "wingman", "casual", "superpower", "gungame", "zombie", "clanwars"] as const;
type GameMode = (typeof GAME_MODES)[number];
const MODE_CONFIG: Record<GameMode, { playersPerMatch: number; teamSize: number; unranked: boolean }> = {
  ranked: { playersPerMatch: 10, teamSize: 5, unranked: false },
  wingman: { playersPerMatch: 4, teamSize: 2, unranked: false },
  casual: { playersPerMatch: 20, teamSize: 10, unranked: true },
  superpower: { playersPerMatch: 20, teamSize: 10, unranked: true },
  gungame: { playersPerMatch: 20, teamSize: 10, unranked: true },
  zombie: { playersPerMatch: 20, teamSize: 10, unranked: true },
  clanwars: { playersPerMatch: 10, teamSize: 5, unranked: false }
};

const SKIN_CATEGORIES = ["primary", "pistol", "knife", "gloves"] as const;

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.GuildPresences,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent
  ]
});
const eventLogger = createServiceLogger("discord-bot");

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

const sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const liveMessageIndex = new Map<string, string>();
const matchChannels = new Map<
  string,
  {
    categoryId: string;
    chatChannelId: string;
    team1VoiceChannelId: string;
    team2VoiceChannelId: string;
    halftimeVoiceChannelId: string;
    allowedDiscordUserIds: string[];
    playerIds: string[];
    teamAPlayerIds: string[];
    teamBPlayerIds: string[];
    voiceLocked: boolean;
    halftimeActive: boolean;
  }
>();
let dailyMapVoteState:
  | {
      voteDate: string;
      targetDate: string;
      channelId: string;
      voteMessageId: string;
      votes: Record<string, number>;
      votedByUser: Map<string, Set<string>>;
    }
  | null = null;
const matchVetos = new Map<
  string,
  {
    matchId: string;
    channelId: string;
    vetoMessageId: string;
    teamA: any[];
    teamB: any[];
    mode: "ranked" | "wingman" | "casual" | "superpower" | "gungame" | "zombie" | "clanwars";
    remainingMaps: string[];
    bannedMaps: Array<{ map: string; by: "A" | "B"; playerId: string; discordId: string | null }>;
    captainA: { playerId: string; elo: number; discordId: string | null };
    captainB: { playerId: string; elo: number; discordId: string | null };
    teamACards: Array<{ playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>;
    teamBCards: Array<{ playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>;
    turn: number;
    totalTurns: number;
    simulateEnd: boolean;
  }
>();
const matchVotes = new Map<string, any>();
const pendingReportContexts = new Map<
  string,
  { reporterSteamId: string; reportedSteamId: string; matchId: string; createdAt: number }
>();
const pendingVerificationCaptchas = new Map<
  string,
  { discordId: string; answer: number; expiresAt: number }
>();
const passedVerificationCaptcha = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingVerificationCaptchas) {
    if (value.expiresAt <= now) pendingVerificationCaptchas.delete(key);
  }
  for (const [discordId, expiresAt] of passedVerificationCaptcha) {
    if (expiresAt <= now) passedVerificationCaptcha.delete(discordId);
  }
}, 30_000).unref();
const streamerLobbies = new Map<
  string,
  {
    lobbyId: string;
    streamerDiscordId: string;
    streamerName: string;
    streamUrl: string;
    mode: GameMode;
    requiredPlayers: number;
    players: Array<{ discordId: string; playerId: string; elo: number; region: string; joinedAt: string }>;
    channelId: string;
    messageId: string;
    status: "open" | "starting" | "live";
    matchId?: string;
  }
>();
const streamerMatches = new Map<string, { streamerName: string; streamUrl: string; lobbyId: string }>();
const creatorMatchesLive = new Map<
  string,
  {
    mode: GameMode;
    spectate: string;
    streamUrl: string | null;
    creatorSteamId: string | null;
    creatorName: string | null;
  }
>();
const presenceStatsCache: {
  fetchedAt: number;
  data: { liveMatches: number; serversOnline: number; playersInQueue: number };
} = {
  fetchedAt: 0,
  data: { liveMatches: 0, serversOnline: 0, playersInQueue: 0 }
};
let presenceRotateIndex = 0;
let presenceTimer: NodeJS.Timeout | null = null;

function buildSignedInternalHeaders(path: string, method: string, body: unknown): Record<string, string> {
  if (!internalWebhookSecret) return {};
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(12).toString("hex");
  const route = path.split("?")[0];
  const bodyRaw = body ? JSON.stringify(body) : "";
  const bodyHash = crypto.createHash("sha256").update(bodyRaw).digest("hex");
  const payload = `${timestamp}.${nonce}.${method.toUpperCase()}.${route}.${bodyHash}`;
  const signature = crypto.createHmac("sha256", internalWebhookSecret).update(payload).digest("hex");
  return {
    "x-internal-timestamp": timestamp,
    "x-internal-nonce": nonce,
    "x-internal-signature": signature
  };
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const method = String(init?.method ?? "GET").toUpperCase();
  const isInternal = path.startsWith("/internal/");
  let payload: unknown = undefined;
  if (typeof init?.body === "string") {
    try {
      payload = JSON.parse(init.body);
    } catch {
      payload = undefined;
    }
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(isInternal && internalApiToken ? { "x-internal-token": internalApiToken } : {}),
      ...(isInternal ? buildSignedInternalHeaders(path, method, payload) : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function serverApi(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${serverManagerBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(serverManagerApiToken ? { "x-server-manager-token": serverManagerApiToken } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Server API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function getLiveMatchesCount(): Promise<number> {
  const live = await api("/matches/live");
  if (!Array.isArray(live)) return 0;
  return live.length;
}

async function getOnlineServersCount(): Promise<number> {
  const servers = await serverApi("/servers");
  if (Array.isArray(servers)) return servers.length;
  if (Array.isArray(servers?.servers)) return servers.servers.length;
  return 0;
}

async function getQueuePlayersCount(): Promise<number> {
  const sizes = await Promise.all(
    GAME_MODES.map(async (mode) => {
      const status = await api(`/queue/status?mode=${encodeURIComponent(mode)}`);
      return Number(status?.size ?? 0);
    })
  );
  return sizes.reduce((sum, value) => sum + value, 0);
}

async function getPresenceStats(force = false): Promise<{ liveMatches: number; serversOnline: number; playersInQueue: number }> {
  const now = Date.now();
  if (!force && now - presenceStatsCache.fetchedAt < 10_000) {
    return presenceStatsCache.data;
  }
  try {
    const [liveMatches, serversOnline, playersInQueue] = await Promise.all([
      getLiveMatchesCount(),
      getOnlineServersCount(),
      getQueuePlayersCount()
    ]);
    presenceStatsCache.fetchedAt = now;
    presenceStatsCache.data = { liveMatches, serversOnline, playersInQueue };
  } catch (error) {
    eventLogger.info("presence_stats_fetch_failed", {
      reason: error instanceof Error ? error.message : "unknown"
    });
  }
  return presenceStatsCache.data;
}

async function rotatePresence(): Promise<void> {
  if (!client.user) return;
  const fallback = "🔥 FragHub Matchmaking";
  try {
    const stats = await getPresenceStats();
    const statuses = [
      `🎮 ${stats.liveMatches} Live Matches`,
      `🖥️ ${stats.serversOnline} Servers Online`,
      `👥 ${stats.playersInQueue} Players in Queue`,
      fallback
    ];
    const statusText = statuses[presenceRotateIndex % statuses.length] ?? fallback;
    client.user.setPresence({
      activities: [{ name: statusText, type: ActivityType.Watching }],
      status: "online"
    });
    presenceRotateIndex = (presenceRotateIndex + 1) % statuses.length;
  } catch {
    client.user.setPresence({
      activities: [{ name: fallback, type: ActivityType.Watching }],
      status: "online"
    });
  }
}

async function startPresenceRotation(): Promise<void> {
  if (!client.user) return;
  if (presenceTimer) {
    clearInterval(presenceTimer);
  }
  await getPresenceStats(true);
  await rotatePresence();
  presenceTimer = setInterval(() => {
    void rotatePresence();
  }, 15_000);
  presenceTimer.unref();
}

type SkinCatalogEntry = {
  weapon_name: string;
  skins: Array<{ skin_name: string; skin_id: string; rarity: string; image_url?: string | null; is_default?: boolean }>;
};

type SkinCatalogResponse = {
  categories: Record<(typeof SKIN_CATEGORIES)[number], SkinCatalogEntry[]>;
};

let skinCatalogCache: { fetchedAt: number; data: SkinCatalogResponse } | null = null;

function prettyWeaponName(name: string): string {
  const predefined: Record<string, string> = {
    ak47: "AK47",
    "m4a1-s": "M4A1-S",
    m4a4: "M4A4",
    awp: "AWP",
    "usp-s": "USP-S",
    glock: "Glock",
    deagle: "Deagle",
    mp9: "MP9",
    ump45: "UMP45",
    famas: "Famas",
    galil: "Galil",
    p90: "P90",
    mac10: "MAC10",
    nova: "Nova",
    xm1014: "XM1014",
    mag7: "MAG7",
    negev: "Negev",
    sg553: "SG553",
    aug: "AUG",
    knife_karambit: "Karambit",
    knife_butterfly: "Butterfly Knife",
    knife_m9_bayonet: "M9 Bayonet",
    knife_bayonet: "Bayonet",
    knife_skeleton: "Skeleton Knife",
    knife_talon: "Talon Knife",
    gloves_sport: "Sport Gloves",
    gloves_driver: "Driver Gloves",
    gloves_specialist: "Specialist Gloves",
    gloves_moto: "Moto Gloves",
    gloves_hand_wraps: "Hand Wraps"
  };
  return predefined[name] ?? name.toUpperCase();
}

function prettyCategoryName(category: (typeof SKIN_CATEGORIES)[number]): string {
  if (category === "primary") return "Primary Weapons";
  if (category === "pistol") return "Pistols";
  if (category === "knife") return "Knives";
  return "Gloves";
}

async function getSkinCatalog(force = false): Promise<SkinCatalogResponse> {
  if (!force && skinCatalogCache && Date.now() - skinCatalogCache.fetchedAt < 60_000) {
    return skinCatalogCache.data;
  }
  const raw = await api("/skins/catalog");
  const categories = raw?.categories ?? {};
  const normalized: SkinCatalogResponse = {
    categories: {
      primary: Array.isArray(categories.primary) ? categories.primary : [],
      pistol: Array.isArray(categories.pistol) ? categories.pistol : [],
      knife: Array.isArray(categories.knife) ? categories.knife : [],
      gloves: Array.isArray(categories.gloves) ? categories.gloves : []
    }
  };
  skinCatalogCache = { fetchedAt: Date.now(), data: normalized };
  return normalized;
}

async function getVerificationStatus(discordId: string): Promise<{ verified: boolean; steam_id?: string; username?: string | null; username_required?: boolean }> {
  try {
    const status = await api(`/internal/verification/status/${encodeURIComponent(discordId)}`);
    return {
      verified: Boolean(status?.verified),
      steam_id: status?.steam_id ? String(status.steam_id) : undefined,
      username: status?.username ? String(status.username) : null,
      username_required: Boolean(status?.username_required)
    };
  } catch {
    return { verified: false };
  }
}

async function requireVerifiedDiscordUser(discordId: string): Promise<string | null> {
  const status = await getVerificationStatus(discordId);
  if (!status.verified || !status.steam_id) return null;
  return status.steam_id;
}

function verificationRequiredEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Verification Required")
    .setDescription("Click **Verify** (or run **/verify**) to complete CAPTCHA, then run **/linksteam**.");
}

function verificationPanelComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("verify:start").setLabel("Verify").setStyle(ButtonStyle.Success)
    )
  ];
}

function makeCaptchaButtons(challengeId: string, answer: number): ActionRowBuilder<ButtonBuilder>[] {
  const choices = new Set<number>([answer]);
  while (choices.size < 3) {
    const delta = Math.floor(Math.random() * 5) + 1;
    choices.add(answer + (Math.random() < 0.5 ? -delta : delta));
  }
  const shuffled = Array.from(choices).sort(() => Math.random() - 0.5);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...shuffled.map((choice) =>
        new ButtonBuilder()
          .setCustomId(`verify:captcha:${challengeId}:${choice}`)
          .setLabel(String(choice))
          .setStyle(ButtonStyle.Secondary)
      )
    )
  ];
}

function makeCaptchaPrompt(a: number, b: number, challengeId: string): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("Verification CAPTCHA")
        .setDescription(`Solve this to continue: **${a} + ${b} = ?**`)
    ],
    components: makeCaptchaButtons(challengeId, a + b)
  };
}

async function setMemberVerificationRoles(discordId: string): Promise<void> {
  const effectiveVerifiedRoleId = verifiedRoleId || steamVerifiedRoleId;
  if (!guildId || !effectiveVerifiedRoleId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  if (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId)) {
    await member.roles.remove(unverifiedRoleId).catch(() => null);
  }
  if (!member.roles.cache.has(effectiveVerifiedRoleId)) {
    await member.roles.add(effectiveVerifiedRoleId).catch(() => null);
  }
}

async function assignMemberUnverifiedRole(discordId: string): Promise<void> {
  const effectiveVerifiedRoleId = verifiedRoleId || steamVerifiedRoleId;
  if (!guildId || !unverifiedRoleId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  if (effectiveVerifiedRoleId && member.roles.cache.has(effectiveVerifiedRoleId)) {
    await member.roles.remove(effectiveVerifiedRoleId).catch(() => null);
  }
  if (!member.roles.cache.has(unverifiedRoleId)) {
    await member.roles.add(unverifiedRoleId).catch(() => null);
  }
}

async function syncVerificationGatePermissions(): Promise<void> {
  if (!guildId || !verifyChannelId || !unverifiedRoleId) return;
  const effectiveVerifiedRoleId = verifiedRoleId || steamVerifiedRoleId;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  for (const channel of guild.channels.cache.values()) {
    if (!("permissionOverwrites" in channel)) {
      continue;
    }
    if (channel.id === verifyChannelId) {
      await channel.permissionOverwrites
        .edit(unverifiedRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true })
        .catch(() => null);
      if (effectiveVerifiedRoleId) {
        await channel.permissionOverwrites
          .edit(effectiveVerifiedRoleId, { ViewChannel: false })
          .catch(() => null);
      }
      continue;
    }

    await channel.permissionOverwrites
      .edit(unverifiedRoleId, { ViewChannel: false })
      .catch(() => null);
  }
}

function clanRoleName(tag: string): string {
  return `${clanRolePrefix}${tag.toUpperCase()}`;
}

function clanCategoryName(tag: string): string {
  return `[${tag.toUpperCase()}] Clan`;
}

async function ensureClanDiscordResources(tag: string): Promise<{
  roleId: string;
  categoryId: string;
  chatId: string;
  planningId: string;
  voiceId: string;
} | null> {
  if (!guildId) return null;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const normalizedTag = tag.toUpperCase();
  const roleName = clanRoleName(normalizedTag);
  const categoryTitle = clanCategoryName(normalizedTag);

  let role = guild.roles.cache.find((r) => r.name === roleName) ?? null;
  if (!role) {
    role = await guild.roles.create({
      name: roleName,
      color: Math.floor(Math.random() * 0xffffff),
      mentionable: false,
      reason: `Create clan role for ${normalizedTag}`
    }).catch(() => null);
  }
  if (!role) return null;

  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak
  ];
  const baseOverwrites: any[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: role.id, allow }
  ];
  if (moderatorRoleId) baseOverwrites.push({ id: moderatorRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
  if (adminRoleId) baseOverwrites.push({ id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
  if (developerRoleId) baseOverwrites.push({ id: developerRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });

  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === categoryTitle
  ) as CategoryChannel | undefined;
  if (!category) {
    const created = await guild.channels.create({
      name: categoryTitle,
      type: ChannelType.GuildCategory,
      permissionOverwrites: baseOverwrites,
      reason: `Create clan category for ${normalizedTag}`
    }).catch(() => null);
    if (!created || created.type !== ChannelType.GuildCategory) return null;
    category = created;
  } else {
    await category.permissionOverwrites.set(baseOverwrites).catch(() => null);
  }

  const existingChildren = guild.channels.cache.filter((c) => c.parentId === category.id);
  let chat = existingChildren.find((c) => c.type === ChannelType.GuildText && c.name === "clan-chat") as TextChannel | undefined;
  let planning = existingChildren.find((c) => c.type === ChannelType.GuildText && c.name === "clan-war-planning") as TextChannel | undefined;
  let voice = existingChildren.find((c) => c.type === ChannelType.GuildVoice && c.name === "clan-voice") as VoiceChannel | undefined;

  if (!chat) {
    chat = (await guild.channels.create({
      name: "clan-chat",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites
    }).catch(() => null)) as TextChannel | null ?? undefined;
  }
  if (!planning) {
    planning = (await guild.channels.create({
      name: "clan-war-planning",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: baseOverwrites
    }).catch(() => null)) as TextChannel | null ?? undefined;
  }
  if (!voice) {
    const created = await guild.channels.create({
      name: "clan-voice",
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: baseOverwrites
    }).catch(() => null);
    if (!created || created.type !== ChannelType.GuildVoice) return null;
    voice = created;
  }

  if (!chat || !planning || !voice) return null;
  return {
    roleId: role.id,
    categoryId: category.id,
    chatId: chat.id,
    planningId: planning.id,
    voiceId: voice.id
  };
}

async function addClanRoleToDiscordUser(discordId: string, clanTag: string): Promise<void> {
  if (!guildId || !discordId || !clanTag) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  await ensureClanDiscordResources(clanTag);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const targetRoleName = clanRoleName(clanTag);
  const targetRole = guild.roles.cache.find((r) => r.name === targetRoleName);
  if (!targetRole) return;
  const clanRoles = guild.roles.cache.filter((r) => r.name.startsWith(clanRolePrefix));
  for (const role of clanRoles.values()) {
    if (role.id !== targetRole.id && member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(() => null);
    }
  }
  if (!member.roles.cache.has(targetRole.id)) {
    await member.roles.add(targetRole).catch(() => null);
  }
}

async function removeClanRolesFromDiscordUser(discordId: string): Promise<void> {
  if (!guildId || !discordId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const clanRoles = guild.roles.cache.filter((r) => r.name.startsWith(clanRolePrefix));
  for (const role of clanRoles.values()) {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(() => null);
    }
  }
}

async function cleanupClanDiscordResources(clanTag: string): Promise<void> {
  if (!guildId || !clanTag) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === clanCategoryName(clanTag)
  );
  if (category) {
    for (const child of guild.channels.cache.filter((c) => c.parentId === category.id).values()) {
      await child.delete(`Cleanup clan ${clanTag}`).catch(() => null);
    }
    await category.delete(`Cleanup clan ${clanTag}`).catch(() => null);
  }
  const role = guild.roles.cache.find((r) => r.name === clanRoleName(clanTag));
  if (role) {
    await role.delete(`Cleanup clan ${clanTag}`).catch(() => null);
  }
}

async function enforceClanRoleIntegrity(member: GuildMember): Promise<void> {
  const status = await getVerificationStatus(member.id);
  const clanRoles = member.guild.roles.cache.filter((r) => r.name.startsWith(clanRolePrefix));
  if (!status.verified || !status.steam_id) {
    for (const role of clanRoles.values()) {
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role).catch(() => null);
      }
    }
    return;
  }
  const profile = await fetchPlayerIdentity(status.steam_id);
  const expectedRoleName = profile?.clan_tag ? clanRoleName(profile.clan_tag) : null;
  for (const role of clanRoles.values()) {
    if (member.roles.cache.has(role.id) && role.name !== expectedRoleName) {
      await member.roles.remove(role).catch(() => null);
    }
  }
  if (expectedRoleName) {
    const expectedRole = member.guild.roles.cache.find((r) => r.name === expectedRoleName);
    if (expectedRole && !member.roles.cache.has(expectedRole.id)) {
      await member.roles.add(expectedRole).catch(() => null);
    }
  }
}

async function postOrRefreshVerificationPanel(): Promise<void> {
  const channel = await getChannel(verifyChannelId);
  if (!channel) return;
  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const existing = recent?.find((m) => m.author.id === client.user?.id && m.components.length > 0);
  if (existing) {
    await existing.edit({
      embeds: [verificationRequiredEmbed()],
      components: verificationPanelComponents()
    });
    return;
  }
  await channel.send({
    embeds: [verificationRequiredEmbed()],
    components: verificationPanelComponents()
  });
}

async function ensureVerifiedAccess(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<string | null> {
  const status = await getVerificationStatus(interaction.user.id);
  if (status.verified && status.steam_id && !status.username_required && status.username) return status.steam_id;
  const verifyChannelMention = verifyChannelId ? `<#${verifyChannelId}>` : "#verify";
  const text =
    status.verified && status.steam_id
      ? "Verification complete. Please choose your username using **/username <name>** before using matchmaking features."
      : `Verify first in ${verifyChannelMention} using **/verify** or the **Verify** button, then run **/linksteam**.`;
  const payload = {
    embeds: [
      new EmbedBuilder()
        .setTitle("Verification Required")
        .setDescription(text)
    ],
    ephemeral: true as const
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
  return null;
}

async function getChannel(channelId: string): Promise<TextChannel | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return null;
  return channel as TextChannel;
}

async function getGuildByConfiguredId() {
  if (!guildId) return null;
  return client.guilds.fetch(guildId).catch(() => null);
}

async function setMatchChatLocked(matchId: string, locked: boolean): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state) return;
  const guild = await getGuildByConfiguredId();
  if (!guild) return;
  const channel = await guild.channels.fetch(state.chatChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const text = channel as TextChannel;

  const overwriteTargets = [
    ...state.allowedDiscordUserIds,
    ...(moderatorRoleId ? [moderatorRoleId] : [])
  ];
  for (const targetId of overwriteTargets) {
    await text.permissionOverwrites
      .edit(targetId, { SendMessages: !locked })
      .catch(() => null);
  }
}

async function movePlayersToTeamVoice(matchId: string): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state) return;
  const guild = await getGuildByConfiguredId();
  if (!guild) return;

  const teamASet = new Set(state.teamAPlayerIds);
  const teamBSet = new Set(state.teamBPlayerIds);
  for (const playerId of state.playerIds) {
    const discordId = playerDiscordMap[playerId];
    if (!discordId) continue;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member || !member.voice.channelId) continue;
    if (teamASet.has(playerId)) {
      const from = member.voice.channelId;
      await member.voice.setChannel(state.team1VoiceChannelId).catch(() => null);
      if (from !== state.team1VoiceChannelId) {
        await postVoiceLog("Player moved to Team 1 VC", {
          matchId,
          memberId: member.id,
          from,
          to: state.team1VoiceChannelId
        });
      }
      continue;
    }
    if (teamBSet.has(playerId)) {
      const from = member.voice.channelId;
      await member.voice.setChannel(state.team2VoiceChannelId).catch(() => null);
      if (from !== state.team2VoiceChannelId) {
        await postVoiceLog("Player moved to Team 2 VC", {
          matchId,
          memberId: member.id,
          from,
          to: state.team2VoiceChannelId
        });
      }
    }
  }
}

async function movePlayersToHalftimeVoice(matchId: string): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state) return;
  const guild = await getGuildByConfiguredId();
  if (!guild) return;

  for (const playerId of state.playerIds) {
    const discordId = playerDiscordMap[playerId];
    if (!discordId) continue;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member || !member.voice.channelId) continue;
    const from = member.voice.channelId;
    await member.voice.setChannel(state.halftimeVoiceChannelId).catch(() => null);
    if (from !== state.halftimeVoiceChannelId) {
      await postVoiceLog("Player moved to Halftime VC", {
        matchId,
        memberId: member.id,
        from,
        to: state.halftimeVoiceChannelId
      });
    }
  }
}

function isStaffMember(member: GuildMember): boolean {
  return Boolean(
    (moderatorRoleId && member.roles.cache.has(moderatorRoleId)) ||
      (adminRoleId && member.roles.cache.has(adminRoleId)) ||
      (developerRoleId && member.roles.cache.has(developerRoleId))
  );
}

async function postVoiceLog(
  title: string,
  details: { matchId: string; memberId: string; from?: string | null; to?: string | null; note?: string }
): Promise<void> {
  eventLogger.info("match_voice_event", {
    match_id: details.matchId,
    member_id: details.memberId,
    from_channel_id: details.from ?? null,
    to_channel_id: details.to ?? null,
    note: details.note ?? null
  });
  const channel = await getChannel(modLogChannelId);
  if (!channel) return;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setColor(0x3498db)
        .addFields(
          { name: "Match", value: details.matchId, inline: true },
          { name: "Player", value: `<@${details.memberId}>`, inline: true },
          { name: "From", value: details.from ? `<#${details.from}>` : "none", inline: true },
          { name: "To", value: details.to ? `<#${details.to}>` : "none", inline: true },
          { name: "Note", value: details.note ?? "n/a", inline: false }
        )
        .setTimestamp(new Date())
    ]
  });
}

async function lockMatchVoice(matchId: string, locked: boolean): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state) return;
  state.voiceLocked = locked;
  if (!locked) {
    state.halftimeActive = false;
  }
}

async function startMatchHalftimeVoice(matchId: string): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state) return;
  state.halftimeActive = true;
  await movePlayersToHalftimeVoice(matchId);
  const chat = await getChannel(state.chatChannelId);
  if (chat) {
    await chat.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Halftime VC")
          .setDescription("Halftime started. You have 60 seconds to talk.")
          .setColor(0xf1c40f)
      ]
    });
  }
}

async function endMatchHalftimeVoice(matchId: string): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state || !state.halftimeActive) return;
  state.halftimeActive = false;
  await movePlayersToTeamVoice(matchId);
}

async function cleanupMatchChannels(matchId: string): Promise<void> {
  const state = matchChannels.get(matchId);
  if (!state) return;
  const guild = await getGuildByConfiguredId();
  if (!guild) {
    matchChannels.delete(matchId);
    return;
  }

  const channelIds = [state.chatChannelId, state.team1VoiceChannelId, state.team2VoiceChannelId, state.halftimeVoiceChannelId];
  for (const id of channelIds) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel) {
      await channel.delete(`Match ${matchId} completed: cleanup temporary channel`).catch(() => null);
    }
  }
  const category = await guild.channels.fetch(state.categoryId).catch(() => null);
  if (category) {
    await category.delete(`Match ${matchId} completed: cleanup temporary category`).catch(() => null);
  }
  matchChannels.delete(matchId);
}

async function postMatchStarted(event: any): Promise<void> {
  const channel = await getChannel(liveMatchesChannelId);
  if (!channel) return;

  const matchId = String(event.matchId ?? event.match_id ?? "unknown");
  const match = await api(`/matches/${matchId}`);
  const players = (match.players ?? [])
    .map((p: any) => p.display_name ?? p.id)
    .join(", ");
  const spectateCommand = event.spectate ?? match.connect_string ?? "n/a";
  const streamerMeta = streamerMatches.get(matchId);
  const creatorMatch = Boolean(event.creator_match ?? match.creator_match ?? streamerMeta);
  const creatorName = String(event.creator?.display_name ?? match.creator?.display_name ?? streamerMeta?.streamerName ?? "Creator");
  const creatorSteamId = String(event.creator?.steam_id ?? match.creator?.steam_id ?? "");
  const streamUrl =
    String(event.creator_stream_url ?? match.creator_stream_url ?? streamerMeta?.streamUrl ?? "").trim() || null;
  const mode = String(event.mode ?? match.mode ?? "ranked") as GameMode;

  const embed = new EmbedBuilder().setTitle(creatorMatch ? "?? Creator Match Live" : "LIVE MATCH");
  if (creatorMatch) {
    embed
      .setColor(0x00b894)
      .addFields(
        { name: "Creator Name", value: creatorName, inline: true },
        { name: "Game Mode", value: mode, inline: true },
        { name: "Map", value: String(match.map ?? event.map ?? "unknown"), inline: true },
        { name: "Players", value: players || "unknown", inline: false },
        { name: "Spectate", value: `\`${spectateCommand}\``, inline: false }
      );
  } else {
    embed.addFields(
      { name: "Match", value: matchId, inline: true },
      { name: "Map", value: String(match.map ?? event.map ?? "unknown"), inline: true },
      { name: "Players", value: players || "unknown" },
      { name: "Spectate", value: `\`${spectateCommand}\`` }
    );
    if (streamerMeta) {
      embed.addFields(
        { name: "Streamer", value: streamerMeta.streamerName, inline: true },
        { name: "Stream", value: streamerMeta.streamUrl, inline: true }
      );
      embed.setColor(0x00b894);
    }
  }

  let components: ActionRowBuilder<ButtonBuilder>[] = [linkRow("Open Match", `${publicApiUrl}/matches/${matchId}`)];
  if (creatorMatch) {
    components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`creator:spectate:${matchId}`)
          .setLabel("Spectate")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Watch Stream")
          .setURL(streamUrl ?? publicApiUrl),
        new ButtonBuilder()
          .setCustomId(`creator:joinnext:${matchId}`)
          .setLabel("Join Next Match")
          .setStyle(ButtonStyle.Success)
      ),
      ...components
    ];
    creatorMatchesLive.set(matchId, {
      mode,
      spectate: spectateCommand,
      streamUrl,
      creatorSteamId: creatorSteamId || null,
      creatorName: creatorName || null
    });
  }

  const msg = await channel.send({ embeds: [embed], components });

  liveMessageIndex.set(matchId, msg.id);
  await setMatchChatLocked(matchId, true);
  await lockMatchVoice(matchId, true);
  await movePlayersToTeamVoice(matchId);
}
async function postMatchFinished(event: any): Promise<void> {
  const channel = await getChannel(liveMatchesChannelId);
  if (!channel) return;
  const matchId = String(event.matchId ?? event.match_id ?? "unknown");
  const messageId = liveMessageIndex.get(matchId);
  const demoLink = event.demoUrl ?? event.demo_url ?? "not uploaded";

  if (!messageId) {
    const embed = new EmbedBuilder()
      .setTitle("MATCH FINISHED")
      .addFields(
        { name: "Match", value: matchId, inline: true },
        { name: "Final Score", value: String(event.finalScore ?? "0-0"), inline: true },
        { name: "Demo", value: demoLink }
      );
    await channel.send({ embeds: [embed] });
  } else {
    const msg = await channel.messages.fetch(messageId);
    const finishedEmbed = new EmbedBuilder()
      .setTitle("LIVE MATCH")
      .addFields(
        { name: "Match", value: matchId, inline: true },
        { name: "Status", value: "Finished", inline: true },
        { name: "Final Score", value: String(event.finalScore ?? "0-0"), inline: true },
        { name: "Demo", value: demoLink }
      );
    await msg.edit({ embeds: [finishedEmbed], components: [] });
  }

  const temp = matchChannels.get(matchId);
  if (temp) {
    await lockMatchVoice(matchId, false);
    const matchChannel = await getChannel(temp.chatChannelId);
    if (matchChannel) {
      const finalScore = event.finalScore ?? "0-0";
      await matchChannel.send(
        {
          embeds: [
            new EmbedBuilder()
              .setTitle("Match Complete")
              .setDescription("Match channel cleanup in progress.")
              .addFields(
                { name: "Final Score", value: finalScore, inline: true },
                { name: "Demo", value: demoLink }
              )
          ]
        }
      );
      setTimeout(async () => {
        await cleanupMatchChannels(matchId);
      }, 10 * 60 * 1000);
    }
  }
  streamerMatches.delete(matchId);
  creatorMatchesLive.delete(matchId);

  try {
    const match = await api(`/matches/${matchId}`);
    if (String(match.mode ?? "").toLowerCase() === "clanwars") {
      const clanResult = await api(`/internal/clan/match/${encodeURIComponent(matchId)}/result`);
      const resultChannel = await getChannel(matchResultsChannelId);
      if (resultChannel) {
        await resultChannel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Clan War Result")
              .addFields(
                { name: "Match", value: matchId, inline: true },
                { name: "Clans", value: `[${clanResult.clan_a_tag}] vs [${clanResult.clan_b_tag}]`, inline: true },
                { name: "Winner", value: String(clanResult.winner_clan_tag ?? "n/a"), inline: true },
                { name: "Score", value: `${clanResult.clan_a_score} - ${clanResult.clan_b_score}`, inline: true }
              )
          ]
        });
      }
    }
  } catch {
    // best effort for clan war result announcements
  }
}

async function postMatchRecoveryStarted(event: any): Promise<void> {
  const matchId = String(event.matchId ?? event.match_id ?? "unknown");
  const temp = matchChannels.get(matchId);
  const text = "⚠️ Server crash detected. Recovering match...";
  if (temp) {
    const ch = await getChannel(temp.chatChannelId);
    if (ch) {
      await ch.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚠️ Match Server Restarted")
            .setDescription(text)
            .addFields(
              { name: "Match", value: matchId, inline: true },
              { name: "Map", value: String(event.map ?? "unknown"), inline: true },
              { name: "Round", value: String(event.round ?? "0"), inline: true }
            )
        ]
      });
    }
  }
}

async function postMatchRecovered(event: any): Promise<void> {
  const matchId = String(event.matchId ?? event.match_id ?? "unknown");
  const reconnect =
    event.connection_data?.server_ip && event.connection_data?.port && event.connection_data?.server_password
      ? `connect ${event.connection_data.server_ip}:${event.connection_data.port}; password ${event.connection_data.server_password}`
      : null;
  const temp = matchChannels.get(matchId);
  if (temp) {
    const ch = await getChannel(temp.chatChannelId);
    if (ch) {
      await ch.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚠️ Match Server Restarted")
            .setDescription(reconnect ? `Reconnect:\n\`${reconnect}\`` : "Server recovered. Reconnect info pending.")
            .addFields(
              { name: "Score", value: `${event.team_a_score ?? 0}-${event.team_b_score ?? 0}`, inline: true },
              { name: "Round", value: String(event.round ?? "0"), inline: true }
            )
        ]
      });
    }
  }
}

async function postMatchRecoveryFailed(event: any): Promise<void> {
  const matchId = String(event.matchId ?? event.match_id ?? "unknown");
  const temp = matchChannels.get(matchId);
  if (temp) {
    const ch = await getChannel(temp.chatChannelId);
    if (ch) {
      await ch.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Match Recovery Failed")
            .setDescription(`Match canceled. Reason: ${String(event.reason ?? "recovery failed")}\nMMR restored to players.`)
        ]
      });
    }
  }
}

async function postCaseCreated(event: any): Promise<void> {
  const channel = await getChannel(overwatchChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle("New Overwatch Case")
    .addFields(
      { name: "Case ID", value: String(event.case.id), inline: true },
      { name: "Player ID", value: String(event.case.reported_player_id), inline: true },
      { name: "Match ID", value: String(event.case.match_id), inline: true },
      { name: "Demo", value: String(event.case.demo_url ?? "pending") }
    );
  const caseId = String(event.case.id);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ow:${caseId}:spectate`).setLabel("Spectate").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ow:${caseId}:timeout`).setLabel("Timeout").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ow:${caseId}:ban`).setLabel("Ban").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ow:${caseId}:clean`).setLabel("Clean").setStyle(ButtonStyle.Success)
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function postPublicBanLog(event: any): Promise<void> {
  const channel = await getChannel(banLogChannelId);
  if (!channel) return;
  const ban = event.ban ?? {};
  const playerName = String(event.player_name ?? ban.player_name ?? "Unknown");
  const steamId = String(ban.steam_id ?? "unknown");
  const discordIdRaw = String(ban.discord_id ?? "");
  const discordDisplay = discordIdRaw ? `<@${discordIdRaw}>` : "n/a";
  const reason = String(ban.reason ?? "Cheating");
  const matchId = String(ban.match_id ?? "n/a");
  const caseId = String(ban.case_id ?? "n/a");
  const evidenceUrl = String(ban.evidence_url ?? "");
  const demoTimestamp =
    typeof ban.demo_timestamp_seconds === "number" ? `${ban.demo_timestamp_seconds}s` : "n/a";
  const dateIso = String(ban.created_at ?? new Date().toISOString());

  const embed = new EmbedBuilder()
    .setTitle("🚨 Player Banned")
    .setColor(0xed4245)
    .addFields(
      { name: "Player", value: playerName, inline: true },
      { name: "Steam ID", value: steamId, inline: true },
      { name: "Discord ID", value: discordDisplay, inline: true },
      { name: "Ban Reason", value: reason, inline: true },
      { name: "Match ID", value: matchId, inline: true },
      { name: "Date", value: dateIso, inline: true },
      { name: "Video Clip", value: evidenceUrl || "n/a", inline: false },
      { name: "Demo Timestamp", value: demoTimestamp, inline: true },
      { name: "Case ID", value: caseId, inline: true }
    )
    .setFooter({ text: "Moderation System" })
    .setTimestamp(new Date(dateIso));

  const buttons: ButtonBuilder[] = [];
  if (evidenceUrl) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Watch Demo").setURL(evidenceUrl));
  }
  if (ban.case_id) {
    const caseUrl = `${publicApiUrl}/cases/${ban.case_id}`;
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View Case").setURL(caseUrl));
  }

  const components = buttons.length
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(0, 5))]
    : [];
  await channel.send({ embeds: [embed], components });
}

function moderationStyle(action: string): { color: number; title: string } {
  const a = action.toLowerCase();
  if (a === "server_crash") return { color: 0x3b82f6, title: "⚠️ Server Crash Detected" };
  if (a === "ban") return { color: 0xed4245, title: "🚨 Ban Issued" };
  if (a === "timeout") return { color: 0xf59e0b, title: "⏱ Timeout Issued" };
  if (a === "report") return { color: 0xfacc15, title: "🟡 Player Report" };
  if (a === "unban") return { color: 0x22c55e, title: "✅ Unban Issued" };
  if (a === "overwatch_case_decision") return { color: 0xa855f7, title: "🟣 Overwatch Case Decision" };
  if (a.includes("alert") || a.includes("steam_verification_failure")) {
    return { color: 0x3b82f6, title: "🔵 Alert" };
  }
  return { color: 0x64748b, title: "Moderation Log" };
}

async function postModerationLog(event: any): Promise<void> {
  const channel = await getChannel(modLogChannelId);
  if (!channel) return;
  const action = String(event.action ?? "unknown");
  const style = moderationStyle(action);
  const playerLabel =
    event.player?.display_name
      ? `${event.player.display_name}${event.player?.steam_id ? ` (${event.player.steam_id})` : ""}`
      : event.player_id
      ? String(event.player_id)
      : "n/a";
  const moderatorLabel =
    event.moderator?.display_name
      ? `${event.moderator.display_name}${event.moderator?.steam_id ? ` (${event.moderator.steam_id})` : ""}`
      : event.moderator_id
      ? String(event.moderator_id)
      : "System";
  const matchId = event.match_id ? String(event.match_id) : "n/a";
  const ts = String(event.timestamp ?? new Date().toISOString());

  const embed = new EmbedBuilder()
    .setTitle(style.title)
    .setColor(style.color)
    .addFields(
      { name: "Action", value: action, inline: true },
      { name: "Player", value: playerLabel, inline: true },
      { name: "Moderator", value: moderatorLabel, inline: true },
      { name: "Reason", value: String(event.reason ?? "n/a"), inline: false },
      { name: "Match ID", value: matchId, inline: true },
      { name: "Timestamp", value: ts, inline: true }
    )
    .setFooter({ text: "Moderation System" })
    .setTimestamp(new Date(ts));

  if (action === "server_crash") {
    const serverId = String(event.metadata?.server_id ?? "unknown");
    const map = String(event.metadata?.map ?? "unknown");
    const status = String(event.metadata?.status ?? "restarting");
    embed.addFields(
      { name: "Server", value: serverId, inline: true },
      { name: "Map", value: map, inline: true },
      { name: "Status", value: status, inline: true }
    );
  }

  await channel.send({ embeds: [embed] });
}

async function postCheatAlert(event: any): Promise<void> {
  const overwatchChannel = await getChannel(overwatchChannelId);
  const statusChannel = await getChannel(serverStatusChannelId);
  const text = [
    `**CHEAT ALERT**`,
    `Player ID: ${event.player_id}`,
    `Match ID: ${event.match_id}`,
    `Suspicion Score: ${event.suspicion_score}`,
    `Reasons: ${(event.reasons ?? []).join(", ") || "n/a"}`,
    `Auto Timeout: ${event.auto_timeout_applied ? "24h applied" : "no"}`
  ].join("\n");

  if (overwatchChannel) {
    await overwatchChannel.send({ embeds: [new EmbedBuilder().setTitle("CHEAT ALERT").setDescription(text)] });
  }
  if (statusChannel) {
    await statusChannel.send({
      embeds: [new EmbedBuilder().setTitle("Server Alert").setDescription(`Cheat alert for player ${event.player_id} (score ${event.suspicion_score})`)]
    });
  }
}

async function postSteamLinkFlagged(event: any): Promise<void> {
  const overwatchChannel = await getChannel(overwatchChannelId);
  if (!overwatchChannel) return;
  await overwatchChannel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("Steam Link Flagged")
        .setColor(0xff9900)
        .addFields(
          { name: "Steam ID", value: String(event.steam_id ?? "unknown"), inline: true },
          { name: "Discord ID", value: String(event.discord_id ?? "unknown"), inline: true },
          { name: "Steam Account Age", value: String(event.steam_account_age ?? "unknown"), inline: true },
          { name: "CS Hours", value: String(event.cs_hours ?? "unknown"), inline: true },
          { name: "Reasons", value: (event.reasons ?? []).join(", ") || "n/a", inline: false },
          { name: "Profile", value: String(event.steam_profile_url ?? "n/a"), inline: false }
        )
    ]
  });
}

async function postBanEvasionAlert(event: any): Promise<void> {
  const channel = await getChannel(overwatchChannelId);
  if (!channel) return;
  const caseId = String(event.case?.case_id ?? event.case_id ?? "");
  const reasonsRaw = event.reasons ?? event.case?.reasons ?? [];
  const reasonText = Array.isArray(reasonsRaw) ? reasonsRaw.map((x) => String(x)).join(", ") : String(reasonsRaw);
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Possible Ban Evasion Detected")
    .setColor(0xff9900)
    .addFields(
      { name: "Steam ID", value: String(event.steam_id ?? event.case?.steam_id ?? "unknown"), inline: true },
      { name: "Discord ID", value: String(event.discord_id ?? event.case?.discord_id ?? "unknown"), inline: true },
      { name: "Suspicion Score", value: String(event.suspicion_score ?? event.case?.suspicion_score ?? "0"), inline: true },
      { name: "Matched Banned Account", value: String(event.matched_account ?? event.case?.matched_account ?? "n/a"), inline: false },
      { name: "Reasons", value: reasonText || "n/a", inline: false }
    )
    .setTimestamp(new Date());

  const row = caseId
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`be:${caseId}:allow`).setLabel("Allow").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`be:${caseId}:monitor`).setLabel("Monitor").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`be:${caseId}:ban`).setLabel("Ban").setStyle(ButtonStyle.Danger)
        )
      ]
    : [];
  await channel.send({ embeds: [embed], components: row });
}

async function postAntiCheatAlert(event: any): Promise<void> {
  const channel = (await getChannel(modLogChannelId)) ?? (await getChannel(overwatchChannelId));
  if (!channel) return;
  const alertId = String(event.alert_id ?? "");
  const reasons = Array.isArray(event.reasons) ? event.reasons.map((x: unknown) => String(x)) : [];
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Anti-Cheat Alert")
    .setColor(0x3b82f6)
    .addFields(
      { name: "Player", value: String(event.steam_id ?? event.player_id ?? "unknown"), inline: true },
      { name: "Match", value: String(event.match_id ?? "unknown"), inline: true },
      { name: "Score", value: String(event.score ?? event.suspicion_score ?? "0"), inline: true },
      { name: "Top Reasons", value: reasons.length ? reasons.slice(0, 5).join("\n") : "n/a", inline: false }
    )
    .setTimestamp(new Date());

  if (!alertId) {
    await channel.send({ embeds: [embed] });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ac:${alertId}:spectate`).setLabel("👀 Spectate").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ac:${alertId}:open_case`).setLabel("📁 Open Case").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ac:${alertId}:timeout`).setLabel("⚠️ Timeout (24h)").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ac:${alertId}:false_positive`).setLabel("✅ Mark False Positive").setStyle(ButtonStyle.Success)
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function postSmurfAlert(event: any): Promise<void> {
  const channel = await getChannel(modLogChannelId);
  if (!channel) return;
  const alertId = String(event.alert_id ?? "");
  const score = Number(event.score ?? 0);
  const reasons = Array.isArray(event.reasons) ? event.reasons.map((x: unknown) => String(x)) : [];
  const matched = Array.isArray(event.matched_accounts) ? event.matched_accounts.map((x: unknown) => String(x)) : [];
  const embed = new EmbedBuilder()
    .setTitle("🕵️ Smurf / Alt Alert")
    .setColor(0x3498db)
    .addFields(
      { name: "Player", value: String(event.steam_id ?? "unknown"), inline: true },
      { name: "Score", value: String(score), inline: true },
      { name: "Reasons", value: reasons.length ? reasons.slice(0, 6).join("\n") : "n/a", inline: false },
      { name: "Matched Accounts", value: matched.length ? matched.slice(0, 8).join(", ") : "none", inline: false }
    )
    .setTimestamp(new Date());
  if (!alertId) {
    await channel.send({ embeds: [embed] });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sr:${alertId}:allow`).setLabel("✅ Allow").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sr:${alertId}:monitor`).setLabel("👀 Monitor").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sr:${alertId}:open_evidence`).setLabel("🧾 Open Evidence").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sr:${alertId}:block_ranked`).setLabel("⛔ Block Ranked").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`sr:${alertId}:ban`).setLabel("🚫 Ban").setStyle(ButtonStyle.Danger)
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function postClanRequest(event: any): Promise<void> {
  const channel = await getChannel(modLogChannelId);
  if (!channel) return;
  const requestId = String(event.request_id ?? "");
  if (!requestId) return;

  const embed = new EmbedBuilder()
    .setTitle("Clan Request")
    .setColor(0x3498db)
    .addFields(
      { name: "Applicant", value: `${String(event.applicant_username ?? "Unknown")} (${String(event.applicant_steam_id ?? "n/a")})`, inline: false },
      { name: "Clan Name", value: String(event.clan_name ?? "n/a"), inline: true },
      { name: "Clan Tag", value: String(event.clan_tag ?? "n/a"), inline: true }
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`clanreq:approve:${requestId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`clanreq:reject:${requestId}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function postServerStatus(text: string): Promise<void> {
  const channel = await getChannel(serverStatusChannelId);
  if (!channel) return;
  await channel.send({ embeds: [new EmbedBuilder().setTitle("Server Status").setDescription(text)] });
}

async function postSeasonAnnouncement(event: any): Promise<void> {
  const channel = await getChannel(announcementsChannelId);
  if (!channel) return;
  if (event.type === "season_started") {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🚩 ${String(event.season_name ?? "New Season")} Started`)
          .setDescription("Ranked progression has been soft reset. Compete for seasonal rewards.")
          .addFields(
            { name: "Start", value: String(event.start_date ?? "n/a"), inline: true },
            { name: "End", value: String(event.end_date ?? "n/a"), inline: true }
          )
      ]
    });
    return;
  }
  if (event.type === "season_ended") {
    const top = Array.isArray(event.top_players) ? event.top_players : [];
    const lines = top.slice(0, 3).map((p: any) => `${p.rank}. ${p.steam_id}`);
    const topClans = Array.isArray(event.top_clans) ? event.top_clans : [];
    const clanLines = topClans.slice(0, 3).map((c: any) => `${c.rank}. ${c.clan_tag}`);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Season Results: ${String(event.season_name ?? "Season")}`)
          .setDescription([
            "**Top Players**",
            lines.join("\n") || "Top players unavailable.",
            "",
            "**Top Clans**",
            clanLines.join("\n") || "Top clans unavailable.",
            "",
            "Rewards have been distributed."
          ].join("\n"))
      ]
    });
  }
}

async function postSecurityAlert(event: any): Promise<void> {
  const channel = await getChannel(serverStatusChannelId);
  if (!channel) return;

  if (event.type === "high_request_rate_blocked") {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Security Alert")
          .setDescription(`High request rate blocked on route **${event.route}**`)
          .addFields({ name: "Source IP", value: String(event.ip ?? "unknown"), inline: true })
      ]
    });
    return;
  }

  if (event.type === "webhook_signature_failures_spike") {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Security Alert")
          .setDescription("Webhook signature failures spike detected.")
          .addFields(
            { name: "Route", value: String(event.route ?? "unknown"), inline: true },
            { name: "Count", value: String(event.count ?? "n/a"), inline: true }
          )
      ]
    });
    return;
  }

  if (event.type === "queue_join_spam_detected") {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Security Alert")
          .setDescription("Queue join spam detected and blocked.")
          .addFields(
            { name: "Player", value: String(event.player_id ?? "unknown"), inline: true },
            { name: "Mode", value: String(event.mode ?? "unknown"), inline: true }
          )
      ]
    });
    return;
  }

  if (event.type === "server_scaling_status") {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Server Status")
          .setDescription(
            `Active Servers: ${Number(event.active_servers ?? 0)}\nMatches Running: ${Number(event.active_matches ?? 0)}\nQueue Players: ${Number(event.queue_size ?? 0)}`
          )
      ]
    });
  }
}

function highlightLabel(eventType: string): string {
  const t = eventType.toLowerCase();
  if (t === "ace") return "Ace";
  if (t === "4k") return "4k";
  if (t === "clutch_1v3") return "Clutch 1v3+";
  if (t === "noscope_kill") return "NoScope kill";
  return eventType;
}

async function postHighlightMoment(event: any): Promise<void> {
  const channel = await getChannel(liveMatchesChannelId);
  if (!channel) return;
  const matchId = String(event.match_id ?? "unknown");
  const player = String(event.player_name ?? event.player_id ?? "unknown");
  const eventName = highlightLabel(String(event.event_type ?? "highlight"));
  const clipUrl = event.clip_url ? String(event.clip_url) : null;

  const embed = new EmbedBuilder()
    .setTitle("🔥 HIGHLIGHT MOMENT")
    .addFields(
      { name: "Player", value: player, inline: true },
      { name: "Event", value: eventName, inline: true },
      { name: "Match ID", value: matchId, inline: true }
    )
    .setTimestamp(new Date());

  const components = clipUrl ? [linkRow("Download Clip", clipUrl)] : [];
  await channel.send({ embeds: [embed], components });
}

async function postQueueStatus(text: string): Promise<void> {
  const channel = await getChannel(queueChannelId);
  if (!channel) return;
  await channel.send({
    embeds: [new EmbedBuilder().setTitle("Queue Update").setDescription(text)],
    components: [linkRow("Queue Status", `${publicApiUrl}/queue/status`)]
  });
}

function linkRow(label: string, url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url)
  );
}

function chunkButtons(buttons: ButtonBuilder[], size = 5): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += size) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + size)));
  }
  return rows;
}

function utcDateString(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function utcDateOffsetString(daysOffset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return utcDateString(d);
}

function msUntilNextUtcMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function voteSortWithRandomTie(a: [string, number], b: [string, number]): number {
  if (b[1] !== a[1]) return b[1] - a[1];
  return Math.random() < 0.5 ? -1 : 1;
}

async function finalizeDailyMapVote() {
  const state = dailyMapVoteState;
  if (!state) return;
  dailyMapVoteState = null;
  const disabledRows = chunkButtons(
    COMMUNITY_MAPS.map((map) =>
      new ButtonBuilder()
        .setCustomId(`dailymap:${state.voteDate}:${map}`)
        .setLabel(map.replace("de_", "").toUpperCase())
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    ),
    5
  );

  const ranked = Object.entries(state.votes).sort(voteSortWithRandomTie);
  const selected = ranked.slice(0, 5).map(([map]) => map);

  await api("/internal/maps/daily", {
    method: "POST",
    headers: { "x-bot-token": botApiToken },
    body: JSON.stringify({ date: state.targetDate, maps: selected })
  });

  const voteChannel = await getChannel(state.channelId);
  if (voteChannel) {
    const voteMessage = await voteChannel.messages.fetch(state.voteMessageId).catch(() => null);
    if (voteMessage) {
      await voteMessage.edit({ components: disabledRows }).catch(() => null);
    }
    await voteChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Daily Map Pool Finalized")
          .setDescription(`Daily voting closed. Ranked map pool for ${state.targetDate} is now locked.`)
          .addFields(
            { name: "Top 5 Maps", value: selected.map((m) => `• ${mapLabel(m)}`).join("\n") || "n/a" },
            { name: "Votes", value: ranked.map(([m, c]) => `${m}=${c}`).join(", ") || "n/a" }
          )
      ],
      components: [linkRow("Live Matches", `${publicApiUrl}/matches/live`)]
    });
  }

  const announcementChannel = await getChannel(announcementsChannelId);
  if (announcementChannel) {
    await announcementChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Today's Ranked Map Pool")
          .setDescription(selected.map((m) => `• ${mapLabel(m)}`).join("\n") || "No maps selected")
          .addFields({ name: "Date (UTC)", value: state.targetDate, inline: true })
      ]
    });
  }
}

async function startDailyMapVote() {
  const channel = await getChannel(mapVoteChannelId);
  if (!channel) return;

  const voteDate = utcDateString();
  if (dailyMapVoteState?.voteDate === voteDate) {
    return;
  }
  const targetDate = utcDateOffsetString(1);
  const embed = new EmbedBuilder()
    .setTitle("🗳️ Daily Map Vote")
    .setDescription("Vote for the maps that should be played tomorrow.")
    .addFields(
      { name: "Vote Date (UTC)", value: voteDate, inline: true },
      { name: "Pool Date (UTC)", value: targetDate, inline: true },
      { name: "Duration", value: "24 hours", inline: true }
    );

  const rows = chunkButtons(
    COMMUNITY_MAPS.map((map) =>
      new ButtonBuilder()
        .setCustomId(`dailymap:${voteDate}:${map}`)
        .setLabel(map.replace("de_", "").toUpperCase())
        .setStyle(ButtonStyle.Secondary)
    ),
    5
  );

  const voteMessage = await channel.send({ embeds: [embed], components: rows });

  const votes: Record<string, number> = {};
  COMMUNITY_MAPS.forEach((m) => (votes[m] = 0));

  dailyMapVoteState = {
    voteDate,
    targetDate,
    channelId: channel.id,
    voteMessageId: voteMessage.id,
    votes,
    votedByUser: new Map<string, Set<string>>()
  };
}

async function runDailyMapVoteRollover() {
  await finalizeDailyMapVote();
  await startDailyMapVote();
}

function scheduleDailyMapVoteLoop() {
  const delay = msUntilNextUtcMidnight();
  setTimeout(async () => {
    try {
      await runDailyMapVoteRollover();
    } catch (error) {
      console.error("daily map vote failed", error);
    } finally {
      scheduleDailyMapVoteLoop();
    }
  }, delay);
}

function mapLabel(map: string): string {
  return map.replace(/^de_/, "").replace(/_/g, " ");
}

function balanceTeamsByElo(players: Array<{ player_id: string; elo: number; region: string; timestamp: string }>, teamSize = 5) {
  const ordered = [...players].sort((a, b) => b.elo - a.elo);
  const teamA: typeof players = [];
  const teamB: typeof players = [];
  let eloA = 0;
  let eloB = 0;

  for (const p of ordered) {
    const canA = teamA.length < teamSize;
    const canB = teamB.length < teamSize;
    if (canA && (!canB || eloA <= eloB)) {
      teamA.push(p);
      eloA += p.elo;
    } else {
      teamB.push(p);
      eloB += p.elo;
    }
  }

  return { teamA, teamB };
}

function mapEmoji(map: string): string {
  const key = map.toLowerCase();
  const emojis: Record<string, string> = {
    de_mirage: "🟢",
    de_inferno: "🔴",
    de_dust2: "🟡",
    de_ancient: "🔵",
    de_nuke: "⚫",
    de_overpass: "🟣",
    de_vertigo: "🟠"
  };
  return emojis[key] ?? "🗺️";
}

function buildMapVetoRows(matchId: string, maps: string[], disabled = false): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  maps.forEach((map, idx) => {
    if (idx > 0 && idx % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`mapveto:${matchId}:${map}`)
        .setLabel(`❌ ${mapLabel(map)}`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    );
  });
  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }
  return rows;
}

function buildMapVoteRows(matchId: string, maps: string[], disabled = false): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  maps.forEach((map, idx) => {
    if (idx > 0 && idx % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`mapvote:${matchId}:${map}`)
        .setLabel(`${mapEmoji(map)} ${mapLabel(map)}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled)
    );
  });
  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }
  return rows;
}

function buildMapVoteEmbed(matchId: string, maps: string[], votes: Record<string, number>, winnerMap?: string): EmbedBuilder {
  const lines = maps.map((m) => {
    const prefix = winnerMap === m ? "🏆" : mapEmoji(m);
    return `${prefix} ${mapLabel(m)} - **${votes[m] ?? 0}**`;
  });

  return new EmbedBuilder()
    .setTitle("🗺️ Map Vote")
    .setDescription(`Vote for the map to play.\n\n${lines.join("\n")}`)
    .addFields(
      { name: "Match ID", value: matchId, inline: true },
      { name: "Status", value: winnerMap ? `Winner: ${mapEmoji(winnerMap)} ${mapLabel(winnerMap)}` : "Voting live", inline: true }
    );
}

async function createMatchVoteChannel(event: any): Promise<void> {
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId);
  const matchId = String(event.matchId ?? "unknown");
  const playerIds: string[] = Array.isArray(event.players) ? event.players : [];
  const allowedDiscordUsers = playerIds.map((id) => playerDiscordMap[id]).filter(Boolean);
  const maps: string[] = await (async () => {
    try {
      const today = await api("/maps/today");
      if (Array.isArray(today?.maps) && today.maps.length > 0) {
        return today.maps.map((m: any) => String(m));
      }
    } catch {
      // fallback below
    }
    if (Array.isArray(event.daily_map_pool) && event.daily_map_pool.length > 0) {
      return event.daily_map_pool;
    }
    return ["de_mirage", "de_inferno", "de_anubis", "de_nuke", "de_overpass"];
  })();

  await api("/internal/matches/reserve", {
    method: "POST",
    body: JSON.stringify({
      match_id: matchId,
      teamA: event.team_a ?? [],
      teamB: event.team_b ?? []
    })
  });

  const baseOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    ...(moderatorRoleId
      ? [
          {
            id: moderatorRoleId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
          }
        ]
      : []),
    ...allowedDiscordUsers.map((discordUserId) => ({
      id: discordUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
    }))
  ];

  const category = await guild.channels.create({
    name: `match-${matchId}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary match category for ${matchId}`
  });

  const chatChannel = await guild.channels.create({
    name: "match-chat",
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary match chat for ${matchId}`
  });

  const team1Voice = await guild.channels.create({
    name: "Team 1",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary Team 1 voice for ${matchId}`
  });

  const team2Voice = await guild.channels.create({
    name: "Team 2",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary Team 2 voice for ${matchId}`
  });
  const halftimeVoice = await guild.channels.create({
    name: "Halftime VC",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary Halftime voice for ${matchId}`
  });

  const embed = buildMapVoteEmbed(matchId, maps, Object.fromEntries(maps.map((m) => [m, 0])));
  const rows = buildMapVoteRows(matchId, maps, false);

  const voteMessage = await (chatChannel as TextChannel).send({ embeds: [embed], components: rows });
  eventLogger.info("map_vote_started", {
    match_id: matchId,
    channel_id: chatChannel.id,
    maps
  });

  const votes: Record<string, number> = {};
  maps.forEach((m) => {
    votes[m] = 0;
  });

  const timer = setTimeout(async () => {
    const voteState = matchVotes.get(matchId);
    if (!voteState) return;
    matchVotes.delete(matchId);

    const highest = Math.max(...(Object.values(voteState.votes) as number[]));
    const tied = Object.keys(voteState.votes).filter((m) => voteState.votes[m] === highest);
    const selectedMap = tied[Math.floor(Math.random() * tied.length)];
    eventLogger.info("map_vote_finalized", {
      match_id: matchId,
      selected_map: selectedMap,
      votes: voteState.votes
    });

    try {
      const voteMsg = await (chatChannel as TextChannel).messages.fetch(voteState.voteMessageId);
      await voteMsg.edit({
        embeds: [buildMapVoteEmbed(matchId, voteState.maps, voteState.votes, selectedMap)],
        components: buildMapVoteRows(matchId, voteState.maps, true)
      });
    } catch (error) {
      console.error("failed to finalize map vote embed", error);
    }

    const server = await serverApi("/server/start", {
      method: "POST",
      body: JSON.stringify({
        match_id: matchId,
        map: selectedMap
      })
    });

    await api("/internal/matches/activate", {
      method: "POST",
      body: JSON.stringify({
        match_id: matchId,
        map: selectedMap,
        server: {
          serverId: server.serverId ?? server.server_id,
          ip: server.ip ?? server.server_ip,
          port: server.port,
          serverPassword: server.serverPassword ?? server.server_password ?? server.password,
          spectatorPassword: server.spectatorPassword ?? server.spectator_password,
          connectString: server.connectString ?? server.connect_string
        }
      })
    });

    const connectCommand =
      server.connectString ??
      server.connect_string ??
      `connect ${server.server_ip ?? server.ip}:${server.port}; password ${server.password ?? server.server_password}`;
    await (chatChannel as TextChannel).send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Map Selected: ${mapLabel(selectedMap)}`)
          .setDescription("Server is ready.")
          .addFields(
            { name: "Winning Map", value: selectedMap, inline: true },
            {
              name: "Votes",
              value: Object.entries(voteState.votes)
                .map(([m, c]) => `${m}=${c}`)
                .join(", "),
              inline: false
            },
            { name: "Connect", value: `\`${connectCommand}\`` }
          )
      ],
      components: [linkRow("Match Info", `${publicApiUrl}/matches/${matchId}`)]
    });

    if (voteState.simulateEnd) {
      setTimeout(async () => {
        try {
          const scoreA = 13;
          const scoreB = 8;
          const winner = scoreA >= scoreB ? "A" : "B";
          const results = [...voteState.teamA, ...voteState.teamB].map((p: any) => ({
            player_id: p.player_id,
            result: (voteState.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? "win" : "loss",
            adr: (voteState.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? 100 : 75,
            mvps: (voteState.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? 2 : 0,
            kd: (voteState.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? 1.4 : 0.85
          }));

          await api(`/internal/matches/${matchId}/end`, {
            method: "POST",
            body: JSON.stringify({
              demoUrl: `${publicApiUrl}/demos/${matchId}.dem`,
              teamAScore: scoreA,
              teamBScore: scoreB,
              results
            })
          });
        } catch (error) {
          console.error("test match end simulation failed", error);
        }
      }, 30_000);
    }
  }, 15_000);

  matchVotes.set(matchId, {
    matchId,
    channelId: chatChannel.id,
    voteMessageId: voteMessage.id,
    teamA: event.team_a ?? [],
    teamB: event.team_b ?? [],
    maps,
    votes,
    votedUsers: new Set<string>(),
    allowedVoterDiscordIds: new Set<string>(allowedDiscordUsers),
    simulateEnd: Boolean(event.test_mode),
    timer
  });
  matchChannels.set(matchId, {
    categoryId: category.id,
    chatChannelId: chatChannel.id,
    team1VoiceChannelId: team1Voice.id,
    team2VoiceChannelId: team2Voice.id,
    halftimeVoiceChannelId: halftimeVoice.id,
    allowedDiscordUserIds: allowedDiscordUsers,
    playerIds,
    teamAPlayerIds: (event.team_a ?? []).map((p: any) => String(p.player_id ?? p)),
    teamBPlayerIds: (event.team_b ?? []).map((p: any) => String(p.player_id ?? p)),
    voiceLocked: false,
    halftimeActive: false
  });
}

function selectCaptains(players: Array<{ player_id: string; elo: number }>) {
  const ordered = [...players].sort((a, b) => b.elo - a.elo);
  return {
    captainA: ordered[0],
    captainB: ordered[1]
  };
}

function captainDisplay(discordId: string | null, playerId: string): string {
  return discordId ? `<@${discordId}>` : `Player ${playerId.slice(0, 8)}`;
}

function rankIcon(rank: string): string {
  const r = rank.toLowerCase();
  if (r.includes("global elite")) return "🌍";
  if (r.includes("supreme")) return "👑";
  if (r.includes("legendary eagle")) return "🦅";
  if (r.includes("master guardian") || r.includes("distinguished master guardian")) return "🛡";
  if (r.includes("gold nova")) return "🥈";
  if (r.includes("silver")) return "🥉";
  return "🎖";
}

function formatPlayerCard(card: { displayName: string; rank: string; level: number; wins: number; matchesPlayed: number }): string {
  const creator = (card as any).creatorBadge ? " ⭐ Creator" : "";
  return `**${card.displayName}**${creator} - ${rankIcon(card.rank)} ${card.rank} | Lv ${card.level}`;
}

function buildTeamField(cards: Array<{ displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>): string {
  const lines = cards.map(formatPlayerCard);
  let out = "";
  for (const line of lines) {
    const next = out.length === 0 ? line : `${out}\n${line}`;
    if (next.length > 950) {
      const shown = out.length === 0 ? 0 : out.split("\n").length;
      return `${out}\n+${Math.max(0, lines.length - shown)} more`;
    }
    out = next;
  }
  return out || "n/a";
}

function buildCaptainVetoEmbed(state: {
  matchId: string;
  mode: "ranked" | "wingman" | "casual" | "superpower" | "gungame" | "zombie" | "clanwars";
  remainingMaps: string[];
  bannedMaps: Array<{ map: string; by: "A" | "B"; playerId: string; discordId: string | null }>;
  captainA: { playerId: string; discordId: string | null };
  captainB: { playerId: string; discordId: string | null };
  teamACards: Array<{ playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>;
  teamBCards: Array<{ playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>;
  turn: number;
  totalTurns: number;
}, winnerMap?: string): EmbedBuilder {
  const available = state.remainingMaps.map((m) => `${mapEmoji(m)} ${mapLabel(m)}`).join("\n") || "n/a";
  const banned =
    state.bannedMaps.map((b) => `~~${mapLabel(b.map)}~~ by Captain ${b.by} (${captainDisplay(b.discordId, b.playerId)})`).join("\n") ||
    "None";
  const teamAField = buildTeamField(state.teamACards);
  const teamBField = buildTeamField(state.teamBCards);
  const turnCaptain = state.turn % 2 === 0 ? "A" : "B";
  const currentCaptain =
    turnCaptain === "A"
      ? captainDisplay(state.captainA.discordId, state.captainA.playerId)
      : captainDisplay(state.captainB.discordId, state.captainB.playerId);

  return new EmbedBuilder()
    .setTitle("🎮 MATCH FOUND")
    .setDescription("Map Veto Phase")
    .setColor(0x2e8b57)
    .addFields(
      { name: "Mode", value: state.mode, inline: true },
      { name: "Team A", value: teamAField, inline: false },
      { name: "Team B", value: teamBField, inline: false },
      { name: "Available Maps", value: available, inline: false },
      { name: "Banned Maps", value: banned, inline: false },
      {
        name: "Status",
        value: winnerMap
          ? `Winner: ${mapEmoji(winnerMap)} ${mapLabel(winnerMap)}`
          : `Turn ${Math.min(state.turn + 1, state.totalTurns)} / ${state.totalTurns} - Captain ${turnCaptain} (${currentCaptain})`,
        inline: false
      }
    )
    .setFooter({ text: `${state.mode === "ranked" || state.mode === "wingman" || state.mode === "clanwars" ? "Ranked Match" : "Unranked Match"} • Discord Matchmaking` })
    .setTimestamp(new Date());
}

async function finalizeCaptainVeto(matchId: string): Promise<void> {
  const state = matchVetos.get(matchId);
  if (!state) return;
  const channel = await getChannel(state.channelId);
  if (!channel) return;
  const selectedMap = state.remainingMaps[0];
  if (!selectedMap) return;

  const vetoMsg = await channel.messages.fetch(state.vetoMessageId);
  await vetoMsg.edit({
    embeds: [buildCaptainVetoEmbed(state, selectedMap)],
    components: buildMapVetoRows(matchId, state.remainingMaps, true)
  });

  eventLogger.info("map_vote_finalized", {
    match_id: matchId,
    selected_map: selectedMap,
    bans: state.bannedMaps
  });

  await channel.send({
    embeds: [new EmbedBuilder().setTitle(`🗺️ Final Map Selected: ${selectedMap}`)]
  });

  const server = await serverApi("/server/start", {
    method: "POST",
    body: JSON.stringify({
      match_id: matchId,
      map: selectedMap,
      mode: state.mode
    })
  });

  await api("/internal/matches/activate", {
    method: "POST",
    body: JSON.stringify({
      match_id: matchId,
      map: selectedMap,
      server: {
        serverId: server.serverId ?? server.server_id,
        ip: server.ip ?? server.server_ip,
        port: server.port,
        serverPassword: server.serverPassword ?? server.server_password ?? server.password,
        spectatorPassword: server.spectatorPassword ?? server.spectator_password,
        connectString: server.connectString ?? server.connect_string
      }
    })
  });

  const connectCommand =
    server.connectString ??
    server.connect_string ??
    `connect ${server.server_ip ?? server.ip}:${server.port}; password ${server.password ?? server.server_password}`;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("Server Ready")
        .setDescription("Captain veto complete. Server started.")
        .addFields(
          { name: "Mode", value: state.mode, inline: true },
          { name: "Selected Map", value: selectedMap, inline: true },
          { name: "Connect", value: `\`${connectCommand}\`` }
        )
    ],
    components: [linkRow("Match Info", `${publicApiUrl}/matches/${matchId}`)]
  });

  if (state.simulateEnd) {
    setTimeout(async () => {
      try {
        const scoreA = 13;
        const scoreB = 8;
        const winner = scoreA >= scoreB ? "A" : "B";
        const results = [...state.teamA, ...state.teamB].map((p: any) => ({
          player_id: p.player_id,
          result: (state.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? "win" : "loss",
          adr: (state.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? 100 : 75,
          mvps: (state.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? 2 : 0,
          kd: (state.teamA.find((x: any) => x.player_id === p.player_id) ? "A" : "B") === winner ? 1.4 : 0.85
        }));

        await api(`/internal/matches/${matchId}/end`, {
          method: "POST",
          body: JSON.stringify({
            demoUrl: `${publicApiUrl}/demos/${matchId}.dem`,
            teamAScore: scoreA,
            teamBScore: scoreB,
            results
          })
        });
      } catch (error) {
        console.error("test match end simulation failed", error);
      }
    }, 30_000);
  }

  matchVetos.delete(matchId);
}

async function applyCaptainBan(matchId: string, map: string, discordUserId: string): Promise<{ ok: boolean; message: string }> {
  const state = matchVetos.get(matchId);
  if (!state) return { ok: false, message: "Captain veto has ended for this match." };
  if (state.channelId === "") return { ok: false, message: "Invalid veto channel." };

  const expectedSide = state.turn % 2 === 0 ? "A" : "B";
  const expectedCaptain = expectedSide === "A" ? state.captainA : state.captainB;
  if (!expectedCaptain.discordId || expectedCaptain.discordId !== discordUserId) {
    return { ok: false, message: "It is not your turn to ban." };
  }
  if (!state.remainingMaps.includes(map)) {
    return { ok: false, message: "Map is not available for ban." };
  }

  state.remainingMaps = state.remainingMaps.filter((m) => m !== map);
  state.bannedMaps.push({ map, by: expectedSide, playerId: expectedCaptain.playerId, discordId: expectedCaptain.discordId });
  state.turn += 1;
  eventLogger.info("map_vote_cast", {
    match_id: matchId,
    map,
    by: expectedSide,
    user_id: discordUserId,
    remaining_maps: state.remainingMaps
  });

  const channel = await getChannel(state.channelId);
  if (channel) {
    const vetoMsg = await channel.messages.fetch(state.vetoMessageId);
    await vetoMsg.edit({
      embeds: [buildCaptainVetoEmbed(state)],
      components: buildMapVetoRows(matchId, state.remainingMaps, false)
    });
  }

  if (state.remainingMaps.length === 1 || state.turn >= state.totalTurns) {
    await finalizeCaptainVeto(matchId);
  }
  return { ok: true, message: `${mapLabel(map)} banned by Captain ${expectedSide}.` };
}

async function createMatchVetoChannel(event: any): Promise<void> {
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId);
  const matchId = String(event.matchId ?? "unknown");
  const mode = (String(event.mode ?? "ranked").toLowerCase() as (typeof GAME_MODES)[number]);
  const maps: string[] = [...new Set<string>(Array.isArray(event.daily_map_pool) && event.daily_map_pool.length > 0 ? event.daily_map_pool : ["de_mirage"])].slice(0, 5);
  const playerIds: string[] = Array.isArray(event.players) ? event.players : [];
  const allowedDiscordUsers = playerIds.map((id) => playerDiscordMap[id]).filter(Boolean);

  const allPlayers = [...(event.team_a ?? []), ...(event.team_b ?? [])] as Array<{ player_id: string; elo: number }>;
  if (allPlayers.length < 2) {
    throw new Error("Not enough players to choose captains");
  }
  const selected = selectCaptains(allPlayers);
  const captainA = { playerId: selected.captainA.player_id, elo: selected.captainA.elo, discordId: playerDiscordMap[selected.captainA.player_id] ?? null };
  const captainB = { playerId: selected.captainB.player_id, elo: selected.captainB.elo, discordId: playerDiscordMap[selected.captainB.player_id] ?? null };
  const playerCards = await api("/internal/player/cards", {
    method: "POST",
    headers: { "x-bot-token": botApiToken },
    body: JSON.stringify({ player_ids: allPlayers.map((p) => p.player_id) })
  });
  const cardMap = new Map<string, { playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>();
  for (const row of playerCards.cards ?? []) {
    cardMap.set(String(row.player_id), {
      playerId: String(row.player_id),
      displayName: String(row.display_name ?? `Player-${String(row.player_id).slice(0, 8)}`),
      rank: String(row.player_rank ?? "Unranked"),
      level: Number(row.level ?? 1),
      wins: Number(row.wins ?? 0),
      matchesPlayed: Number(row.matches_played ?? 0),
      creatorBadge: Boolean(row.creator_badge)
    });
  }
  const teamAPlayers = (event.team_a ?? []) as Array<{ player_id: string }>;
  const teamBPlayers = (event.team_b ?? []) as Array<{ player_id: string }>;
  const teamACards = teamAPlayers.map((p) => cardMap.get(p.player_id) ?? {
    playerId: p.player_id,
    displayName: `Player-${p.player_id.slice(0, 8)}`,
    rank: "Unranked",
    level: 1,
    wins: 0,
    matchesPlayed: 0,
    creatorBadge: false
  });
  const teamBCards = teamBPlayers.map((p) => cardMap.get(p.player_id) ?? {
    playerId: p.player_id,
    displayName: `Player-${p.player_id.slice(0, 8)}`,
    rank: "Unranked",
    level: 1,
    wins: 0,
    matchesPlayed: 0,
    creatorBadge: false
  });

  await api("/internal/matches/reserve", {
    method: "POST",
    body: JSON.stringify({
      match_id: matchId,
      mode,
      teamA: event.team_a ?? [],
      teamB: event.team_b ?? []
    })
  });

  const baseOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(moderatorRoleId
      ? [{ id: moderatorRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }]
      : []),
    ...allowedDiscordUsers.map((discordUserId) => ({
      id: discordUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    }))
  ];

  const category = await guild.channels.create({
    name: `match-${matchId}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary match category for ${matchId}`
  });

  const chatChannel = await guild.channels.create({
    name: "match-chat",
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary match chat for ${matchId}`
  });

  const team1Voice = await guild.channels.create({
    name: "Team 1",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary Team 1 voice for ${matchId}`
  });

  const team2Voice = await guild.channels.create({
    name: "Team 2",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary Team 2 voice for ${matchId}`
  });
  const halftimeVoice = await guild.channels.create({
    name: "Halftime VC",
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: baseOverwrites,
    reason: `Temporary Halftime voice for ${matchId}`
  });

  const state: {
    matchId: string;
    channelId: string;
    vetoMessageId: string;
    teamA: any[];
    teamB: any[];
    mode: "ranked" | "wingman" | "casual" | "superpower" | "gungame" | "zombie" | "clanwars";
    remainingMaps: string[];
    bannedMaps: Array<{ map: string; by: "A" | "B"; playerId: string; discordId: string | null }>;
    captainA: { playerId: string; elo: number; discordId: string | null };
    captainB: { playerId: string; elo: number; discordId: string | null };
    teamACards: Array<{ playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>;
    teamBCards: Array<{ playerId: string; displayName: string; rank: string; level: number; wins: number; matchesPlayed: number; creatorBadge: boolean }>;
    turn: number;
    totalTurns: number;
    simulateEnd: boolean;
  } = {
    matchId,
    channelId: chatChannel.id,
    vetoMessageId: "",
    teamA: event.team_a ?? [],
    teamB: event.team_b ?? [],
    mode,
    remainingMaps: maps,
    bannedMaps: [] as Array<{ map: string; by: "A" | "B"; playerId: string; discordId: string | null }>,
    captainA,
    captainB,
    teamACards,
    teamBCards,
    turn: 0,
    totalTurns: Math.min(4, Math.max(0, maps.length - 1)),
    simulateEnd: Boolean(event.test_mode)
  };
  const vetoMessage = await (chatChannel as TextChannel).send({
    embeds: [buildCaptainVetoEmbed(state)],
    components: buildMapVetoRows(matchId, maps, false)
  });
  state.vetoMessageId = vetoMessage.id;

  eventLogger.info("map_vote_started", {
    match_id: matchId,
    channel_id: chatChannel.id,
    maps,
    mode,
    captain_a: captainA.playerId,
    captain_b: captainB.playerId
  });

  matchVetos.set(matchId, state);
  matchChannels.set(matchId, {
    categoryId: category.id,
    chatChannelId: chatChannel.id,
    team1VoiceChannelId: team1Voice.id,
    team2VoiceChannelId: team2Voice.id,
    halftimeVoiceChannelId: halftimeVoice.id,
    allowedDiscordUserIds: allowedDiscordUsers,
    playerIds,
    teamAPlayerIds: teamAPlayers.map((p) => p.player_id),
    teamBPlayerIds: teamBPlayers.map((p) => p.player_id),
    voiceLocked: false,
    halftimeActive: false
  });
  await setMatchChatLocked(matchId, true);
  await movePlayersToTeamVoice(matchId);
}

const mapVoteHandler = {
  async create(event: any): Promise<void> {
    await createMatchVoteChannel(event);
  },
  async handleSlashBan(interaction: ChatInputCommandInteraction): Promise<void> {
    await handleSlashBanMap(interaction);
  },
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("mapveto:")) return false;
    const [, matchId, map] = interaction.customId.split(":");
    const state = matchVetos.get(matchId);
    if (!state) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Captain Veto").setDescription("Veto has ended for this match.")],
        ephemeral: true
      });
      return true;
    }
    if (state.channelId !== interaction.channelId) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Captain Veto").setDescription("Invalid veto channel.")],
        ephemeral: true
      });
      return true;
    }
    const result = await applyCaptainBan(matchId, map, interaction.user.id);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Captain Veto").setDescription(result.message)],
      ephemeral: true
    });
    return true;
  }
};

async function setPlayerSkin(discordId: string, steamId: string, weapon: string, skinId: string): Promise<void> {
  await api("/player/skins", {
    method: "POST",
    headers: {
      "x-bot-token": botApiToken,
      "x-discord-user-id": discordId
    },
    body: JSON.stringify({
      steam_id: steamId,
      weapon,
      skin_id: skinId
    })
  });
}

function makeSkinCategoryButtons(steamId: string): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = SKIN_CATEGORIES.map((category) =>
    new ButtonBuilder()
      .setCustomId(`skin:category:${steamId}:${category}`)
      .setLabel(prettyCategoryName(category))
      .setStyle(ButtonStyle.Secondary)
  );
  return chunkButtons(buttons, 5);
}

function makeWeaponButtons(steamId: string, category: (typeof SKIN_CATEGORIES)[number], catalog: SkinCatalogResponse): ActionRowBuilder<ButtonBuilder>[] {
  const weapons = catalog.categories[category] ?? [];
  const buttons = weapons.map((weapon) =>
    new ButtonBuilder()
      .setCustomId(`skin:weapon:${steamId}:${weapon.weapon_name}`)
      .setLabel(prettyWeaponName(weapon.weapon_name).slice(0, 40))
      .setStyle(ButtonStyle.Secondary)
  );
  return chunkButtons(buttons, 5);
}

function makeSkinButtons(steamId: string, weapon: string, catalog: SkinCatalogResponse): ActionRowBuilder<ButtonBuilder>[] {
  const all = [...catalog.categories.primary, ...catalog.categories.pistol, ...catalog.categories.knife, ...catalog.categories.gloves];
  const found = all.find((x) => x.weapon_name === weapon);
  const skins = found?.skins ?? [];
  const buttons = skins.map((skin) =>
    new ButtonBuilder()
      .setCustomId(`skin:pick:${steamId}:${weapon}:${skin.skin_id}`)
      .setLabel(skin.skin_name.slice(0, 40))
      .setStyle(ButtonStyle.Primary)
  );
  return chunkButtons(buttons, 5);
}

async function handleSlashSkins(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  await getSkinCatalog();
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Skin Selection")
        .setDescription(`Player: **${steamId}**\nChoose a category.`)
    ],
    components: makeSkinCategoryButtons(steamId),
    ephemeral: true
  });
}

function rarityColor(rarity: string): number {
  const key = rarity.toLowerCase();
  if (key === "mythic") return 0x9b59b6;
  if (key === "legendary") return 0xf39c12;
  if (key === "epic") return 0x8e44ad;
  if (key === "rare") return 0x3498db;
  return 0x95a5a6;
}

async function handleSlashOpenBox(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎁 Opening FragBox")
        .setDescription("Rolling your reward...")
        .setColor(0xf1c40f)
    ],
    ephemeral: true
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    const result = await api("/player/boxes/open", {
      method: "POST",
      headers: {
        "x-bot-token": botApiToken,
        "x-discord-user-id": interaction.user.id
      },
      body: JSON.stringify({ steam_id: steamId })
    });
    const reward = result.reward ?? {};
    const rarity = String(reward.rarity ?? "common");
    const name = String(reward.skin_name ?? "Unknown Reward");
    const rewardType = String(reward.reward_type ?? "item");
    const imageUrl = reward.image_url ? String(reward.image_url) : "";

    const reveal = new EmbedBuilder()
      .setTitle(`${rarity.charAt(0).toUpperCase()}${rarity.slice(1)} Reward`)
      .setDescription(name)
      .addFields(
        { name: "Type", value: rewardType.replace(/_/g, " "), inline: true },
        { name: "Rarity", value: rarity, inline: true },
        { name: "Unopened FragBoxes", value: String(result.unopened_boxes ?? 0), inline: true }
      )
      .setColor(rarityColor(rarity))
      .setTimestamp(new Date());
    if (imageUrl) {
      reveal.setThumbnail(imageUrl);
    }

    await interaction.editReply({
      embeds: [reveal]
    });

    if (Boolean(result.premium_battlepass_token)) {
      await interaction.followUp({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎉 Mythic Drop")
            .setDescription("You received a Premium Battle Pass Token.")
            .addFields(
              { name: "Season", value: String(reward.season_id ?? "Current Season"), inline: true },
              { name: "Rarity", value: "Mythic", inline: true },
              { name: "Next Step", value: "Use `/redeem-battlepass` to activate Premium.", inline: false }
            )
            .setColor(0x9b59b6)
        ],
        ephemeral: true
      });
    }
  } catch (error: any) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("FragBox")
          .setDescription(error?.message?.includes("404") ? "No unopened FragBox available." : "Failed to open FragBox.")
          .setColor(0xe74c3c)
      ]
    });
  }
}

async function handleSlashRedeemBattlepass(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  try {
    const result = await api("/player/battlepass/redeem", {
      method: "POST",
      headers: {
        "x-bot-token": botApiToken,
        "x-discord-user-id": interaction.user.id
      },
      body: JSON.stringify({ steam_id: steamId })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Battle Pass Redeemed")
          .setDescription(`Premium Battle Pass activated for **${String(result.season?.name ?? "current season")}**.`)
          .setColor(0x2ecc71)
      ],
      ephemeral: true
    });
  } catch (error: any) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Redeem Failed")
          .setDescription(error?.message?.includes("404") ? "No Premium Battle Pass Token available." : "Unable to redeem token.")
          .setColor(0xe74c3c)
      ],
      ephemeral: true
    });
  }
}

async function handleSlashQueue(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  const region = interaction.options.getString("region") ?? "eu";
  const mode = interaction.options.getString("mode") as GameMode | null;
  if (mode) {
    const result = await api("/internal/queue/join", {
      method: "POST",
      headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({
        steam_id: steamId,
        region,
        mode,
        discord_account_created_at: new Date(interaction.user.createdTimestamp).toISOString()
      })
    });
    const text = `Player **${steamId}** joined **${mode}** queue (${region}). Queue size: **${result.size}**${result.duplicate ? " (already queued)" : ""}`;
    await postQueueStatus(text);
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Queue").setDescription(text)],
      ephemeral: true
    });
    return;
  }
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Select Game Mode")
        .setDescription(`Choose your queue.\nPlayer ID: **${steamId}**\nRegion: **${region}**`)
    ],
    components: queueHandler.makeButtons(steamId, region),
    ephemeral: true
  });
}

async function handleSlashLeave(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  const result = await api("/internal/queue/leave", {
    method: "POST",
    headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
    body: JSON.stringify({ steam_id: steamId })
  });
  const text = `Player **${steamId}** left queue. Queue size: **${result.size}**`;
  await postQueueStatus(text);
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle("Queue").setDescription(text)],
    components: [linkRow("Queue Status", `${publicApiUrl}/queue/status`)],
    ephemeral: true
  });
}

async function handleSlashMatch(interaction: ChatInputCommandInteraction): Promise<void> {
  const matchId = interaction.options.getString("id", true);
  const match = await api(`/matches/${matchId}`);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Match ${match.id}`)
        .addFields(
          { name: "Status", value: String(match.status ?? "unknown"), inline: true },
          { name: "Map", value: String(match.map ?? "unknown"), inline: true },
          {
            name: "Players",
            value: (match.players ?? []).map((p: any) => p.display_name ?? p.id).join(", ") || "n/a"
          },
          { name: "Connect", value: `\`${match.connect_string ?? "n/a"}\`` },
          { name: "Demo", value: String(match.demo_url ?? "n/a") }
        )
    ],
    components: [linkRow("Match Info", `${publicApiUrl}/matches/${match.id}`)],
    ephemeral: true
  });
}

async function handleSlashStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  const data = await api(`/internal/player/stats/${steamId}`, {
    headers: { "x-bot-token": botApiToken }
  });
  const skins =
    (data.skins ?? []).map((s: any) => `${String(s.weapon).toUpperCase()}: ${s.skin_id}`).join("\n") || "No skins selected";
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Stats: ${data.player.display_name ?? steamId}`)
        .addFields(
          { name: "Rank", value: String(data.player.player_rank ?? "Unranked"), inline: true },
          { name: "Wins", value: String(data.stats.wins ?? 0), inline: true },
          { name: "Losses", value: String(data.stats.losses ?? 0), inline: true },
          { name: "Matches", value: String(data.stats.matches_played ?? 0), inline: true },
          { name: "Reputation", value: String(data.player.reputation_points ?? 0), inline: true },
          { name: "Bounty", value: String(data.player.bounty_score ?? 0), inline: true },
          { name: "Skins", value: skins }
        )
    ],
    ephemeral: true
  });
}

async function handleSlashSeason(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  const data = await api(`/internal/season/status/${encodeURIComponent(steamId)}`, {
    headers: { "x-bot-token": botApiToken }
  });
  const season = data.season ?? {};
  const progress = data.progress ?? {};
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Season Status: ${String(season.name ?? "Unknown Season")}`)
        .addFields(
          { name: "Season", value: `${String(season.start_date ?? "n/a")} → ${String(season.end_date ?? "n/a")}`, inline: false },
          { name: "Level", value: String(progress.season_level ?? 1), inline: true },
          { name: "Season XP", value: String(progress.season_xp ?? 0), inline: true },
          { name: "XP to Next", value: String(progress.xp_to_next_level ?? 0), inline: true },
          { name: "Leaderboard Rank", value: data.leaderboard_rank ? `#${data.leaderboard_rank}` : "Unranked", inline: true },
          { name: "Wins", value: String(progress.wins ?? 0), inline: true },
          { name: "Matches", value: String(progress.matches ?? 0), inline: true }
        )
    ],
    ephemeral: true
  });
}

async function handleSlashSeasonLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const data = await api("/internal/season/leaderboard?limit=10", {
    headers: { "x-bot-token": botApiToken }
  });
  const lines = (data.leaderboard ?? []).map(
    (row: any) =>
      `#${row.rank} ${row.display_name ?? row.steam_id} | MMR ${row.mmr} | W ${row.wins} | M ${row.matches}`
  );
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`🏆 ${String(data.season?.name ?? "Season")} Leaderboard`)
        .setDescription(lines.join("\n") || "No leaderboard data yet.")
    ],
    ephemeral: true
  });
}

function resolveLinkedPlayerId(discordId: string): string | null {
  for (const [playerId, mappedDiscordId] of Object.entries(playerDiscordMap)) {
    if (mappedDiscordId === discordId) return playerId;
  }
  return null;
}

function streamerLobbyEmbed(lobby: {
  streamerName: string;
  mode: GameMode;
  players: Array<{ discordId: string }>;
  requiredPlayers: number;
  status: "open" | "starting" | "live";
  matchId?: string;
}): EmbedBuilder {
  const joined = lobby.players.map((p) => `<@${p.discordId}>`).join(", ");
  const status =
    lobby.status === "open"
      ? "Waiting for players"
      : lobby.status === "starting"
      ? "Lobby full, starting match..."
      : `Match created: ${lobby.matchId ?? "pending"}`;

  return new EmbedBuilder()
    .setTitle("🎥 STREAMER MATCH")
    .setColor(0x00b894)
    .addFields(
      { name: "Streamer name", value: lobby.streamerName, inline: true },
      { name: "Game mode", value: lobby.mode, inline: true },
      { name: "Players joined", value: `${lobby.players.length}/${lobby.requiredPlayers}`, inline: true },
      { name: "Lobby", value: joined || "No players yet", inline: false },
      { name: "Status", value: status, inline: false }
    )
    .setTimestamp(new Date());
}

function streamerLobbyButtons(lobby: { lobbyId: string; streamUrl: string; status: "open" | "starting" | "live" }) {
  const joinDisabled = lobby.status !== "open";
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`streamer:join:${lobby.lobbyId}`)
        .setLabel("Join Lobby")
        .setStyle(ButtonStyle.Success)
        .setDisabled(joinDisabled),
      new ButtonBuilder()
        .setCustomId(`streamer:spectate:${lobby.lobbyId}`)
        .setLabel("Spectate")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Watch Stream").setURL(lobby.streamUrl)
    )
  ];
}

async function updateStreamerLobbyMessage(lobbyId: string): Promise<void> {
  const lobby = streamerLobbies.get(lobbyId);
  if (!lobby) return;
  const channel = await getChannel(lobby.channelId);
  if (!channel) return;
  const message = await channel.messages.fetch(lobby.messageId);
  await message.edit({
    embeds: [streamerLobbyEmbed(lobby)],
    components: streamerLobbyButtons(lobby)
  });
}

async function startStreamerLobbyMatch(lobbyId: string): Promise<void> {
  const lobby = streamerLobbies.get(lobbyId);
  if (!lobby) return;
  if (lobby.status !== "open") return;
  if (lobby.players.length < lobby.requiredPlayers) return;

  lobby.status = "starting";
  await updateStreamerLobbyMessage(lobbyId);

  const cfg = MODE_CONFIG[lobby.mode];
  const selectedPlayers = lobby.players.slice(0, lobby.requiredPlayers);
  const entries = selectedPlayers.map((p) => ({
    player_id: p.playerId,
    elo: p.elo,
    region: p.region,
    timestamp: p.joinedAt
  }));
  const { teamA, teamB } = balanceTeamsByElo(entries, cfg.teamSize);
  const mapsData = await api("/maps/daily");
  const matchId = crypto.randomUUID();
  try {
    await mapVoteHandler.create({
      matchId,
      mode: lobby.mode,
      players: entries.map((x) => x.player_id),
      team_a: teamA,
      team_b: teamB,
      daily_map_pool: mapsData.maps
    });
    await api(`/internal/matches/${matchId}/creator-stream`, {
      method: "POST",
      body: JSON.stringify({
        stream_url: lobby.streamUrl
      })
    });

    lobby.status = "live";
    lobby.matchId = matchId;
    streamerMatches.set(matchId, {
      streamerName: lobby.streamerName,
      streamUrl: lobby.streamUrl,
      lobbyId: lobby.lobbyId
    });
    await updateStreamerLobbyMessage(lobbyId);
  } catch (error) {
    lobby.status = "open";
    await updateStreamerLobbyMessage(lobbyId);
    const channel = await getChannel(lobby.channelId);
    if (channel) {
      await channel.send({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("Failed to start match from lobby. Try again.")]
      });
    }
    throw error;
  }
}

const streamerHandler = {
  async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "lobby") {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("Unsupported streamer action.")],
        ephemeral: true
      });
      return;
    }

    const existing = Array.from(streamerLobbies.values()).find(
      (l) => l.streamerDiscordId === interaction.user.id && l.status !== "live"
    );
    if (existing) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("You already have an active lobby.")],
        ephemeral: true
      });
      return;
    }

    const linkedPlayerId = resolveLinkedPlayerId(interaction.user.id);
    if (!linkedPlayerId) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("No linked player account found for this Discord user.")],
        ephemeral: true
      });
      return;
    }

    const mode = (interaction.options.getString("mode") ?? "ranked") as GameMode;
    const streamUrlRaw = interaction.options.getString("stream_url") ?? publicApiUrl;
    let streamUrl = streamUrlRaw;
    try {
      const parsed = new URL(streamUrlRaw);
      streamUrl = parsed.toString();
    } catch {
      streamUrl = publicApiUrl;
    }
    const requiredPlayers = MODE_CONFIG[mode].playersPerMatch;
    const lobbyId = crypto.randomUUID();
    const channel = interaction.channel && interaction.channel.isTextBased()
      ? (interaction.channel as TextChannel)
      : await getChannel(queueChannelId);

    if (!channel) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("No available channel for lobby creation.")],
        ephemeral: true
      });
      return;
    }

    const lobby = {
      lobbyId,
      streamerDiscordId: interaction.user.id,
      streamerName: interaction.user.username,
      streamUrl,
      mode,
      requiredPlayers,
      players: [
        {
          discordId: interaction.user.id,
          playerId: linkedPlayerId,
          elo: 1000,
          region: "eu",
          joinedAt: new Date().toISOString()
        }
      ],
      channelId: channel.id,
      messageId: "",
      status: "open" as const
    };

    const msg = await channel.send({
      embeds: [streamerLobbyEmbed(lobby)],
      components: streamerLobbyButtons(lobby)
    });
    lobby.messageId = msg.id;
    streamerLobbies.set(lobbyId, lobby);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Streamer Lobby Created")
          .setDescription(`Lobby created in <#${channel.id}>. Viewers can now join.`)
      ],
      ephemeral: true
    });
  },
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("streamer:")) return false;
    const [, action, lobbyId] = interaction.customId.split(":");
    const lobby = streamerLobbies.get(lobbyId);
    if (!lobby) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("Lobby no longer exists.")],
        ephemeral: true
      });
      return true;
    }

    if (action === "join") {
      if (lobby.status !== "open") {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("Lobby is already starting.")],
          ephemeral: true
        });
        return true;
      }
      const linkedPlayerId = resolveLinkedPlayerId(interaction.user.id);
      if (!linkedPlayerId) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("Your Discord account is not linked to a player.")],
          ephemeral: true
        });
        return true;
      }
      if (lobby.players.some((p) => p.playerId === linkedPlayerId)) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription("You are already in this lobby.")],
          ephemeral: true
        });
        return true;
      }

      lobby.players.push({
        discordId: interaction.user.id,
        playerId: linkedPlayerId,
        elo: 1000,
        region: "eu",
        joinedAt: new Date().toISOString()
      });
      await updateStreamerLobbyMessage(lobbyId);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Streamer Lobby").setDescription(`Joined lobby: ${lobby.players.length}/${lobby.requiredPlayers}`)],
        ephemeral: true
      });

      if (lobby.players.length >= lobby.requiredPlayers) {
        await startStreamerLobbyMatch(lobbyId);
      }
      return true;
    }

    if (action === "spectate") {
      if (!lobby.matchId) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Spectate").setDescription("No live match yet. Spectate becomes available after match start.")],
          ephemeral: true
        });
        return true;
      }
      const match = await api(`/matches/${lobby.matchId}`);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Spectate")
            .setDescription(match.connect_string ? `\`${match.connect_string}\`` : "Connect string not available yet.")
        ],
        ephemeral: true
      });
      return true;
    }

    return false;
  }
};

const creatorMatchHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("creator:")) return false;
    const [, action, matchId] = interaction.customId.split(":");
    if (!matchId) return false;
    const meta = creatorMatchesLive.get(matchId);

    if (action === "spectate") {
      const spectate = meta?.spectate ?? "Spectate command unavailable.";
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Creator Match Spectate").setDescription(`\`${spectate}\``)],
        ephemeral: true
      });
      return true;
    }

    if (action === "joinnext") {
      const steamId = await requireVerifiedDiscordUser(interaction.user.id);
      if (!steamId) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Creator Match").setDescription("Verify and link Steam first.")],
          ephemeral: true
        });
        return true;
      }

      const mode = meta?.mode ?? "ranked";
      const join = await api("/internal/queue/join", {
        method: "POST",
        headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
        body: JSON.stringify({
          steam_id: steamId,
          region: "eu",
          mode,
          discord_account_created_at: new Date(interaction.user.createdTimestamp).toISOString()
        })
      });

      let rewardNote = "";
      if (Math.random() < 0.4) {
        try {
          const viewerReward = await api("/internal/creator/viewer-reward", {
            method: "POST",
            headers: { "x-bot-token": botApiToken },
            body: JSON.stringify({
              viewer_steam_id: steamId,
              viewer_discord_id: interaction.user.id,
              creator_steam_id: meta?.creatorSteamId ?? undefined,
              match_id: matchId
            })
          });
          rewardNote = `\nViewer reward granted: **${String(viewerReward.reward_type ?? "reward")}**`;
        } catch {
          // no-op: reward rollout is best effort
        }
      }

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Creator Match")
            .setDescription(`You joined **${mode}** queue. Queue size: **${join.size ?? "?"}**${rewardNote}`)
        ],
        ephemeral: true
      });
      return true;
    }

    return false;
  }
};

const queueHandler = {
  makeButtons(steamId: string, region: string): ActionRowBuilder<ButtonBuilder>[] {
    const buttons = [
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:ranked`).setLabel("Ranked 5v5").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:wingman`).setLabel("Wingman 2v2").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:casual`).setLabel("Casual 10v10").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:superpower`).setLabel("Superpower Mode").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:gungame`).setLabel("Gun Game").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:zombie`).setLabel("Zombie Mode").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`queue:joinmode:${steamId}:${region}:clanwars`).setLabel("Clan Wars 5v5").setStyle(ButtonStyle.Success)
    ];
    return chunkButtons(buttons, 2);
  },
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("queue:")) return false;
    const [, action, steamId, regionMaybe, modeMaybe] = interaction.customId.split(":");
    if (!steamId) return false;

    if (action === "join") {
      const region = regionMaybe ?? "eu";
      const result = await api("/internal/queue/join", {
        method: "POST",
        headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
        body: JSON.stringify({
          steam_id: steamId,
          region,
          discord_account_created_at: new Date(interaction.user.createdTimestamp).toISOString()
        })
      });
      const text = `Player **${steamId}** joined queue (${region}). Queue size: **${result.size}**${result.duplicate ? " (already queued)" : ""}`;
      await postQueueStatus(text);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Queue").setDescription(text)],
        ephemeral: true
      });
      return true;
    }

    if (action === "joinmode") {
      const region = regionMaybe ?? "eu";
      const mode = (modeMaybe ?? "ranked") as (typeof GAME_MODES)[number];
      const result = await api("/internal/queue/join", {
        method: "POST",
        headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
        body: JSON.stringify({
          steam_id: steamId,
          region,
          mode,
          discord_account_created_at: new Date(interaction.user.createdTimestamp).toISOString()
        })
      });
      const text = `Player **${steamId}** joined **${mode}** queue (${region}). Queue size: **${result.size}**${result.duplicate ? " (already queued)" : ""}`;
      await postQueueStatus(text);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Queue").setDescription(text)],
        ephemeral: true
      });
      return true;
    }

    if (action === "leave") {
      const mode = (regionMaybe ?? "ranked") as (typeof GAME_MODES)[number];
      const result = await api("/internal/queue/leave", {
        method: "POST",
        headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
        body: JSON.stringify({ steam_id: steamId, mode })
      });
      const text = `Player **${steamId}** left **${mode}** queue. Queue size: **${result.size}**`;
      await postQueueStatus(text);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Queue").setDescription(text)],
        ephemeral: true
      });
      return true;
    }

    if (action === "stats") {
      const data = await api(`/internal/player/stats/${steamId}`, {
        headers: { "x-bot-token": botApiToken }
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Stats: ${data.player.display_name ?? steamId}`)
            .addFields(
              { name: "Rank", value: String(data.player.player_rank ?? "Unranked"), inline: true },
              { name: "Wins", value: String(data.stats.wins ?? 0), inline: true },
              { name: "Losses", value: String(data.stats.losses ?? 0), inline: true },
              { name: "Matches", value: String(data.stats.matches_played ?? 0), inline: true }
            )
        ],
        ephemeral: true
      });
      return true;
    }
    return false;
  }
};

async function handleSlashReport(interaction: ChatInputCommandInteraction): Promise<void> {
  const reporterSteamId = await ensureVerifiedAccess(interaction);
  if (!reporterSteamId) return;
  const reportedSteamId = interaction.options.getString("reported_steamid", true);
  const matchId = interaction.options.getString("match_id", true);
  const token = crypto.randomBytes(5).toString("hex");
  pendingReportContexts.set(token, {
    reporterSteamId,
    reportedSteamId,
    matchId,
    createdAt: Date.now()
  });
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Report Player")
        .addFields(
          { name: "Match", value: matchId, inline: true },
          { name: "Reporter", value: reporterSteamId, inline: true },
          { name: "Reported Player", value: reportedSteamId, inline: true }
        )
    ],
    components: reportHandler.makeReasonButtons(token),
    ephemeral: true
  });
}

async function handleSlashLinkSteam(interaction: ChatInputCommandInteraction): Promise<void> {
  const alreadyVerified = await requireVerifiedDiscordUser(interaction.user.id);
  if (alreadyVerified) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Verification").setDescription(`Already verified as **${alreadyVerified}**.`)],
      ephemeral: true
    });
    return;
  }
  const started = await api("/internal/steam-link/start", {
    method: "POST",
    body: JSON.stringify({ discord_id: interaction.user.id })
  });
  const url = String(started.verify_url ?? started.url ?? "");
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Link Steam")
        .setDescription("Open your unique verification link and log in with Steam OpenID.")
    ],
    components: url ? [linkRow("Verify with Steam", url)] : [],
    ephemeral: true
  });
}

async function setDiscordNicknameSafe(discordId: string, username: string): Promise<void> {
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  await member.setNickname(username).catch((error) => {
    eventLogger.error("nickname_update_failed", {
      discord_id: discordId,
      reason: error instanceof Error ? error.message : "unknown"
    });
  });
}

type PlayerIdentity = {
  username: string;
  clan_tag: string | null;
  staff_tag: string | null;
  selected_tag_type: "dev" | "admin" | "mod" | "clan" | "none";
  available_tag_types: Array<"dev" | "admin" | "mod" | "clan" | "none">;
  display_name: string;
};

async function fetchPlayerIdentity(steamId: string): Promise<PlayerIdentity | null> {
  try {
    const identity = await api(`/internal/player/profile?steam_id=${encodeURIComponent(steamId)}`);
    return {
      username: String(identity.username ?? ""),
      clan_tag: identity.clan_tag ? String(identity.clan_tag) : null,
      staff_tag: identity.staff_tag ? String(identity.staff_tag) : null,
      selected_tag_type: String(identity.selected_tag_type ?? "none") as PlayerIdentity["selected_tag_type"],
      available_tag_types: Array.isArray(identity.available_tag_types)
        ? identity.available_tag_types.map((x: unknown) => String(x) as PlayerIdentity["available_tag_types"][number])
        : ["none"],
      display_name: String(identity.display_name ?? identity.username ?? "")
    };
  } catch {
    return null;
  }
}

async function refreshDiscordNicknameFromSteam(discordId: string, steamId: string): Promise<void> {
  const identity = await fetchPlayerIdentity(steamId);
  if (!identity?.display_name) return;
  await setDiscordNicknameSafe(discordId, identity.display_name);
}

function tagTypeLabel(type: PlayerIdentity["selected_tag_type"]): string {
  if (type === "dev") return "Developer Tag";
  if (type === "admin") return "Admin Tag";
  if (type === "mod") return "Moderator Tag";
  if (type === "clan") return "Clan Tag";
  return "No Tag";
}

function tagTypeButtonStyle(type: PlayerIdentity["selected_tag_type"]): ButtonStyle {
  if (type === "dev") return ButtonStyle.Primary;
  if (type === "admin") return ButtonStyle.Danger;
  if (type === "mod") return ButtonStyle.Secondary;
  if (type === "clan") return ButtonStyle.Success;
  return ButtonStyle.Secondary;
}

function buildTagSelectionRows(steamId: string, identity: PlayerIdentity): ActionRowBuilder<ButtonBuilder>[] {
  const ordered: Array<PlayerIdentity["selected_tag_type"]> = ["dev", "admin", "mod", "clan", "none"];
  const available = new Set(identity.available_tag_types);
  const buttons = ordered
    .filter((type) => available.has(type))
    .map((type) =>
      new ButtonBuilder()
        .setCustomId(`tag:set:${steamId}:${type}`)
        .setLabel(tagTypeLabel(type))
        .setStyle(tagTypeButtonStyle(type))
        .setDisabled(identity.selected_tag_type === type)
    );
  return chunkButtons(buttons, 2);
}

async function handleSlashVerify(interaction: ChatInputCommandInteraction): Promise<void> {
  const alreadyVerified = await requireVerifiedDiscordUser(interaction.user.id);
  if (alreadyVerified) {
    const status = await getVerificationStatus(interaction.user.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Verification")
          .setDescription(
            status.username
              ? `Already verified as **${alreadyVerified}** with username **${status.username}**.`
              : `Already verified as **${alreadyVerified}**. Please choose username with **/username <name>**.`
          )
      ],
      ephemeral: true
    });
    return;
  }

  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const challengeId = crypto.randomBytes(8).toString("hex");
  pendingVerificationCaptchas.set(challengeId, {
    discordId: interaction.user.id,
    answer: a + b,
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  const prompt = makeCaptchaPrompt(a, b, challengeId);
  await interaction.reply({ ...prompt, ephemeral: true });
}

async function handleSlashUsername(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await requireVerifiedDiscordUser(interaction.user.id);
  if (!steamId) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Username").setDescription("Verify first using **/verify** and **/linksteam**.")],
      ephemeral: true
    });
    return;
  }

  const username = interaction.options.getString("name", true).trim();
  const result = await api("/internal/player/username", {
    method: "POST",
    headers: { "x-discord-user-id": interaction.user.id },
    body: JSON.stringify({ username })
  });

  const finalName = String(result.username ?? username);
  await refreshDiscordNicknameFromSteam(interaction.user.id, steamId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Username Set")
        .setDescription(`Your username is now **${finalName}**.\nYou can join matchmaking now.`)
        .addFields({ name: "Steam ID", value: steamId, inline: true })
    ],
    ephemeral: true
  });
}

async function handleSlashUsernameChange(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await requireVerifiedDiscordUser(interaction.user.id);
  if (!steamId) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Username Change").setDescription("Verify first using **/verify** and **/linksteam**.")],
      ephemeral: true
    });
    return;
  }

  const username = interaction.options.getString("newname", true).trim();
  const result = await api("/internal/player/username/change", {
    method: "POST",
    headers: { "x-discord-user-id": interaction.user.id },
    body: JSON.stringify({ username })
  });

  const finalName = String(result.username ?? username);
  await refreshDiscordNicknameFromSteam(interaction.user.id, steamId);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Username Updated")
        .setDescription(`Your new username is **${finalName}**.`)
        .addFields({ name: "Steam ID", value: steamId, inline: true })
    ],
    ephemeral: true
  });
}

async function handleSlashClan(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  const sub = interaction.options.getSubcommand(true);

  if (sub === "create") {
    const clanName = interaction.options.getString("name", true);
    const clanTag = interaction.options.getString("tag", true);
    const result = await api("/internal/clan/create-request", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({ clan_name: clanName, clan_tag: clanTag })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Clan Request Submitted")
          .setDescription("Your clan request was sent for admin approval.")
          .addFields(
            { name: "Clan Name", value: String(result.clan_name ?? clanName), inline: true },
            { name: "Clan Tag", value: String(result.clan_tag ?? clanTag).toUpperCase(), inline: true },
            { name: "Status", value: "Pending", inline: true }
          )
      ],
      ephemeral: true
    });
    return;
  }

  if (sub === "join") {
    const tag = interaction.options.getString("tag", true);
    const result = await api("/internal/clan/join-request", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({ clan_tag: tag })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Join Request Sent")
          .setDescription(`Your join request for **[${result.clan_tag}] ${result.clan_name}** is pending owner approval.`)
      ],
      ephemeral: true
    });
    const ownerDiscordId = String(result.owner_discord_id ?? "");
    if (ownerDiscordId) {
      const owner = await client.users.fetch(ownerDiscordId).catch(() => null);
      if (owner) {
        await owner
          .send(
            `Clan join request: <@${interaction.user.id}> requested to join **[${result.clan_tag}] ${result.clan_name}**.\nApprove with \`/clan approve ${steamId}\``
          )
          .catch(() => null);
      }
    }
    return;
  }

  if (sub === "approve") {
    const player = interaction.options.getString("player", true);
    const result = await api("/internal/clan/approve-member", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({ player })
    });
    await ensureClanDiscordResources(String(result.clan_tag));
    if (result.player_discord_id) {
      await addClanRoleToDiscordUser(String(result.player_discord_id), String(result.clan_tag));
      await refreshDiscordNicknameFromSteam(String(result.player_discord_id), String(result.player_steam_id));
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Clan Member Approved")
          .setDescription(`Approved **${result.player_steam_id}** for **[${result.clan_tag}] ${result.clan_name}**.`)
      ],
      ephemeral: true
    });
    return;
  }

  if (sub === "invite") {
    const player = interaction.options.getString("player", true);
    const result = await api("/internal/clan/invite", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({ player })
    });
    await ensureClanDiscordResources(String(result.clan_tag));
    if (result.player_discord_id) {
      await addClanRoleToDiscordUser(String(result.player_discord_id), String(result.clan_tag));
      await refreshDiscordNicknameFromSteam(String(result.player_discord_id), String(result.player_steam_id));
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Clan Invite Applied")
          .setDescription(`Added **${result.player_steam_id}** to **[${result.clan_tag}] ${result.clan_name}**.`)
      ],
      ephemeral: true
    });
    return;
  }

  if (sub === "kick") {
    const player = interaction.options.getString("player", true);
    const result = await api("/internal/clan/kick", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({ player })
    });
    if (result.player_discord_id) {
      await removeClanRolesFromDiscordUser(String(result.player_discord_id));
      await refreshDiscordNicknameFromSteam(String(result.player_discord_id), String(result.player_steam_id));
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Clan Member Removed")
          .setDescription(`Removed **${result.player_steam_id}** from **[${result.clan_tag}] ${result.clan_name}**.`)
      ],
      ephemeral: true
    });
    return;
  }

  if (sub === "leave") {
    const result = await api("/internal/clan/leave", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id }
    });
    await removeClanRolesFromDiscordUser(interaction.user.id);
    if (Boolean(result.disbanded) && result.clan_tag) {
      await cleanupClanDiscordResources(String(result.clan_tag));
    }
    await refreshDiscordNicknameFromSteam(interaction.user.id, steamId);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(result.disbanded ? "Clan Disbanded" : "Clan Left")
          .setDescription(
            result.disbanded
              ? `You disbanded **[${result.clan_tag}] ${result.clan_name}**.`
              : `You left **[${result.clan_tag}] ${result.clan_name}**.`
          )
      ],
      ephemeral: true
    });
    return;
  }

  if (sub === "leaderboard") {
    const data = await api("/internal/clan/leaderboard?limit=10");
    const lines = (data.leaderboard ?? []).map(
      (row: any) =>
        `#${row.rank} ${String(row.clan_tag)} - Rating: ${row.rating} (W:${row.wins} L:${row.losses} M:${row.matches_played})`
    );
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Clan Leaderboard")
          .setDescription(lines.join("\n") || "No clan data yet.")
      ],
      ephemeral: true
    });
    return;
  }

  if (sub === "info") {
    const tag = interaction.options.getString("tag");
    const qs = tag ? `tag=${encodeURIComponent(tag)}` : `steam_id=${encodeURIComponent(steamId)}`;
    const data = await api(`/internal/clan/info?${qs}`);
    const members = (data.members ?? [])
      .slice(0, 10)
      .map((m: any) => `${m.role === "owner" ? "👑" : "•"} ${m.username ?? m.steam_id}`)
      .join("\n");
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`[${data.clan.clan_tag}] ${data.clan.clan_name}`)
          .addFields(
            { name: "Clan Name", value: String(data.clan.clan_name), inline: true },
            { name: "Clan Tag", value: String(data.clan.clan_tag), inline: true },
            { name: "Owner", value: String(data.clan.owner_steam_id), inline: true },
            { name: "Rating", value: String(data.rating.rating ?? 1000), inline: true },
            { name: "Rank", value: data.rating.rank ? `#${data.rating.rank}` : "Unranked", inline: true },
            { name: "W/L", value: `${data.rating.wins ?? 0}/${data.rating.losses ?? 0}`, inline: true },
            { name: "Matches", value: String(data.rating.matches_played ?? 0), inline: true },
            { name: "Members", value: members || "None", inline: false }
          )
      ],
      ephemeral: true
    });
    return;
  }
}

async function handleSlashTag(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await ensureVerifiedAccess(interaction);
  if (!steamId) return;
  const identity = await fetchPlayerIdentity(steamId);
  if (!identity) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Tag Selection").setDescription("Profile not found.")],
      ephemeral: true
    });
    return;
  }

  const availableText = identity.available_tag_types.map((x) => tagTypeLabel(x)).join(", ");
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Tag Selection")
        .setDescription("Choose which tag to display.")
        .addFields(
          { name: "Current", value: tagTypeLabel(identity.selected_tag_type), inline: true },
          { name: "Preview", value: identity.display_name || identity.username, inline: true },
          { name: "Available Options", value: availableText || "No Tag", inline: false }
        )
    ],
    components: buildTagSelectionRows(steamId, identity),
    ephemeral: true
  });
}

const reportHandler = {
  makeReasonButtons(token: string): ActionRowBuilder<ButtonBuilder>[] {
    const reasons = ["cheating", "griefing", "toxic", "afk"] as const;
    const buttons = reasons.map((reason) =>
      new ButtonBuilder()
        .setCustomId(`report:reason:${token}:${reason}`)
        .setLabel(reason.toUpperCase())
        .setStyle(ButtonStyle.Secondary)
    );
    return chunkButtons(buttons, 4);
  },
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("report:reason:")) return false;
    const [, , token, reason] = interaction.customId.split(":");
    const ctx = pendingReportContexts.get(token);
    if (!ctx) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Report").setDescription("Report context expired. Please run /report again.")],
        ephemeral: true
      });
      return true;
    }
    const res = await api("/internal/report", {
      method: "POST",
      headers: { "x-bot-token": botApiToken, "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({
        reporter_steam_id: ctx.reporterSteamId,
        reported_steam_id: ctx.reportedSteamId,
        match_id: ctx.matchId,
        reason
      })
    });
    pendingReportContexts.delete(token);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("Report Submitted")
          .addFields(
            { name: "Match", value: ctx.matchId, inline: true },
            { name: "Reported", value: ctx.reportedSteamId, inline: true },
            { name: "Reason", value: reason, inline: true },
            { name: "Report Score", value: String(res.report_score ?? 0), inline: true }
          )
      ],
      components: []
    });
    return true;
  }
};

const moderationHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("ow:")) return false;
    if (!modJwt) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Overwatch").setDescription("DISCORD_MOD_JWT is not configured.")],
        ephemeral: true
      });
      return true;
    }

    const [, caseId, action] = interaction.customId.split(":");
    const cases = await api("/overwatch/cases", {
      headers: { authorization: `Bearer ${modJwt}` }
    });
    const found = (cases ?? []).find((c: any) => String(c.case_id ?? c.id) === caseId);
    if (!found) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Overwatch").setDescription("Case not found.")],
        ephemeral: true
      });
      return true;
    }

    if (action === "spectate") {
      let spectate = found.spectate_command as string | null;
      if (!spectate && found.match_id) {
        const match = await api(`/matches/${found.match_id}`);
        spectate = match?.connection_data?.spectator_password
          ? `connect ${match.connection_data.server_ip}:${match.connection_data.port}; password ${match.connection_data.spectator_password}`
          : null;
      }
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Overwatch").setDescription(spectate ? `\`${spectate}\`` : "No live spectate available.")],
        ephemeral: true
      });
      return true;
    }

    if (action === "timeout") {
      await api("/timeout", {
        method: "POST",
        headers: { authorization: `Bearer ${modJwt}` },
        body: JSON.stringify({ player_id: found.player_id, hours: 24 })
      });
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Overwatch").setDescription(`Applied 24h timeout to ${found.player_id}.`)],
        ephemeral: true
      });
      return true;
    }

    if (action === "ban") {
      await api("/ban", {
        method: "POST",
        headers: { authorization: `Bearer ${modJwt}` },
        body: JSON.stringify({ player_id: found.player_id, permanent: true })
      });
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Overwatch").setDescription(`Applied permanent ban to ${found.player_id}.`)],
        ephemeral: true
      });
      return true;
    }

    if (action === "clean") {
      await api("/cases/vote", {
        method: "POST",
        headers: { authorization: `Bearer ${modJwt}` },
        body: JSON.stringify({ case_id: caseId, vote: "clean" })
      });
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Overwatch").setDescription(`Submitted clean vote for case ${caseId}.`)],
        ephemeral: true
      });
      return true;
    }

    return false;
  }
};

const clanRequestHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("clanreq:")) return false;
    if (!isModeratorButtonInteraction(interaction)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Clan Request").setDescription("Moderator role required.")],
        ephemeral: true
      });
      return true;
    }
    const [, action, requestId] = interaction.customId.split(":");
    if (!requestId || !["approve", "reject"].includes(action)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Clan Request").setDescription("Invalid request action.")],
        ephemeral: true
      });
      return true;
    }

    const endpoint =
      action === "approve"
        ? `/internal/clan/request/${requestId}/approve`
        : `/internal/clan/request/${requestId}/reject`;
    const payload = action === "reject" ? { reason: `Rejected by ${interaction.user.username}` } : undefined;
    const result = await api(endpoint, {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: payload ? JSON.stringify(payload) : undefined
    });

    if (action === "approve" && result.owner_steam_id && result.owner_discord_id) {
      await ensureClanDiscordResources(String(result.clan_tag));
      await addClanRoleToDiscordUser(String(result.owner_discord_id), String(result.clan_tag));
      await refreshDiscordNicknameFromSteam(String(result.owner_discord_id), String(result.owner_steam_id));
    }

    const updated = new EmbedBuilder(interaction.message.embeds[0]?.toJSON() ?? {})
      .setColor(action === "approve" ? 0x2ecc71 : 0xe74c3c)
      .setFooter({ text: `Decision: ${action.toUpperCase()} by ${interaction.user.username}` })
      .setTimestamp(new Date());
    await interaction.update({ embeds: [updated], components: [] });
    return true;
  }
};

const tagHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("tag:set:")) return false;
    const [, , steamId, selectedTagType] = interaction.customId.split(":");
    if (!steamId || !selectedTagType) return false;

    const verifiedSteamId = await ensureVerifiedAccess(interaction);
    if (!verifiedSteamId) return true;
    if (verifiedSteamId !== steamId) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Tag Selection").setDescription("You cannot change another player's tag.")],
        ephemeral: true
      });
      return true;
    }

    const result = await api("/internal/player/tag", {
      method: "POST",
      headers: { "x-discord-user-id": interaction.user.id },
      body: JSON.stringify({ selected_tag_type: selectedTagType })
    });
    await refreshDiscordNicknameFromSteam(interaction.user.id, steamId);
    const identity = await fetchPlayerIdentity(steamId);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("Tag Updated")
          .setDescription(`Selected tag: **${tagTypeLabel(String(result.selected_tag_type ?? selectedTagType) as PlayerIdentity["selected_tag_type"])}**`)
          .addFields(
            { name: "Preview", value: identity?.display_name ?? String(result.display_name ?? "updated"), inline: true }
          )
      ],
      components: identity ? buildTagSelectionRows(steamId, identity) : []
    });
    return true;
  }
};

const banEvasionHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("be:")) return false;
    if (!modJwt) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Ban Evasion").setDescription("DISCORD_MOD_JWT is not configured.")],
        ephemeral: true
      });
      return true;
    }
    if (!isModeratorButtonInteraction(interaction)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Ban Evasion").setDescription("Moderator role required.")],
        ephemeral: true
      });
      return true;
    }

    const [, caseId, action] = interaction.customId.split(":");
    if (!caseId || !["allow", "monitor", "ban"].includes(action)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Ban Evasion").setDescription("Invalid action.")],
        ephemeral: true
      });
      return true;
    }

    const result = await api(`/ban-evasion/cases/${caseId}/action`, {
      method: "POST",
      headers: { authorization: `Bearer ${modJwt}` },
      body: JSON.stringify({ action })
    });
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Ban Evasion").setDescription(`Case ${caseId} set to **${result.status ?? action}**.`)],
      ephemeral: true
    });
    return true;
  }
};

const antiCheatAlertHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("ac:")) return false;
    if (!isModeratorButtonInteraction(interaction)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Permission Denied").setDescription("Moderator role required.")],
        ephemeral: true
      });
      return true;
    }
    if (!modJwt) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Anti-Cheat").setDescription("DISCORD_MOD_JWT is not configured.")],
        ephemeral: true
      });
      return true;
    }

    const [, alertId, action] = interaction.customId.split(":");
    if (!alertId || !action) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Anti-Cheat").setDescription("Invalid anti-cheat action.")],
        ephemeral: true
      });
      return true;
    }

    if (action === "spectate") {
      const alerts = await api("/anti-cheat/alerts?limit=100", {
        headers: { authorization: `Bearer ${modJwt}` }
      });
      const found = Array.isArray(alerts) ? alerts.find((x: any) => String(x.id) === alertId) : null;
      const command = found?.spectate_command ? String(found.spectate_command) : null;
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Anti-Cheat")
            .setDescription(command ? `Spectate:\n\`${command}\`` : "Match is not live or spectate data unavailable.")
        ],
        ephemeral: true
      });
      return true;
    }

    const apiAction =
      action === "open_case"
        ? "open_case"
        : action === "timeout"
          ? "timeout_24h"
          : action === "false_positive"
            ? "false_positive"
            : "clean";
    const resolved = await api(`/anti-cheat/alerts/${alertId}/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${modJwt}` },
      body: JSON.stringify({ action: apiAction })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Anti-Cheat")
          .setDescription(`Alert ${alertId} updated to **${resolved.status ?? "resolved"}**.`)
      ],
      ephemeral: true
    });
    return true;
  }
};

const smurfRiskHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("sr:")) return false;
    if (!isModeratorButtonInteraction(interaction)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Permission Denied").setDescription("Moderator role required.")],
        ephemeral: true
      });
      return true;
    }
    if (!modJwt) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Smurf Risk").setDescription("DISCORD_MOD_JWT is not configured.")],
        ephemeral: true
      });
      return true;
    }

    const [, alertId, action] = interaction.customId.split(":");
    if (!alertId || !action) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Smurf Risk").setDescription("Invalid action payload.")],
        ephemeral: true
      });
      return true;
    }
    const alerts = await api("/risk/smurf-alerts?limit=100", {
      headers: { authorization: `Bearer ${modJwt}` }
    });
    const found = Array.isArray(alerts) ? alerts.find((a: any) => String(a.id) === alertId) : null;
    if (!found) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Smurf Risk").setDescription("Alert not found.")],
        ephemeral: true
      });
      return true;
    }

    const steamId = String(found.steam_id ?? "");
    const response = await api(`/risk/smurf/${encodeURIComponent(steamId)}/action`, {
      method: "POST",
      headers: { authorization: `Bearer ${modJwt}` },
      body: JSON.stringify({ action, alert_id: alertId })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Smurf Risk")
          .setDescription(`Action **${action}** applied for ${steamId}. Status: **${response.status ?? "updated"}**`)
      ],
      ephemeral: true
    });
    return true;
  }
};

const playerHistoryHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("playerhistory:full:")) return false;
    if (!isModeratorButtonInteraction(interaction)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Player History").setDescription("Moderator role required.")],
        ephemeral: true
      });
      return true;
    }
    const steamId = interaction.customId.split(":")[2];
    if (!steamId) return true;
    const history = await api(`/internal/player/history/${encodeURIComponent(steamId)}`, {
      headers: { "x-bot-token": botApiToken }
    });
    const logs = (history.moderation_logs ?? [])
      .slice(0, 12)
      .map((row: any) => `${row.timestamp} | ${row.action} | ${row.reason ?? "n/a"} | match ${row.match_id ?? "n/a"}`)
      .join("\n");

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Full History: ${steamId}`)
          .setDescription(logs || "No moderation logs found.")
      ],
      ephemeral: true
    });
    return true;
  }
};

const verificationHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("verify:")) return false;
    const parts = interaction.customId.split(":");
    const action = parts[1];
    if (action === "start") {
      const a = Math.floor(Math.random() * 9) + 1;
      const b = Math.floor(Math.random() * 9) + 1;
      const challengeId = crypto.randomBytes(8).toString("hex");
      pendingVerificationCaptchas.set(challengeId, {
        discordId: interaction.user.id,
        answer: a + b,
        expiresAt: Date.now() + 5 * 60 * 1000
      });
      const prompt = makeCaptchaPrompt(a, b, challengeId);
      await interaction.reply({ ...prompt, ephemeral: true });
      return true;
    }
    if (action === "captcha") {
      const challengeId = parts[2];
      const selected = Number(parts[3]);
      const challenge = pendingVerificationCaptchas.get(challengeId);
      if (!challenge || challenge.expiresAt <= Date.now()) {
        pendingVerificationCaptchas.delete(challengeId);
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Verification").setDescription("CAPTCHA expired. Press Verify again.")],
          ephemeral: true
        });
        return true;
      }
      if (challenge.discordId !== interaction.user.id) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Verification").setDescription("This CAPTCHA belongs to another user.")],
          ephemeral: true
        });
        return true;
      }
      pendingVerificationCaptchas.delete(challengeId);
      if (selected !== challenge.answer) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Verification").setDescription("Incorrect answer. Press Verify and try again.")],
          ephemeral: true
        });
        return true;
      }
      passedVerificationCaptcha.set(interaction.user.id, Date.now() + 10 * 60 * 1000);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("CAPTCHA Passed")
            .setDescription("Now run **/linksteam** to complete verification.")
        ],
        ephemeral: true
      });
      return true;
    }
    return false;
  }
};

function isModeratorInteraction(interaction: ChatInputCommandInteraction): boolean {
  if (!moderatorRoleId) return true;
  const member: any = interaction.member;
  const roles = member?.roles?.cache;
  return Boolean(roles?.has?.(moderatorRoleId));
}

function isModeratorButtonInteraction(interaction: ButtonInteraction): boolean {
  if (!moderatorRoleId) return true;
  const member: any = interaction.member;
  const roles = member?.roles?.cache;
  return Boolean(roles?.has?.(moderatorRoleId));
}

async function handleSlashCreator(interaction: ChatInputCommandInteraction): Promise<void> {
  const value = interaction.options.getString("value", true).trim();
  const action = value.toLowerCase();
  const steamId = interaction.options.getString("steamid") ?? `discord_${interaction.user.id}`;
  const codeInput = interaction.options.getString("code") ?? (action !== "apply" && action !== "approve" && action !== "leaderboard" ? value : "");

  if (action === "apply") {
    const result = await api("/internal/creator/apply", {
      method: "POST",
      headers: { "x-bot-token": botApiToken },
      body: JSON.stringify({ steam_id: steamId, requested_code: codeInput || undefined })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Creator Application")
          .setDescription(`Application status: **${result.status}**`)
          .addFields(
            { name: "Player", value: steamId, inline: true },
            { name: "Requested Code", value: String(result.requested_code ?? codeInput ?? "n/a"), inline: true }
          )
      ],
      ephemeral: true
    });
    return;
  }

  if (action === "use" || (action !== "apply" && action !== "approve" && action !== "leaderboard")) {
    if (!codeInput) {
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Creator").setDescription("Provide a creator code.")], ephemeral: true });
      return;
    }
    const result = await api("/internal/creator/use", {
      method: "POST",
      headers: { "x-bot-token": botApiToken },
      body: JSON.stringify({ steam_id: steamId, creator_code: codeInput })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Creator Code Applied")
          .setDescription(`Creator code **${result.creator_code}** linked for ${steamId}.`)
      ],
      ephemeral: true
    });
    return;
  }

  if (action === "approve") {
    if (!isModeratorInteraction(interaction)) {
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Creator").setDescription("Moderator role required.")], ephemeral: true });
      return;
    }
    if (!codeInput) {
      await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Creator").setDescription("Provide creator code to approve.")], ephemeral: true });
      return;
    }
    const result = await api("/internal/creator/approve", {
      method: "POST",
      headers: { "x-bot-token": botApiToken },
      body: JSON.stringify({
        steam_id: steamId,
        creator_code: codeInput
      })
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Creator Approved")
          .setDescription(`Approved **${steamId}** with code **${result.creator_code}**.`)
      ],
      ephemeral: true
    });
    return;
  }

  if (action === "leaderboard") {
    const rows = await api("/leaderboard/creators");
    const top = (rows ?? []).slice(0, 10);
    const lines = top.map((r: any) => `${r.position}. ${r.display_name} (${r.creator_code}) - referrals ${r.creator_referrals}, matches ${r.creator_matches}, views ${r.creator_views}`);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Top Creators")
          .setDescription(lines.join("\n") || "No creator data yet.")
      ],
      ephemeral: true
    });
    return;
  }
}

async function handleSlashBanMap(interaction: ChatInputCommandInteraction): Promise<void> {
  const mapInput = interaction.options.getString("map", true).toLowerCase();
  const map = mapInput.startsWith("de_") ? mapInput : `de_${mapInput}`;
  const fromOption = interaction.options.getString("match_id");
  const resolvedMatchId =
    fromOption ??
    Array.from(matchVetos.values()).find((v) => v.channelId === interaction.channelId)?.matchId;

  if (!resolvedMatchId) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Captain Veto").setDescription("No active match veto found in this channel.")],
      ephemeral: true
    });
    return;
  }

  const result = await applyCaptainBan(resolvedMatchId, map, interaction.user.id);
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle("Captain Veto").setDescription(result.message)],
    ephemeral: true
  });
}

async function handleSlashClip(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!modJwt) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Clip").setDescription("DISCORD_MOD_JWT is not configured.")],
      ephemeral: true
    });
    return;
  }
  if (!isModeratorInteraction(interaction)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Clip").setDescription("Moderator role required.")],
      ephemeral: true
    });
    return;
  }

  const matchId = interaction.options.getString("match_id", true);
  const timestamp = interaction.options.getInteger("timestamp", true);
  const playerId = interaction.options.getString("player_id") ?? undefined;
  const clip = await api("/clip", {
    method: "POST",
    headers: { authorization: `Bearer ${modJwt}` },
    body: JSON.stringify({
      match_id: matchId,
      timestamp,
      player_id: playerId
    })
  });

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Evidence Clip Generated")
        .addFields(
          { name: "Clip ID", value: String(clip.clip_id ?? "n/a"), inline: true },
          { name: "Match ID", value: String(clip.match_id ?? matchId), inline: true },
          { name: "Timestamp", value: `${clip.timestamp ?? timestamp}s`, inline: true },
          { name: "Clip URL", value: String(clip.clip_url ?? "n/a"), inline: false }
        )
    ],
    components: clip.clip_url ? [linkRow("Open Clip", String(clip.clip_url))] : [],
    ephemeral: true
  });
}

async function handleSlashModLogs(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!modJwt) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Mod Logs").setDescription("DISCORD_MOD_JWT is not configured.")],
      ephemeral: true
    });
    return;
  }
  if (!isModeratorInteraction(interaction)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Mod Logs").setDescription("Moderator role required.")],
      ephemeral: true
    });
    return;
  }

  const player = interaction.options.getString("player");
  const qs = new URLSearchParams();
  if (player) qs.set("steam_id", player);
  qs.set("limit", "15");
  const res = await api(`/moderation/logs?${qs.toString()}`, {
    headers: { authorization: `Bearer ${modJwt}` }
  });
  const logs = Array.isArray(res?.logs) ? res.logs : [];
  const lines = logs.slice(0, 15).map((row: any) => {
    const actor = row.moderator_name ?? row.moderator_steam_id ?? "System";
    const target = row.player_name ?? row.player_steam_id ?? row.player_id ?? "n/a";
    return `${row.timestamp} | ${row.action} | ${target} | by ${actor} | ${row.reason ?? "n/a"}`;
  });
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Moderation History")
        .setDescription(lines.join("\n") || "No moderation logs found.")
    ],
    ephemeral: true
  });
}

async function handleSlashPlayerHistory(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isModeratorInteraction(interaction)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Player History").setDescription("Moderator role required.")],
      ephemeral: true
    });
    return;
  }
  const steamId = interaction.options.getString("player", true);
  const history = await api(`/internal/player/history/${encodeURIComponent(steamId)}`, {
    headers: { "x-bot-token": botApiToken }
  });
  const p = history.player ?? {};
  const s = history.summary ?? {};
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`playerhistory:full:${steamId}`)
      .setLabel("View Full History")
      .setStyle(ButtonStyle.Primary)
  );
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Player Moderation History")
        .addFields(
          { name: "Steam ID", value: String(p.steam_id ?? steamId), inline: true },
          { name: "Discord ID", value: p.discord_id ? `<@${p.discord_id}>` : "n/a", inline: true },
          { name: "Matches Played", value: String(s.matches_played ?? 0), inline: true },
          { name: "Reports Received", value: String(s.reports_received ?? 0), inline: true },
          { name: "Previous Bans", value: String(s.previous_bans ?? 0), inline: true },
          { name: "Trust Score", value: String(p.trust_score ?? 100), inline: true }
        )
    ],
    components: [row],
    ephemeral: true
  });
}

async function handleSlashTestMatch(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const fake = await api("/internal/test/fake-players", {
    method: "POST",
    headers: { "x-bot-token": botApiToken },
    body: JSON.stringify({ count: 10, region: "eu" })
  });
  const players = fake.players as Array<{ player_id: string; elo: number; region: string; timestamp: string }>;
  const { teamA, teamB } = balanceTeamsByElo(players);
  const mapsData = await api("/maps/daily");
  const matchId = crypto.randomUUID();

  await mapVoteHandler.create({
    matchId,
    players: players.map((p) => p.player_id),
    team_a: teamA,
    team_b: teamB,
    daily_map_pool: mapsData.maps,
    test_mode: true
  });

  await interaction.editReply({
    embeds: [new EmbedBuilder().setTitle("Test Match").setDescription(`Test match started: ${matchId}. Simulated flow is now running.`)],
    components: [linkRow("Live Matches", `${publicApiUrl}/matches/live`)]
  });
}

const skinHandler = {
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith("skin:")) return false;
    const parts = interaction.customId.split(":");
    const mode = parts[1];
    const steamId = parts[2];
    const value = parts[3];
    if (!steamId) return false;
    const catalog = await getSkinCatalog();

    if (mode === "category") {
      const category = value as (typeof SKIN_CATEGORIES)[number];
      if (!SKIN_CATEGORIES.includes(category)) return false;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("Skin Selection")
            .setDescription(`Player: **${steamId}**\nCategory: **${prettyCategoryName(category)}**\nPick a weapon.`)
        ],
        components: makeWeaponButtons(steamId, category, catalog)
      });
      return true;
    }

    if (mode === "weapon") {
      const weapon = value;
      if (!weapon) return false;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("Skin Selection")
            .setDescription(`Player: **${steamId}**\nWeapon: **${prettyWeaponName(weapon)}**\nPick a skin.`)
        ],
        components: makeSkinButtons(steamId, weapon, catalog)
      });
      return true;
    }

    if (mode === "pick") {
      const weapon = value;
      const skinId = parts.slice(4).join(":");
      if (!weapon || !skinId) return false;
      await setPlayerSkin(interaction.user.id, steamId, weapon, skinId);
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("Skin Saved")
            .setDescription(`Player: **${steamId}**\nWeapon: **${prettyWeaponName(weapon)}**\nSkin ID: **${skinId}**`)
        ],
        components: []
      });
      return true;
    }

    return false;
  }
};

client.on("ready", async () => {
  console.log(`Discord bot connected as ${client.user?.tag}`);
  if (client.user) {
    client.user.setPresence({
      activities: [{ name: "Starting FragHub systems...", type: ActivityType.Watching }],
      status: "online"
    });
  }

  if (client.application && guildId) {
    const skinsCommand = new SlashCommandBuilder()
      .setName("skins")
      .setDescription("Select cosmetic skins for your verified Steam account")
      .addStringOption((opt) =>
        opt
          .setName("steamid")
          .setDescription("Optional Steam ID override (must match linked account)")
          .setRequired(false)
      );

    const queueCommand = new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Join the matchmaking queue")
      .addStringOption((opt) =>
        opt.setName("steamid").setDescription("Steam ID (optional)").setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName("region").setDescription("Region").setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Optional mode shortcut (e.g. clanwars)")
          .setRequired(false)
          .addChoices(
            { name: "Ranked 5v5", value: "ranked" },
            { name: "Wingman 2v2", value: "wingman" },
            { name: "Casual 10v10", value: "casual" },
            { name: "Superpower Mode", value: "superpower" },
            { name: "Gun Game", value: "gungame" },
            { name: "Zombie Mode", value: "zombie" },
            { name: "Clan Wars 5v5", value: "clanwars" }
          )
      );

    const leaveCommand = new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Leave the matchmaking queue")
      .addStringOption((opt) =>
        opt.setName("steamid").setDescription("Optional Steam ID override").setRequired(false)
      );

    const matchCommand = new SlashCommandBuilder()
      .setName("match")
      .setDescription("Show match details")
      .addStringOption((opt) => opt.setName("id").setDescription("Match ID").setRequired(true));

    const statsCommand = new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Show player stats")
      .addStringOption((opt) => opt.setName("steamid").setDescription("Optional Steam ID override").setRequired(false));

    const seasonCommand = new SlashCommandBuilder()
      .setName("season")
      .setDescription("Show your current seasonal progression");

    const seasonLeaderboardCommand = new SlashCommandBuilder()
      .setName("season-leaderboard")
      .setDescription("Show top seasonal players");

    const openBoxCommand = new SlashCommandBuilder()
      .setName("openbox")
      .setDescription("Open one FragBox reward box");

    const redeemBattlepassCommand = new SlashCommandBuilder()
      .setName("redeem-battlepass")
      .setDescription("Redeem a Premium Battle Pass Token for the current season");

    const reportCommand = new SlashCommandBuilder()
      .setName("report")
      .setDescription("Report a player")
      .addStringOption((opt) => opt.setName("reporter_steamid").setDescription("Optional reporter Steam ID").setRequired(false))
      .addStringOption((opt) => opt.setName("reported_steamid").setDescription("Reported Steam ID").setRequired(true))
      .addStringOption((opt) => opt.setName("match_id").setDescription("Match ID").setRequired(true));

    const clipCommand = new SlashCommandBuilder()
      .setName("clip")
      .setDescription("Generate moderation evidence clip from a demo timestamp")
      .addStringOption((opt) => opt.setName("match_id").setDescription("Match ID").setRequired(true))
      .addIntegerOption((opt) => opt.setName("timestamp").setDescription("Demo timestamp in seconds").setRequired(true))
      .addStringOption((opt) => opt.setName("player_id").setDescription("Optional player UUID").setRequired(false));

    const modLogsCommand = new SlashCommandBuilder()
      .setName("modlogs")
      .setDescription("Show recent moderation logs")
      .addStringOption((opt) => opt.setName("player").setDescription("Steam ID filter").setRequired(false));

    const playerHistoryCommand = new SlashCommandBuilder()
      .setName("playerhistory")
      .setDescription("Show player moderation history summary")
      .addStringOption((opt) => opt.setName("player").setDescription("Steam ID").setRequired(true));

    const linkSteamCommand = new SlashCommandBuilder()
      .setName("linksteam")
      .setDescription("Link your Steam account after CAPTCHA verification");

    const verifyCommand = new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Start verification CAPTCHA");

    const usernameCommand = new SlashCommandBuilder()
      .setName("username")
      .setDescription("Set your FragHub username after verification")
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Username (3-16, letters/numbers/underscore)").setRequired(true)
      );

    const usernameChangeCommand = new SlashCommandBuilder()
      .setName("username-change")
      .setDescription("Change your FragHub username (once per 30 days)")
      .addStringOption((opt) =>
        opt.setName("newname").setDescription("New username").setRequired(true)
      );

    const tagCommand = new SlashCommandBuilder()
      .setName("tag")
      .setDescription("Choose which tag to display (staff/clan/none)");

    const clanCommand = new SlashCommandBuilder()
      .setName("clan")
      .setDescription("Clan management")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Request creation of a new clan")
          .addStringOption((opt) =>
            opt.setName("name").setDescription("Clan name").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("tag").setDescription("Clan tag (3-5, A-Z0-9)").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("Request to join a clan by tag")
          .addStringOption((opt) =>
            opt.setName("tag").setDescription("Clan tag").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("approve")
          .setDescription("Approve a pending join request (owner only)")
          .addStringOption((opt) =>
            opt.setName("player").setDescription("Player Steam ID or username").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("invite")
          .setDescription("Invite/add a player to your clan (owner only)")
          .addStringOption((opt) =>
            opt.setName("player").setDescription("Player Steam ID or username").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("kick")
          .setDescription("Kick a member from your clan (owner only)")
          .addStringOption((opt) =>
            opt.setName("player").setDescription("Player Steam ID or username").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("leave")
          .setDescription("Leave your current clan")
      )
      .addSubcommand((sub) =>
        sub
          .setName("leaderboard")
          .setDescription("Show top clans by rating")
      )
      .addSubcommand((sub) =>
        sub
          .setName("info")
          .setDescription("Show clan profile info")
          .addStringOption((opt) =>
            opt.setName("tag").setDescription("Optional clan tag (defaults to your clan)").setRequired(false)
          )
      );

    const creatorCommand = new SlashCommandBuilder()
      .setName("creator")
      .setDescription("Creator program actions")
      .addStringOption((opt) =>
        opt
          .setName("value")
          .setDescription("apply | leaderboard | approve | <creator_code>")
          .setRequired(true)
      )
      .addStringOption((opt) => opt.setName("steamid").setDescription("Steam ID (optional)").setRequired(false))
      .addStringOption((opt) => opt.setName("code").setDescription("Creator code (used with approve)").setRequired(false));

    const streamerCommand = new SlashCommandBuilder()
      .setName("streamer")
      .setDescription("Streamer lobby actions")
      .addSubcommand((sub) =>
        sub
          .setName("lobby")
          .setDescription("Create a streamer match lobby")
          .addStringOption((opt) =>
            opt
              .setName("mode")
              .setDescription("Game mode")
              .setRequired(false)
              .addChoices(
                { name: "Ranked 5v5", value: "ranked" },
                { name: "Wingman 2v2", value: "wingman" },
                { name: "Casual 10v10", value: "casual" },
                { name: "Superpower Mode", value: "superpower" },
                { name: "Gun Game", value: "gungame" },
                { name: "Zombie Mode", value: "zombie" },
                { name: "Clan Wars 5v5", value: "clanwars" }
              )
          )
          .addStringOption((opt) =>
            opt
              .setName("stream_url")
              .setDescription("Twitch/YouTube stream URL")
              .setRequired(false)
          )
      );

    const banMapCommand = new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Captain veto: ban a map")
      .addStringOption((opt) =>
        opt
          .setName("map")
          .setDescription("Map to ban")
          .setRequired(true)
          .addChoices(
            { name: "Mirage", value: "de_mirage" },
            { name: "Inferno", value: "de_inferno" },
            { name: "Dust2", value: "de_dust2" },
            { name: "Ancient", value: "de_ancient" },
            { name: "Nuke", value: "de_nuke" },
            { name: "Overpass", value: "de_overpass" },
            { name: "Vertigo", value: "de_vertigo" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("match_id").setDescription("Match ID (optional in match channel)").setRequired(false)
      );

    const testMatchCommand = new SlashCommandBuilder()
      .setName("testmatch")
      .setDescription("Run a full mock match flow (queue -> vote -> server -> end)");

    await client.application.commands.set(
      [
        skinsCommand.toJSON(),
        queueCommand.toJSON(),
        leaveCommand.toJSON(),
        matchCommand.toJSON(),
        statsCommand.toJSON(),
        seasonCommand.toJSON(),
        seasonLeaderboardCommand.toJSON(),
        openBoxCommand.toJSON(),
        redeemBattlepassCommand.toJSON(),
        reportCommand.toJSON(),
        clipCommand.toJSON(),
        modLogsCommand.toJSON(),
        playerHistoryCommand.toJSON(),
        verifyCommand.toJSON(),
        linkSteamCommand.toJSON(),
        usernameCommand.toJSON(),
        usernameChangeCommand.toJSON(),
        tagCommand.toJSON(),
        clanCommand.toJSON(),
        creatorCommand.toJSON(),
        streamerCommand.toJSON(),
        banMapCommand.toJSON(),
        ...(enableTestMode ? [testMatchCommand.toJSON()] : [])
      ],
      guildId
    );
    if (enableTestMode) {
      console.log("Discord test mode enabled: /testmatch registered");
    }
  }

  await postServerStatus("Discord bot online.");
  await syncVerificationGatePermissions();
  await postOrRefreshVerificationPanel();
  scheduleDailyMapVoteLoop();
  await startPresenceRotation();
});

client.on("guildMemberAdd", async (member: GuildMember) => {
  try {
    if (guildId && member.guild.id !== guildId) return;
    await assignMemberUnverifiedRole(member.id);
    await syncVerificationGatePermissions();
  } catch (error) {
    console.error("failed to apply unverified role", error);
  }
});

client.on("guildMemberUpdate", async (_oldMember, newMember) => {
  try {
    if (guildId && newMember.guild.id !== guildId) return;
    await enforceClanRoleIntegrity(newMember);
  } catch (error) {
    eventLogger.error("clan_role_integrity_failed", {
      discord_id: newMember.id,
      reason: error instanceof Error ? error.message : "unknown"
    });
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    if (guildId && member.guild.id !== guildId) return;
    if (isStaffMember(member)) return;

    const matchEntry = Array.from(matchChannels.entries()).find(([, state]) =>
      state.allowedDiscordUserIds.includes(member.id)
    );
    if (!matchEntry) return;
    const [matchId, state] = matchEntry;
    if (!state.voiceLocked) return;

    const teamAIds = new Set(state.teamAPlayerIds.map((playerId) => playerDiscordMap[playerId]).filter(Boolean));
    const teamBIds = new Set(state.teamBPlayerIds.map((playerId) => playerDiscordMap[playerId]).filter(Boolean));
    const expectedChannelId = teamAIds.has(member.id)
      ? state.team1VoiceChannelId
      : teamBIds.has(member.id)
      ? state.team2VoiceChannelId
      : null;
    if (!expectedChannelId) return;

    const toChannelId = newState.channelId;
    if (!toChannelId) return;

    if (state.halftimeActive) {
      if (toChannelId !== state.halftimeVoiceChannelId) {
        await member.voice.setChannel(state.halftimeVoiceChannelId).catch(() => null);
        await postVoiceLog("Player returned to Halftime VC", {
          matchId,
          memberId: member.id,
          from: toChannelId,
          to: state.halftimeVoiceChannelId,
          note: "Voice switch blocked during halftime."
        });
      }
      return;
    }

    if (toChannelId !== expectedChannelId) {
      await member.voice.setChannel(expectedChannelId).catch(() => null);
      const chat = await getChannel(state.chatChannelId);
      if (chat) {
        await chat.send({
          content: `<@${member.id}> You cannot change voice channels during a match.`
        }).catch(() => null);
      }
      await postVoiceLog("Player returned to Team VC", {
        matchId,
        memberId: member.id,
        from: toChannelId,
        to: expectedChannelId,
        note: "Voice switch protection enforced."
      });
    }
  } catch (error) {
    eventLogger.error("voice_state_protection_failed", {
      reason: error instanceof Error ? error.message : "unknown"
    });
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() && (await verificationHandler.handleButton(interaction))) {
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "linksteam") {
      await handleSlashLinkSteam(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
      await handleSlashVerify(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "username") {
      await handleSlashUsername(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "username-change") {
      await handleSlashUsernameChange(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "tag") {
      await handleSlashTag(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const steamId = await ensureVerifiedAccess(interaction);
      if (!steamId) return;
    }

    if (interaction.isButton()) {
      const steamId = await ensureVerifiedAccess(interaction);
      if (!steamId) return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "skins") {
      await handleSlashSkins(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "queue") {
      await handleSlashQueue(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "leave") {
      await handleSlashLeave(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "match") {
      await handleSlashMatch(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "stats") {
      await handleSlashStats(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "season") {
      await handleSlashSeason(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "season-leaderboard") {
      await handleSlashSeasonLeaderboard(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "openbox") {
      await handleSlashOpenBox(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "redeem-battlepass") {
      await handleSlashRedeemBattlepass(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "report") {
      await handleSlashReport(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "clip") {
      await handleSlashClip(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "modlogs") {
      await handleSlashModLogs(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "playerhistory") {
      await handleSlashPlayerHistory(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "creator") {
      await handleSlashCreator(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "clan") {
      await handleSlashClan(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "streamer") {
      await streamerHandler.handleSlash(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "ban") {
      await mapVoteHandler.handleSlashBan(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "testmatch") {
      if (!enableTestMode) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Test Mode").setDescription("Test mode is disabled.")],
          ephemeral: true
        });
        return;
      }
      await handleSlashTestMatch(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (await tagHandler.handleButton(interaction)) return;
      if (await clanRequestHandler.handleButton(interaction)) return;
      if (await playerHistoryHandler.handleButton(interaction)) return;
      if (await banEvasionHandler.handleButton(interaction)) return;
      if (await antiCheatAlertHandler.handleButton(interaction)) return;
      if (await smurfRiskHandler.handleButton(interaction)) return;
      if (await creatorMatchHandler.handleButton(interaction)) return;
      if (await streamerHandler.handleButton(interaction)) return;
      if (await queueHandler.handleButton(interaction)) return;
      if (await mapVoteHandler.handleButton(interaction)) return;
      if (await skinHandler.handleButton(interaction)) return;
      if (await reportHandler.handleButton(interaction)) return;
      if (await moderationHandler.handleButton(interaction)) return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("mapvote:")) {
      const [, matchId, map] = interaction.customId.split(":");
      const voteState = matchVotes.get(matchId);
      if (!voteState) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Map Vote").setDescription("Voting has ended for this match.")],
          ephemeral: true
        });
        return;
      }

      if (voteState.channelId !== interaction.channelId) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Map Vote").setDescription("Invalid voting channel.")],
          ephemeral: true
        });
        return;
      }
      if (voteState.allowedVoterDiscordIds && !voteState.allowedVoterDiscordIds.has(interaction.user.id)) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Map Vote").setDescription("Only match players can vote.")],
          ephemeral: true
        });
        return;
      }

      if (voteState.votedUsers.has(interaction.user.id)) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Map Vote").setDescription("You have already voted.")],
          ephemeral: true
        });
        return;
      }

      if (!voteState.maps.includes(map)) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Map Vote").setDescription("Invalid map choice.")],
          ephemeral: true
        });
        return;
      }

      voteState.votedUsers.add(interaction.user.id);
      voteState.votes[map] = (voteState.votes[map] ?? 0) + 1;
      eventLogger.info("map_vote_cast", {
        match_id: matchId,
        map,
        user_id: interaction.user.id,
        votes: voteState.votes
      });
      try {
        const voteChannel = await getChannel(voteState.channelId);
        if (voteChannel) {
          const voteMessage = await voteChannel.messages.fetch(voteState.voteMessageId);
          await voteMessage.edit({
            embeds: [buildMapVoteEmbed(matchId, voteState.maps, voteState.votes)],
            components: buildMapVoteRows(matchId, voteState.maps, false)
          });
        }
      } catch (error) {
        console.error("failed to update live vote counts", error);
      }
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Map Vote").setDescription(`Vote recorded for **${mapLabel(map)}**`)],
        ephemeral: true
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("dailymap:")) {
      const [, date, map] = interaction.customId.split(":");
      const state = dailyMapVoteState;
      if (!state || state.voteDate !== date) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Daily Map Vote").setDescription("Daily map voting is closed.")],
          ephemeral: true
        });
        return;
      }
      if (interaction.channelId !== state.channelId) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Daily Map Vote").setDescription("Vote in the #map-vote channel.")],
          ephemeral: true
        });
        return;
      }
      if (!(map in state.votes)) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Daily Map Vote").setDescription("Invalid map choice.")],
          ephemeral: true
        });
        return;
      }
      const userVotes = state.votedByUser.get(interaction.user.id) ?? new Set<string>();
      if (userVotes.has(map)) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Daily Map Vote").setDescription(`You already voted for **${mapLabel(map)}**.`)],
          ephemeral: true
        });
        return;
      }
      userVotes.add(map);
      state.votedByUser.set(interaction.user.id, userVotes);
      state.votes[map] += 1;
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Daily Map Vote").setDescription(`Vote recorded for **${mapLabel(map)}**`)],
        ephemeral: true
      });
      return;
    }
  } catch (error: any) {
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          embeds: [new EmbedBuilder().setTitle("Error").setDescription(`Interaction failed: ${error.message}`)],
          ephemeral: true
        });
      } else {
        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle("Error").setDescription(`Interaction failed: ${error.message}`)],
          ephemeral: true
        });
      }
    }
  }
});

(async () => {
  await sub.subscribe("match-events", "overwatch-events", "queue-events", "highlight-events", "security-events", "verification-events", "moderation-events", "season-events");
  sub.on("message", async (channel, payload) => {
    const event = JSON.parse(payload);

    try {
      if (channel === "match-events" && event.type === "match_started") {
        await postMatchStarted(event);
      }
      if (channel === "match-events" && event.type === "match_recovery_started") {
        await postMatchRecoveryStarted(event);
      }
      if (channel === "match-events" && event.type === "match_recovered") {
        await postMatchRecovered(event);
      }
      if (channel === "match-events" && event.type === "match_recovery_failed") {
        await postMatchRecoveryFailed(event);
      }
      if (channel === "match-events" && event.type === "match_found") {
        await mapVoteHandler.create(event);
      }
      if (
        channel === "match-events" &&
        ["round_start", "round_started", "round_live", "round_resume"].includes(String(event.type))
      ) {
        const matchId = String(event.matchId ?? event.match_id ?? "");
        if (matchId) {
          await setMatchChatLocked(matchId, true);
          await endMatchHalftimeVoice(matchId);
        }
      }
      if (
        channel === "match-events" &&
        ["halftime", "halftime_start", "match_halftime", "side_switch"].includes(String(event.type))
      ) {
        const matchId = String(event.matchId ?? event.match_id ?? "");
        if (matchId) {
          await setMatchChatLocked(matchId, false);
          await startMatchHalftimeVoice(matchId);
        }
      }
      if (channel === "match-events" && event.type === "match_finished") {
        await postMatchFinished(event);
      }
      if (channel === "overwatch-events" && event.type === "case_created") {
        await postCaseCreated(event);
      }
      if (channel === "overwatch-events" && event.type === "ban_logged") {
        await postPublicBanLog(event);
      }
      if (channel === "overwatch-events" && event.type === "cheat_alert") {
        await postCheatAlert(event);
      }
      if (channel === "overwatch-events" && event.type === "anti_cheat_alert") {
        await postAntiCheatAlert(event);
      }
      if (channel === "overwatch-events" && event.type === "steam_link_flagged") {
        await postSteamLinkFlagged(event);
      }
      if (channel === "overwatch-events" && event.type === "ban_evasion_alert") {
        await postBanEvasionAlert(event);
      }
      if (channel === "overwatch-events" && event.type === "ban_evasion_case_updated") {
        await postServerStatus(`Ban evasion case ${event.case_id} updated to ${event.status} by moderator ${event.moderator_id}`);
      }
      if (channel === "queue-events" && event.type === "queue_join") {
        await postQueueStatus(`Player joined **${event.mode ?? "ranked"}** queue. Queue size: **${event.size ?? "?"}**`);
      }
      if (channel === "queue-events" && event.type === "queue_leave") {
        await postQueueStatus(`Player left **${event.mode ?? "ranked"}** queue. Queue size: **${event.size ?? "?"}**`);
      }
      if (channel === "highlight-events" && event.type === "highlight_moment") {
        await postHighlightMoment(event);
      }
      if (channel === "security-events") {
        await postSecurityAlert(event);
      }
      if (channel === "verification-events" && event.type === "user_verified") {
        const discordId = String(event.discord_id ?? "");
        const steamId = String(event.steam_id ?? "");
        if (discordId) {
          await setMemberVerificationRoles(discordId);
          await syncVerificationGatePermissions();
          const status = await getVerificationStatus(discordId);
          if (status.username && status.steam_id) {
            await refreshDiscordNicknameFromSteam(discordId, status.steam_id);
          }
          const verifyChannel = await getChannel(verifyChannelId);
          if (verifyChannel) {
            await verifyChannel.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle("Verification Complete")
                  .setDescription(
                    status.username
                      ? `<@${discordId}> is verified and ready.\nUsername: **${status.username}**`
                      : `<@${discordId}> is now verified.\nPlease choose a username with **/username <name>** before joining queue.`
                  )
                  .addFields({ name: "Steam ID", value: steamId || "unknown", inline: true })
              ]
            });
          }
          const user = await client.users.fetch(discordId).catch(() => null);
          if (user && !status.username) {
            await user
              .send("Verification complete. Please choose your username now with `/username <name>`.")
              .catch(() => null);
          }
          const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
          const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
          if (member) {
            await enforceClanRoleIntegrity(member);
          }
        }
      }
      if (channel === "moderation-events" && event.type === "moderation_log") {
        await postModerationLog(event);
      }
      if (channel === "moderation-events" && event.type === "smurf_alert") {
        await postSmurfAlert(event);
      }
      if (channel === "moderation-events" && event.type === "clan_request_created") {
        await postClanRequest(event);
      }
      if (channel === "moderation-events" && event.type === "clan_request_resolved") {
        await postServerStatus(`Clan request ${event.request_id} ${event.decision} (${event.clan_tag ?? "n/a"})`);
      }
      if (channel === "season-events") {
        await postSeasonAnnouncement(event);
      }
    } catch (error) {
      console.error("event handling failed", error);
    }
  });

  await client.login(token);
})();

const healthPort = Number(process.env.DISCORD_BOT_PORT ?? 3004);
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", ok: true }));
  })
  .listen(healthPort, "0.0.0.0");


