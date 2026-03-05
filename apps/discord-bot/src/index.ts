
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  IntentsBitField,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type RepliableInteraction,
  type TextChannel
} from "discord.js";
import Redis from "ioredis";
import crypto from "node:crypto";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://api:3001";
const serverManagerBaseUrl = process.env.SERVER_MANAGER_BASE_URL ?? "http://server-manager:3003";
const serverManagerApiToken = process.env.SERVER_MANAGER_API_TOKEN ?? "";
const guildId = process.env.DISCORD_GUILD_ID ?? "";
const botApiToken = process.env.DISCORD_BOT_API_TOKEN ?? "";
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? process.env.DISCORD_BOT_API_TOKEN ?? "";
const defaultRegion = process.env.DISCORD_DEFAULT_REGION ?? "eu";
const enableTestMode = (process.env.DISCORD_ENABLE_TEST_MODE ?? "false").toLowerCase() === "true";
const OWNER_ROLE_ID = "1478846448652259509";
const ADMIN_ROLE_ID = "1478841053640654899";
const MODERATOR_ROLE_ID = "1478841341172519175";
const EMBED_COLOR = 0x5865f2;
const EMBED_FOOTER = "FragHub Matchmaking";

const ownerRoleId = process.env.DISCORD_OWNER_ROLE_ID ?? OWNER_ROLE_ID;
const moderatorRoleId = process.env.DISCORD_MODERATOR_ROLE_ID ?? MODERATOR_ROLE_ID;
const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID ?? ADMIN_ROLE_ID;

const channelIds = {
  verify: process.env.DISCORD_CHANNEL_VERIFY ?? "",
  queue: process.env.DISCORD_CHANNEL_QUEUE ?? "",
  mapVote: process.env.DISCORD_CHANNEL_MAP_VOTE ?? "",
  serverStatus: process.env.DISCORD_CHANNEL_SERVER_STATUS ?? "",
  updates: process.env.DISCORD_UPDATE_LOG_CHANNEL_ID ?? process.env.DISCORD_CHANNEL_UPDATES ?? "",
  banLog: process.env.DISCORD_CHANNEL_BAN_LOG ?? "",
  reports: process.env.DISCORD_CHANNEL_REPORTS ?? "",
  cheaterAlerts: process.env.DISCORD_CHANNEL_CHEATER_ALERTS ?? process.env.DISCORD_CHANNEL_OVERWATCH ?? "",
  matchResults: process.env.DISCORD_CHANNEL_MATCH_RESULTS ?? "",
  liveMatches: process.env.DISCORD_CHANNEL_LIVE_MATCHES ?? "",
  modLog: process.env.DISCORD_CHANNEL_MOD_LOG ?? ""
};

const roleIds = {
  unverified: process.env.DISCORD_ROLE_UNVERIFIED_ID ?? "",
  verified: process.env.DISCORD_ROLE_VERIFIED_ID ?? "",
  steamVerified: process.env.DISCORD_ROLE_STEAM_VERIFIED_ID ?? ""
};

type PanelKey = "verify" | "queue" | "mapVote" | "serverStatus";
const managedPanelChannels: Array<keyof typeof channelIds> = ["verify", "queue", "mapVote", "serverStatus"];

const panelMessageIds = new Map<PanelKey, string>();
const captchaState = new Map<string, { nonce: string; answer: string; expiresAt: number }>();
const clanRoleIdByTag = new Map<string, string>();
const queueSearchSessions = new Map<
  string,
  {
    mode: QueueMode;
    steamId: string;
    intervalHandle: NodeJS.Timeout;
    frame: number;
  }
>();
const matchConnectionCache = new Map<
  string,
  {
    mode: string;
    map: string;
    serverName: string;
    players: number;
    serverIp?: string;
    port?: number;
    serverPassword?: string;
    spectatorPassword?: string;
  }
>();
const matchLobbyState = new Map<
  string,
  {
    mode: QueueMode;
    mapPool: string[];
    teamAIds: string[];
    teamBIds: string[];
    teamALines: string[];
    teamBLines: string[];
    readyPlayerIds: Set<string>;
    requiredPlayers: number;
    channelId: string;
    messageId: string;
    timeoutHandle: NodeJS.Timeout;
  }
>();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ]
});

const sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const QUEUE_MODES = ["ranked", "wingman", "casual", "clanwars"] as const;
type QueueMode = (typeof QUEUE_MODES)[number];
const SEARCH_FRAMES = ["█░░░░░░░░░", "██░░░░░░░░", "███░░░░░░░", "████░░░░░░"] as const;

const MODE_META: Record<QueueMode, { icon: string; label: string; description: string; maxPlayers: number; ranked: boolean }> = {
  ranked: { icon: "ðŸ”¥", label: "Ranked 5v5", description: "Competitive ranked matches", maxPlayers: 10, ranked: true },
  wingman: { icon: "âš¡", label: "Wingman 2v2", description: "Short competitive matches", maxPlayers: 4, ranked: true },
  casual: { icon: "ðŸŽ‰", label: "Casual 10v10", description: "Fun mode without ranking", maxPlayers: 20, ranked: false },
  clanwars: { icon: "ðŸ›¡", label: "Clan Wars", description: "Clan vs Clan competitive matches", maxPlayers: 10, ranked: true }
};

type PresenceStats = {
  liveMatches: number;
  serversOnline: number;
  playersQueue: number;
};

let presenceIndex = 0;
let presenceCache: { stats: PresenceStats; fetchedAt: number } | null = null;

class ApiError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function baseEmbed(title: string, description?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setDescription(description ?? null)
    .setFooter({ text: EMBED_FOOTER })
    .setTimestamp(new Date());
}

async function replyEmbed(interaction: RepliableInteraction, embed: EmbedBuilder, ephemeral = true): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ embeds: [embed], ephemeral });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral });
  }
}

function modeLabel(mode: string): string {
  const key = mode as QueueMode;
  return MODE_META[key]?.label ?? mode;
}

function queueOrderKey(mode: QueueMode, pool: "normal" | "smurf" = "normal"): string {
  return pool === "smurf" ? `queue:${mode}:smurf:order` : `queue:${mode}:order`;
}

function queueEntriesKey(mode: QueueMode, pool: "normal" | "smurf" = "normal"): string {
  return pool === "smurf" ? `queue:${mode}:smurf:entries` : `queue:${mode}:entries`;
}

function rankFromElo(eloRaw: number): string {
  const elo = Number.isFinite(eloRaw) ? eloRaw : 1000;
  if (elo < 650) return "Silver I";
  if (elo < 750) return "Silver II";
  if (elo < 850) return "Silver III";
  if (elo < 950) return "Silver IV";
  if (elo < 1050) return "Silver Elite";
  if (elo < 1150) return "Silver Elite Master";
  if (elo < 1230) return "Gold Nova I";
  if (elo < 1310) return "Gold Nova II";
  if (elo < 1390) return "Gold Nova III";
  if (elo < 1470) return "Gold Nova Master";
  if (elo < 1550) return "Master Guardian I";
  if (elo < 1630) return "Master Guardian II";
  if (elo < 1710) return "Master Guardian Elite";
  if (elo < 1790) return "Distinguished Master Guardian";
  if (elo < 1870) return "Legendary Eagle";
  if (elo < 1950) return "Legendary Eagle Master";
  if (elo < 2050) return "Supreme Master First Class";
  return "Global Elite";
}

function progressBar(current: number, max: number, slots = 10): string {
  if (max <= 0) return "░".repeat(slots);
  const filled = Math.max(0, Math.min(slots, Math.round((current / max) * slots)));
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, slots - filled))}`;
}

async function queueModeSnapshot(mode: QueueMode): Promise<{ size: number; maxPlayers: number; avgRank: string }> {
  const maxPlayers = MODE_META[mode].maxPlayers;
  const [normalCount, smurfCount] = await Promise.all([
    redis.zcard(queueOrderKey(mode, "normal")).catch(() => 0),
    redis.zcard(queueOrderKey(mode, "smurf")).catch(() => 0)
  ]);
  const size = Number(normalCount) + Number(smurfCount);
  if (!MODE_META[mode].ranked) return { size, maxPlayers, avgRank: "-" };

  const [normalEntriesRaw, smurfEntriesRaw] = await Promise.all([
    redis.hvals(queueEntriesKey(mode, "normal")).catch(() => [] as string[]),
    redis.hvals(queueEntriesKey(mode, "smurf")).catch(() => [] as string[])
  ]);
  const entries = [...normalEntriesRaw, ...smurfEntriesRaw]
    .map((raw) => {
      try {
        return JSON.parse(String(raw)) as { elo?: number };
      } catch {
        return { elo: undefined };
      }
    })
    .filter((entry) => Number.isFinite(Number(entry.elo)));

  if (!entries.length) return { size, maxPlayers, avgRank: "Silver Elite" };
  const avg = entries.reduce((sum, entry) => sum + Number(entry.elo ?? 1000), 0) / entries.length;
  return { size, maxPlayers, avgRank: rankFromElo(avg) };
}

async function buildQueueOverviewEmbed(): Promise<EmbedBuilder> {
  const [stats, modeRows] = await Promise.all([
    fetchPresenceStats(),
    Promise.all(QUEUE_MODES.map(async (mode) => ({ mode, ...(await queueModeSnapshot(mode)) })))
  ]);

  const embed = baseEmbed("?? FragHub Matchmaking", "Competitive matchmaking system.")
    .addFields({
      name: "LIVE STATUS",
      value: `?? Live Matches: ${stats.liveMatches}\n?? Servers Online: ${stats.serversOnline}\n?? Players in Queue: ${stats.playersQueue}`,
      inline: false
    });

  for (const row of modeRows) {
    const meta = MODE_META[row.mode];
    const lines = [
      meta.description,
      "",
      `Players\n${row.size} / ${row.maxPlayers}`,
      meta.ranked ? `Average Rank\n${row.avgRank}` : "",
      `Progress\n${progressBar(row.size, row.maxPlayers)}`
    ].filter(Boolean);
    embed.addFields({ name: `${meta.icon} ${meta.label}`, value: lines.join("\n"), inline: false });
  }

  return embed;
}

async function buildQueueJoinedEmbed(mode: QueueMode, entryElo: number, size: number): Promise<EmbedBuilder> {
  return buildQueueSearchingEmbed(mode, entryElo, size, SEARCH_FRAMES[0]);
}

function buildQueueSearchingEmbed(mode: QueueMode, entryElo: number, size: number, searchFrame: string): EmbedBuilder {
  const maxPlayers = MODE_META[mode].maxPlayers;
  const needed = Math.max(0, maxPlayers - size);
  const etaSeconds = Math.max(8, needed * 6);
  return baseEmbed("? Queue Joined")
    .addFields(
      { name: "Mode", value: modeLabel(mode), inline: true },
      { name: "Your Rank", value: rankFromElo(entryElo), inline: true },
      { name: "Players", value: `${size} / ${maxPlayers}`, inline: true },
      { name: "Estimated Match Time", value: `~${etaSeconds} seconds`, inline: true },
      { name: "Searching for players...", value: `${searchFrame}`, inline: false }
    );
}

async function isUserStillQueued(mode: QueueMode, steamId: string): Promise<boolean> {
  const [normal, smurf] = await Promise.all([
    redis.hexists(queueEntriesKey(mode, "normal"), steamId).catch(() => 0),
    redis.hexists(queueEntriesKey(mode, "smurf"), steamId).catch(() => 0)
  ]);
  return Number(normal) > 0 || Number(smurf) > 0;
}

function stopQueueSearchSession(discordId: string): void {
  const active = queueSearchSessions.get(discordId);
  if (!active) return;
  clearInterval(active.intervalHandle);
  queueSearchSessions.delete(discordId);
}
function isOwner(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return Boolean(ownerRoleId) && member.roles.cache.has(ownerRoleId);
}

function isAdmin(member: GuildMember | null): boolean {
  if (!member) return false;
  if (isOwner(member)) return true;
  return Boolean(adminRoleId) && member.roles.cache.has(adminRoleId);
}

function isModerator(member: GuildMember | null): boolean {
  if (!member) return false;
  if (isAdmin(member)) return true;
  return Boolean(moderatorRoleId) && member.roles.cache.has(moderatorRoleId);
}

function normalizeApiError(error: any): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code || "API_ERROR", message: error.message || "Request failed." };
  }
  return { code: "UNKNOWN_ERROR", message: "Request failed. Please try again." };
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const code = String(parsed?.error_code ?? parsed?.error ?? `HTTP_${response.status}`);
    const message = String(parsed?.message ?? parsed?.error ?? "Request failed");
    throw new ApiError(response.status, code, message, parsed ?? raw);
  }

  if (parsed && typeof parsed === "object") return parsed;
  return { success: true };
}

async function serverApi(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${serverManagerBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(serverManagerApiToken ? { "x-server-manager-token": serverManagerApiToken } : {}),
      ...(internalApiToken ? { "x-internal-token": internalApiToken } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Server API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function botApi(path: string, init?: RequestInit): Promise<any> {
  return api(path, {
    ...init,
    headers: {
      "x-bot-token": botApiToken,
      "x-internal-token": internalApiToken,
      ...(init?.headers ?? {})
    }
  });
}

async function userApi(path: string, discordId: string, init?: RequestInit): Promise<any> {
  return api(path, {
    ...init,
    headers: {
      "x-bot-token": botApiToken,
      "x-internal-token": internalApiToken,
      "x-discord-user-id": discordId,
      ...(init?.headers ?? {})
    }
  });
}

async function getTextChannel(channelId: string): Promise<TextChannel | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel as TextChannel;
}

async function safeDeleteMessage(message: Message): Promise<void> {
  try {
    if (message.deletable) await message.delete();
  } catch {
    // no-op
  }
}

function panelMarker(key: PanelKey): string {
  return `fraghub-panel:${key}`;
}

function parsePanelKey(marker?: string | null): PanelKey | null {
  if (!marker) return null;
  const prefix = "fraghub-panel:";
  if (!marker.startsWith(prefix)) return null;
  const value = marker.slice(prefix.length);
  if (value === "verify" || value === "queue" || value === "mapVote" || value === "serverStatus") return value;
  return null;
}
async function findExistingPanelMessage(channel: TextChannel, key: PanelKey): Promise<Message | null> {
  const knownId = panelMessageIds.get(key);
  if (knownId) {
    try {
      return await channel.messages.fetch(knownId);
    } catch {
      panelMessageIds.delete(key);
    }
  }

  const pinned = await channel.messages.fetchPinned();
  const fromPinned = pinned.find((m) => parsePanelKey(m.embeds[0]?.footer?.text) === key);
  if (fromPinned) {
    panelMessageIds.set(key, fromPinned.id);
    return fromPinned;
  }

  const recent = await channel.messages.fetch({ limit: 50 });
  const found = recent.find((m) => parsePanelKey(m.embeds[0]?.footer?.text) === key);
  if (found) panelMessageIds.set(key, found.id);
  return found ?? null;
}

async function cleanupManagedChannel(channel: TextChannel, keepMessageId: string): Promise<void> {
  const messages = await channel.messages.fetch({ limit: 100 });
  for (const message of messages.values()) {
    if (message.id === keepMessageId) continue;
    await safeDeleteMessage(message);
  }
}

async function upsertPanel(key: PanelKey, payload: { embed: EmbedBuilder; components?: ActionRowBuilder<ButtonBuilder>[] }): Promise<void> {
  const channelId =
    key === "verify" ? channelIds.verify : key === "queue" ? channelIds.queue : key === "mapVote" ? channelIds.mapVote : channelIds.serverStatus;

  const channel = await getTextChannel(channelId);
  if (!channel) return;

  payload.embed.setFooter({ text: panelMarker(key) });
  const existing = await findExistingPanelMessage(channel, key);
  const panelMessage = existing
    ? await existing.edit({ embeds: [payload.embed], components: payload.components ?? [] })
    : await channel.send({ embeds: [payload.embed], components: payload.components ?? [] });

  panelMessageIds.set(key, panelMessage.id);
  if (!panelMessage.pinned) {
    await panelMessage.pin().catch(() => undefined);
  }
  await cleanupManagedChannel(channel, panelMessage.id);
}

async function getVerificationStatus(discordId: string): Promise<any | null> {
  try {
    return await botApi(`/internal/verification/status/${discordId}`);
  } catch {
    return null;
  }
}

async function updateVerificationRoles(discordId: string, status: any | null): Promise<void> {
  if (!guildId || !discordId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordId);
    const verified = Boolean(status?.verified);
    const hasUsername = Boolean(status?.username);

    if (roleIds.unverified && verified && member.roles.cache.has(roleIds.unverified)) {
      await member.roles.remove(roleIds.unverified).catch(() => undefined);
    }
    if (roleIds.steamVerified && verified && !member.roles.cache.has(roleIds.steamVerified)) {
      await member.roles.add(roleIds.steamVerified).catch(() => undefined);
    }
    if (roleIds.verified && verified && hasUsername && !member.roles.cache.has(roleIds.verified)) {
      await member.roles.add(roleIds.verified).catch(() => undefined);
    }

    const displayName = String(status?.display_name ?? "").trim();
    if (displayName) {
      await member.setNickname(displayName).catch(() => undefined);
    }
  } catch {
    // no-op
  }
}

async function buildVerifyPanelEmbed(): Promise<EmbedBuilder> {
  return baseEmbed("ðŸ›¡ Verification")
    .setDescription([
      "1. Click Verify Now",
      "2. Solve captcha",
      "3. Link Steam",
      "4. Set username with /username <name>",
      "",
      "Only verified users can fully use matchmaking features."
    ].join("\n"));
}

async function buildQueuePanelEmbed(): Promise<EmbedBuilder> {
  return buildQueueOverviewEmbed();
}

async function buildMapVotePanelEmbed(): Promise<EmbedBuilder> {
  try {
    const daily = await api("/maps/daily");
    const maps = Array.isArray(daily?.maps) ? daily.maps : [];
    return baseEmbed("ðŸŽ® Daily Map Pool").setDescription(maps.length ? maps.map((m: string) => `- ${m}`).join("\n") : "No active map pool.");
  } catch {
    return baseEmbed("ðŸŽ® Daily Map Pool", "Map pool unavailable.");
  }
}

async function fetchPresenceStats(force = false): Promise<PresenceStats> {
  const now = Date.now();
  if (!force && presenceCache && now - presenceCache.fetchedAt < 10_000) return presenceCache.stats;

  const stats: PresenceStats = { liveMatches: 0, serversOnline: 0, playersQueue: 0 };

  try {
    const live = await api("/matches/live");
    stats.liveMatches = Array.isArray(live) ? live.length : 0;
  } catch {}

  try {
    const servers = await serverApi("/servers");
    stats.serversOnline = Array.isArray(servers) ? servers.filter((s: any) => String(s.state ?? "") === "running").length : 0;
  } catch {}

  try {
    for (const mode of ["ranked", "wingman", "casual", "clanwars"] as const) {
      const status = await api(`/queue/status?mode=${mode}`);
      stats.playersQueue += Number(status?.size ?? 0);
    }
  } catch {}

  presenceCache = { stats, fetchedAt: now };
  return stats;
}

async function buildServerStatusPanelEmbed(): Promise<EmbedBuilder> {
  const stats = await fetchPresenceStats();
  return baseEmbed("ðŸŽ® FragHub Server Status")
    .setDescription("Live platform health and activity")
    .addFields(
      { name: "Live Matches", value: String(stats.liveMatches), inline: true },
      { name: "Servers Online", value: String(stats.serversOnline), inline: true },
      { name: "Players in Queue", value: String(stats.playersQueue), inline: true }
    );
}

function verifyPanelButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("verify_now").setLabel("Verify Now").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("verify_check").setLabel("Check Verification").setStyle(ButtonStyle.Primary)
    )
  ];
}

function queuePanelButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("queue_join_ranked").setLabel("🔥 Join Ranked").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("queue_join_wingman").setLabel("⚡ Join Wingman").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("queue_join_casual").setLabel("🎉 Join Casual").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("queue_join_clanwars").setLabel("🛡 Join Clan War").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("queue_leave").setLabel("❌ Leave Queue").setStyle(ButtonStyle.Danger)
    )
  ];
}

function mapVotePanelButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("mapvote_refresh").setLabel("Refresh").setStyle(ButtonStyle.Primary))];
}

async function refreshPanels(): Promise<void> {
  await upsertPanel("verify", { embed: await buildVerifyPanelEmbed(), components: verifyPanelButtons() });
  await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
  await upsertPanel("mapVote", { embed: await buildMapVotePanelEmbed(), components: mapVotePanelButtons() });
  await upsertPanel("serverStatus", { embed: await buildServerStatusPanelEmbed() });
}

async function postToChannel(channelId: string, embed: EmbedBuilder): Promise<void> {
  const channel = await getTextChannel(channelId);
  if (!channel) return;
  await channel.send({ embeds: [embed] });
}
async function handleVerifyCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const status = await getVerificationStatus(interaction.user.id);
  if (!status?.verified) {
    await replyEmbed(
      interaction,
      baseEmbed("ðŸ›¡ Verification Required", "Open #verify, click **Verify Now**, complete captcha and Steam link.")
    );
    return;
  }

  if (!status.username) {
    await replyEmbed(interaction, baseEmbed("ðŸ›¡ Almost Done", "Steam linked. Set your username with `/username <name>`."));
    return;
  }

  await updateVerificationRoles(interaction.user.id, status);
  await replyEmbed(interaction, baseEmbed("ðŸ›¡ Verification Complete", `Verified as **${status.display_name ?? status.username}**.`));
}

async function handleUsernameCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.options.getString("name", true);
  const result = await userApi("/internal/player/username", interaction.user.id, {
    method: "POST",
    body: JSON.stringify({ username })
  });
  const status = await getVerificationStatus(interaction.user.id);
  await updateVerificationRoles(interaction.user.id, status);
  await replyEmbed(interaction, baseEmbed("ðŸ‘¤ Username Updated", `Username set to **${result.username}**.`));
}

async function handleUsernameChange(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.options.getString("newname", true);
  const result = await userApi("/internal/player/username/change", interaction.user.id, {
    method: "POST",
    body: JSON.stringify({ username })
  });
  const status = await getVerificationStatus(interaction.user.id);
  await updateVerificationRoles(interaction.user.id, status);
  await replyEmbed(interaction, baseEmbed("ðŸ‘¤ Username Updated", `Username changed to **${result.username}**.`));
}

async function handleTagChange(interaction: ChatInputCommandInteraction): Promise<void> {
  const tagType = interaction.options.getString("type", true);
  const result = await userApi("/internal/player/tag", interaction.user.id, {
    method: "POST",
    body: JSON.stringify({ selected_tag_type: tagType })
  });
  const status = await getVerificationStatus(interaction.user.id);
  await updateVerificationRoles(interaction.user.id, status);
  await replyEmbed(interaction, baseEmbed("ðŸ‘¤ Tag Updated", `Display name: **${result.display_name}**`));
}

async function resolveSteamIdForDiscord(discordId: string): Promise<string | null> {
  const status = await getVerificationStatus(discordId);
  if (!status?.verified || !status?.steam_id) return null;
  return String(status.steam_id);
}

async function handleQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ embeds: [await buildQueuePanelEmbed()], components: queuePanelButtons(), ephemeral: true });
}

async function handleServersCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  type ServerRow = {
    server_id?: string;
    container_name?: string | null;
    state?: string;
    status?: string;
    server_ip?: string;
    port?: number;
    mode?: string;
  };
  type LiveMatchRow = {
    server_id?: string | null;
    server_ip?: string | null;
    server_port?: number | null;
    mode?: string;
    players?: Array<unknown>;
  };

  const [serversRaw, liveMatchesRaw] = await Promise.all([
    serverApi("/servers").catch(() => []),
    api("/matches/live").catch(() => [])
  ]);

  const servers = Array.isArray(serversRaw) ? (serversRaw as ServerRow[]) : [];
  const liveMatches = Array.isArray(liveMatchesRaw) ? (liveMatchesRaw as LiveMatchRow[]) : [];

  const liveByServer = new Map<
    string,
    { players: number; mode: QueueMode }
  >();
  for (const m of liveMatches) {
    const serverId = String(m.server_id ?? "");
    if (!serverId) continue;
    const mode = (String(m.mode ?? "ranked") as QueueMode);
    const players = Array.isArray(m.players) ? m.players.length : 0;
    liveByServer.set(serverId, { players, mode: QUEUE_MODES.includes(mode) ? mode : "ranked" });
  }

  const sorted = [...servers].sort((a, b) => Number(a.port ?? 0) - Number(b.port ?? 0));
  const embed = baseEmbed("🖥 FragHub Server Status");

  sorted.forEach((server, idx) => {
    const name = `Frankfurt #${idx + 1}`;
    const isOnline = String(server.state ?? "").toLowerCase() === "running";
    const live = liveByServer.get(String(server.server_id ?? ""));
    const mode = live?.mode ?? (QUEUE_MODES.includes(String(server.mode ?? "") as QueueMode) ? (String(server.mode) as QueueMode) : "ranked");
    const maxPlayers = MODE_META[mode].maxPlayers;
    const players = live?.players ?? 0;
    const value = isOnline
      ? `Online\nPlayers: ${players} / ${maxPlayers}`
      : "Offline";
    embed.addFields({ name, value, inline: false });
  });

  embed.addFields(
    { name: "Total Servers", value: String(sorted.length), inline: true },
    { name: "Live Matches", value: String(liveMatches.length), inline: true }
  );

  await replyEmbed(interaction, embed);
}

function formatPercent(value: number): string {
  return `${Math.max(0, Number(value || 0)).toFixed(0)}%`;
}

async function handleProfileCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = await resolveSteamIdForDiscord(interaction.user.id);
  if (!steamId) {
    await replyEmbed(interaction, baseEmbed("👤 Player Profile", "Complete verification first."));
    return;
  }

  const profile = await botApi(`/internal/player/stats/${encodeURIComponent(steamId)}`);
  const matchesPlayed = Number(profile?.stats?.matches_played ?? 0);
  const wins = Number(profile?.stats?.wins ?? 0);
  const rank = String(profile?.player?.player_rank ?? rankFromElo(1000));
  const winrate = Number(profile?.performance?.win_rate ?? (matchesPlayed > 0 ? (wins / matchesPlayed) * 100 : 0));
  const kdRatio = Number(profile?.performance?.kd_ratio ?? 0);
  const clutchWinRate = Number(profile?.performance?.clutch_win_rate ?? 0);
  const recentMatches = Array.isArray(profile?.recent_matches) ? profile.recent_matches : [];
  const recentLine = recentMatches.length ? recentMatches.map((r: string) => (String(r).toLowerCase() === "win" ? "Win" : "Loss")).join(" • ") : "-";

  const embed = baseEmbed("👤 Player Profile").addFields(
    { name: "Rank", value: rank, inline: true },
    { name: "Matches Played", value: String(matchesPlayed), inline: true },
    { name: "Wins", value: String(wins), inline: true },
    { name: "Winrate", value: formatPercent(winrate), inline: true },
    { name: "K/D Ratio", value: kdRatio.toFixed(2), inline: true },
    { name: "Clutch Win Rate", value: formatPercent(clutchWinRate), inline: true },
    { name: "Recent Matches", value: recentLine, inline: false }
  );

  await replyEmbed(interaction, embed);
}

function lobbyButtons(matchId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ready_match:${matchId}`).setLabel("Ready").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`report_player:${matchId}`).setLabel("Report Player").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`leave_match:${matchId}`).setLabel("Leave Match").setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildMatchLobbyEmbed(state: {
  mode: QueueMode;
  mapPool: string[];
  teamALines: string[];
  teamBLines: string[];
  readyPlayerIds: Set<string>;
  requiredPlayers: number;
}): EmbedBuilder {
  const ready = state.readyPlayerIds.size;
  const progress = progressBar(ready, state.requiredPlayers);
  return baseEmbed("🔥 Match Found")
    .addFields(
      { name: "Mode", value: modeLabel(state.mode), inline: true },
      { name: "Map Pool", value: state.mapPool.join(" • "), inline: false },
      { name: "Players", value: `${state.requiredPlayers} / ${state.requiredPlayers}`, inline: true },
      { name: "Team A", value: state.teamALines.join("\n") || "-", inline: true },
      { name: "Team B", value: state.teamBLines.join("\n") || "-", inline: true },
      { name: "Players Ready", value: `${ready} / ${state.requiredPlayers}`, inline: true },
      { name: "Progress", value: progress, inline: false }
    );
}

async function handleClanCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subCommand = interaction.options.getSubcommand(true);

  if (subCommand === "create") {
    const clanName = interaction.options.getString("name", true);
    const clanTag = interaction.options.getString("tag", true);
    const res = await userApi("/internal/clan/create-request", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ clan_name: clanName, clan_tag: clanTag })
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Clan Request Submitted", `Request for **[${res.clan_tag}] ${res.clan_name}** is now **${res.status}**.`));
    return;
  }

  if (subCommand === "join") {
    const clanTag = interaction.options.getString("tag", true);
    const res = await userApi("/internal/clan/join-request", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ clan_tag: clanTag })
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Join Request Sent", `Requested to join **[${res.clan_tag}] ${res.clan_name}**.`));
    return;
  }

  if (subCommand === "approve") {
    const player = interaction.options.getString("player", true);
    const res = await userApi("/internal/clan/approve-member", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ player })
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Member Approved", `Approved **${res.player_steam_id}** into **${res.clan_tag}**.`));
    return;
  }

  if (subCommand === "invite") {
    const player = interaction.options.getString("player", true);
    const res = await userApi("/internal/clan/invite", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ player })
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Invite Sent", `Invited **${res.player_steam_id}** into **${res.clan_tag}**.`));
    return;
  }

  if (subCommand === "kick") {
    const player = interaction.options.getString("player", true);
    const res = await userApi("/internal/clan/kick", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ player })
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Member Removed", `Kicked **${res.player_steam_id}** from **${res.clan_tag}**.`));
    return;
  }

  if (subCommand === "leave") {
    const res = await userApi("/internal/clan/leave", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({})
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Clan Updated", res.disbanded ? "Clan disbanded." : "You left the clan."));
    return;
  }

  if (subCommand === "info") {
    const tag = interaction.options.getString("tag");
    const steamId = await resolveSteamIdForDiscord(interaction.user.id);
    const query = tag
      ? `/internal/clan/info?tag=${encodeURIComponent(tag)}`
      : steamId
      ? `/internal/clan/info?steam_id=${encodeURIComponent(steamId)}`
      : "";

    if (!query) {
      await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Clan Info", "Verify first or provide `/clan info <tag>`."));
      return;
    }

    const res = await botApi(query);
    await interaction.reply({
      embeds: [
        baseEmbed(`ðŸ‘¥ [${res.clan.clan_tag}] ${res.clan.clan_name}`)
          .setTitle(`[${res.clan.clan_tag}] ${res.clan.clan_name}`)
          .setDescription([
            `Rating: ${res.rating.rating}`,
            `Rank: ${res.rating.rank ?? "-"}`,
            `W/L: ${res.rating.wins}/${res.rating.losses}`,
            `Matches: ${res.rating.matches_played}`,
            `Members: ${(res.members ?? []).length}`
          ].join("\n"))
      ]
    });
    return;
  }

  if (subCommand === "leaderboard") {
    const limit = interaction.options.getInteger("limit") ?? 10;
    const res = await botApi(`/internal/clan/leaderboard?limit=${limit}`);
    const lines = (res.leaderboard ?? []).map((r: any) => `#${r.rank} ${r.clan_tag} - ${r.rating}`);
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Clan Leaderboard", lines.join("\n") || "No data"));
    return;
  }

  if (subCommand === "request-approve") {
    const member = (interaction.member as GuildMember | null) ?? null;
    if (!isAdmin(member)) {
      await replyEmbed(interaction, baseEmbed("ðŸ›¡ Permission Denied", "Only Admin or Owner can approve clan requests."));
      return;
    }
    const requestId = interaction.options.getString("request_id", true);
    const res = await userApi(`/internal/clan/request/${requestId}/approve`, interaction.user.id, {
      method: "POST",
      body: JSON.stringify({})
    });

    if (guildId && res?.owner_discord_id && res?.clan_tag) {
      const guild = await client.guilds.fetch(guildId);
      const roleName = `[${res.clan_tag}] ${res.clan_name ?? "Clan"}`;
      let clanRole = guild.roles.cache.find((r) => r.name === roleName) ?? null;
      if (!clanRole) {
        clanRole = await guild.roles.create({
          name: roleName,
          color: EMBED_COLOR,
          mentionable: true,
          reason: `Clan approved: ${res.clan_tag}`
        });
      }
      clanRoleIdByTag.set(String(res.clan_tag).toUpperCase(), clanRole.id);
      const ownerMember = await guild.members.fetch(String(res.owner_discord_id)).catch(() => null);
      if (ownerMember) {
        await ownerMember.roles.add(clanRole).catch(() => undefined);
      }
    }

    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Clan Approved", `Approved clan request for **[${res.clan_tag}] ${res.clan_name}**.`));
    return;
  }

  if (subCommand === "request-reject") {
    const member = (interaction.member as GuildMember | null) ?? null;
    if (!isAdmin(member)) {
      await replyEmbed(interaction, baseEmbed("ðŸ›¡ Permission Denied", "Only Admin or Owner can reject clan requests."));
      return;
    }
    const requestId = interaction.options.getString("request_id", true);
    const reason = interaction.options.getString("reason") ?? "Rejected";
    await userApi(`/internal/clan/request/${requestId}/reject`, interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    await replyEmbed(interaction, baseEmbed("ðŸ‘¥ Clan Rejected", `Request rejected: ${reason}`));
  }
}
async function handleSkinsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = interaction.options.getString("steamid", true);
  const weapon = interaction.options.getString("weapon", true);
  const skin = interaction.options.getString("skin", true);

  await botApi("/player/skins", {
    method: "POST",
    body: JSON.stringify({ steam_id: steamId, weapon, skin_id: skin })
  });

  await replyEmbed(interaction, baseEmbed("ðŸŽ® Skin Updated", `Saved **${weapon}** skin: **${skin}**`));
}

async function handleMatchEndCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const matchId = interaction.options.getString("matchid", true);
  const scoreA = interaction.options.getInteger("score_a") ?? 13;
  const scoreB = interaction.options.getInteger("score_b") ?? 8;
  const demoUrl = interaction.options.getString("demo_url") ?? `https://play.maro.run/demos/${matchId}.dem`;

  await botApi(`/internal/matches/${matchId}/end`, {
    method: "POST",
    body: JSON.stringify({ demoUrl, teamAScore: scoreA, teamBScore: scoreB })
  });

  await replyEmbed(interaction, baseEmbed("ðŸ”¥ Match Finalized", `Match ended with score **${scoreA}-${scoreB}**.`));
}

async function handleTestMatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const mode = (interaction.options.getString("mode") ?? "ranked") as QueueMode;
  const result = await botApi("/internal/test/match-bots", {
    method: "POST",
    body: JSON.stringify({ mode, region: defaultRegion })
  });
  const queueEmbed = await buildQueueJoinedEmbed(mode, 1000, Number(result.queue_size ?? 0));
  await replyEmbed(
    interaction,
    baseEmbed("🧪 Test Match Started", `Simulating full pipeline for **${modeLabel(mode)}** (queue -> vote -> server -> match).`)
  );
  await interaction.followUp({ embeds: [queueEmbed], components: queuePanelButtons(), ephemeral: true });
}

function createCaptcha(discordId: string): { nonce: string; question: string } {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const answer = String(a + b);
  const nonce = crypto.randomBytes(8).toString("hex");
  captchaState.set(discordId, { nonce, answer, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { nonce, question: `${a} + ${b}` };
}

function buildVerifyCaptchaModal(customId: string, question: string): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle("FragHub Captcha");
  const input = new TextInputBuilder()
    .setCustomId("captcha_answer")
    .setLabel(`Solve: ${question}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}

async function startVerificationFlow(discordId: string): Promise<string> {
  const result = await botApi("/internal/verification/start", {
    method: "POST",
    body: JSON.stringify({ discord_id: discordId })
  });
  return String(result.verify_url ?? result.url);
}

async function rotatePresence(): Promise<void> {
  if (!client.user) return;

  const fallback = "FragHub Matchmaking";
  let messages = [fallback, fallback, fallback, fallback];

  try {
    const stats = await fetchPresenceStats();
    messages = [
      `${stats.liveMatches} Live Matches`,
      `${stats.serversOnline} Servers Online`,
      `${stats.playersQueue} Players in Queue`,
      "FragHub Matchmaking"
    ];
  } catch {
    // no-op
  }

  const message = messages[presenceIndex % messages.length] ?? fallback;
  presenceIndex = (presenceIndex + 1) % messages.length;

  await client.user.setPresence({ activities: [{ name: message, type: ActivityType.Watching }], status: "online" });
}

async function registerCommands(): Promise<void> {
  if (!client.application) return;

  const commands: any[] = [
    new SlashCommandBuilder().setName("verify").setDescription("Check verification status"),
    new SlashCommandBuilder().setName("servers").setDescription("Show server health monitor"),
    new SlashCommandBuilder().setName("profile").setDescription("Show your player profile"),
    new SlashCommandBuilder()
      .setName("username")
      .setDescription("Set your FragHub username")
      .addStringOption((opt) => opt.setName("name").setDescription("3-16 letters/numbers/_").setRequired(true)),
    new SlashCommandBuilder()
      .setName("username-change")
      .setDescription("Change your username (30 days cooldown)")
      .addStringOption((opt) => opt.setName("newname").setDescription("New username").setRequired(true)),
    new SlashCommandBuilder()
      .setName("tag")
      .setDescription("Select visible tag")
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("Tag type")
          .setRequired(true)
          .addChoices(
            { name: "No Tag", value: "none" },
            { name: "Clan", value: "clan" },
            { name: "Developer", value: "dev" },
            { name: "Admin", value: "admin" },
            { name: "Moderator", value: "mod" }
          )
      ),
    new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Join or leave queue")
      .addStringOption((opt) =>
        opt
          .setName("action")
          .setDescription("Queue action")
          .setRequired(false)
          .addChoices({ name: "join", value: "join" }, { name: "leave", value: "leave" })
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Queue mode")
          .setRequired(false)
          .addChoices(
            { name: "ranked", value: "ranked" },
            { name: "wingman", value: "wingman" },
            { name: "casual", value: "casual" },
            { name: "clanwars", value: "clanwars" }
          )
      )
      .addStringOption((opt) => opt.setName("region").setDescription("Region").setRequired(false)),
    new SlashCommandBuilder().setName("matchend").setDescription("Mark a match as ended and trigger ranking update")
      .addStringOption((opt) => opt.setName("matchid").setDescription("Match ID").setRequired(true))
      .addIntegerOption((opt) => opt.setName("score_a").setDescription("Team A score").setRequired(false))
      .addIntegerOption((opt) => opt.setName("score_b").setDescription("Team B score").setRequired(false))
      .addStringOption((opt) => opt.setName("demo_url").setDescription("Demo URL").setRequired(false)),
    new SlashCommandBuilder().setName("skins").setDescription("Set cosmetic skin")
      .addStringOption((opt) => opt.setName("steamid").setDescription("Steam ID").setRequired(true))
      .addStringOption((opt) => opt.setName("weapon").setDescription("Weapon").setRequired(true))
      .addStringOption((opt) => opt.setName("skin").setDescription("Skin id").setRequired(true))
  ];

  if (enableTestMode) {
    commands.push(
      new SlashCommandBuilder()
        .setName("testmatch")
        .setDescription("Start a bot-only 5v5 test match")
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("Test mode")
            .addChoices(
              { name: "ranked (5v5 bots)", value: "ranked" },
              { name: "clanwars (5v5 bots)", value: "clanwars" }
            )
        )
    );
  }

  const clanCommand = new SlashCommandBuilder()
    .setName("clan")
    .setDescription("Clan management")
    .addSubcommand((sub) => sub.setName("create").setDescription("Create clan request").addStringOption((opt) => opt.setName("name").setDescription("Clan name").setRequired(true)).addStringOption((opt) => opt.setName("tag").setDescription("Clan tag").setRequired(true)))
    .addSubcommand((sub) => sub.setName("join").setDescription("Request to join clan").addStringOption((opt) => opt.setName("tag").setDescription("Clan tag").setRequired(true)))
    .addSubcommand((sub) => sub.setName("approve").setDescription("Owner: approve member").addStringOption((opt) => opt.setName("player").setDescription("Username or SteamID").setRequired(true)))
    .addSubcommand((sub) => sub.setName("invite").setDescription("Owner: invite member").addStringOption((opt) => opt.setName("player").setDescription("Username or SteamID").setRequired(true)))
    .addSubcommand((sub) => sub.setName("kick").setDescription("Owner: kick member").addStringOption((opt) => opt.setName("player").setDescription("Username or SteamID").setRequired(true)))
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave current clan"))
    .addSubcommand((sub) => sub.setName("info").setDescription("Show clan info").addStringOption((opt) => opt.setName("tag").setDescription("Clan tag").setRequired(false)))
    .addSubcommand((sub) => sub.setName("leaderboard").setDescription("Top clans").addIntegerOption((opt) => opt.setName("limit").setDescription("Top N").setRequired(false)))
    .addSubcommand((sub) => sub.setName("request-approve").setDescription("Staff: approve clan creation request").addStringOption((opt) => opt.setName("request_id").setDescription("Request ID").setRequired(true)))
    .addSubcommand((sub) => sub.setName("request-reject").setDescription("Staff: reject clan creation request").addStringOption((opt) => opt.setName("request_id").setDescription("Request ID").setRequired(true)).addStringOption((opt) => opt.setName("reason").setDescription("Reason").setRequired(false)));

  commands.push(clanCommand);

  const payload = commands.map((cmd) => cmd.toJSON());
  if (guildId) await client.application.commands.set(payload, guildId);
  else await client.application.commands.set(payload);
}
async function postLiveMatchEvent(event: any): Promise<void> {
  const matchId = String(event.matchId ?? event.match_id ?? "unknown");
  if (event.type === "match_found") {
    const mode = String(event.mode ?? "ranked") as QueueMode;
    const players = Array.isArray(event.players) ? event.players.length : MODE_META[mode]?.maxPlayers ?? 10;
    const teamA = Array.isArray(event.team_a) ? event.team_a : [];
    const teamB = Array.isArray(event.team_b) ? event.team_b : [];
    const allEntries = [...teamA, ...teamB] as Array<{ player_id?: string; elo?: number }>;
    const avgElo = allEntries.length
      ? allEntries.reduce((sum, row) => sum + Number(row.elo ?? 1000), 0) / allEntries.length
      : 1000;
    const avgRank = rankFromElo(avgElo);
    const mapPool = Array.isArray(event.daily_map_pool) && event.daily_map_pool.length
      ? event.daily_map_pool.map((m: string) => String(m)).join(" • ")
      : "Dust2 • Mirage • Inferno • Nuke";
    const playerIds = allEntries.map((row) => String(row.player_id ?? "")).filter(Boolean);
    const cards = playerIds.length
      ? await botApi("/internal/player/cards", {
          method: "POST",
          body: JSON.stringify({ player_ids: playerIds.slice(0, 10) })
        }).catch(() => ({ cards: [] }))
      : { cards: [] as any[] };
    const cardsById = new Map<string, { display_name: string; player_rank: string }>(
      (Array.isArray(cards.cards) ? cards.cards : []).map((card: any) => [
        String(card.player_id),
        {
          display_name: String(card.display_name ?? "Player"),
          player_rank: String(card.player_rank ?? rankFromElo(1000))
        }
      ])
    );
    const teamALines = teamA.map((row: any) => {
      const card = cardsById.get(String(row.player_id));
      const name = card?.display_name ?? "Player";
      const rank = card?.player_rank ?? rankFromElo(Number(row.elo ?? 1000));
      return `${name}\nRank: ${rank}`;
    });
    const teamBLines = teamB.map((row: any) => {
      const card = cardsById.get(String(row.player_id));
      const name = card?.display_name ?? "Player";
      const rank = card?.player_rank ?? rankFromElo(Number(row.elo ?? 1000));
      return `${name}\nRank: ${rank}`;
    });

    matchConnectionCache.set(matchId, {
      mode,
      map: String(event.map ?? event.daily_map_pool?.[0] ?? "TBD"),
      serverName: "Frankfurt #3",
      players
    });
    const embed = buildMatchLobbyEmbed({
      mode,
      mapPool: mapPool.split(" • ").map((m: string) => m.trim()).filter(Boolean),
      teamALines,
      teamBLines,
      readyPlayerIds: new Set<string>(),
      requiredPlayers: players
    }).addFields({ name: "Average Rank", value: avgRank, inline: true });

    const channel = await getTextChannel(channelIds.liveMatches || channelIds.queue);
    if (channel) {
      const message = await channel.send({ embeds: [embed], components: lobbyButtons(matchId) });
      const state = {
        mode,
        mapPool: mapPool.split(" • ").map((m: string) => m.trim()).filter(Boolean),
        teamAIds: teamA.map((row: any) => String(row.player_id)),
        teamBIds: teamB.map((row: any) => String(row.player_id)),
        teamALines,
        teamBLines,
        readyPlayerIds: new Set<string>(),
        requiredPlayers: players,
        channelId: channel.id,
        messageId: message.id,
        timeoutHandle: setTimeout(async () => {
          const current = matchLobbyState.get(matchId);
          if (!current) return;
          if (current.readyPlayerIds.size >= current.requiredPlayers) return;
          const cancelEmbed = baseEmbed("❌ Match Cancelled", "Not all players readied within 30 seconds.")
            .addFields(
              { name: "Players Ready", value: `${current.readyPlayerIds.size} / ${current.requiredPlayers}`, inline: true },
              { name: "Progress", value: progressBar(current.readyPlayerIds.size, current.requiredPlayers), inline: false }
            );
          const lobbyChannel = await getTextChannel(current.channelId);
          if (lobbyChannel) {
            const lobbyMessage = await lobbyChannel.messages.fetch(current.messageId).catch(() => null);
            if (lobbyMessage) await lobbyMessage.edit({ embeds: [cancelEmbed], components: [] }).catch(() => undefined);
          }
          matchLobbyState.delete(matchId);
        }, 30_000)
      };
      matchLobbyState.set(matchId, state);
    }
    return;
  }

  if (event.type === "match_started") {
    const lobby = matchLobbyState.get(matchId);
    if (lobby) {
      clearTimeout(lobby.timeoutHandle);
      matchLobbyState.delete(matchId);
    }
    const mode = String(event.mode ?? "ranked") as QueueMode;
    const map = String(event.map ?? "TBD");
    const conn = event.connection_data ?? {};
    const players = Number((Array.isArray(event.players) ? event.players.length : 0) || MODE_META[mode]?.maxPlayers || 10);
    matchConnectionCache.set(matchId, {
      mode,
      map,
      serverName: "Frankfurt #2",
      players,
      serverIp: String(conn.server_ip ?? ""),
      port: Number(conn.port ?? 27015),
      serverPassword: String(conn.server_password ?? ""),
      spectatorPassword: String(conn.spectator_password ?? "")
    });
    const joinCommand = `connect ${String(conn.server_ip ?? "")}:${Number(conn.port ?? 27015)}; password ${String(conn.server_password ?? "")}`;
    const embed = baseEmbed("🚀 Match Server Ready")
      .addFields(
        { name: "Server", value: "Frankfurt #2", inline: true },
        { name: "Map", value: map, inline: true },
        { name: "Mode", value: modeLabel(mode), inline: true },
        { name: "Join Command", value: `\`\`\`\n${joinCommand}\n\`\`\``, inline: false }
      );
    const buttons = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`join_server:${matchId}`).setLabel("Join Server").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`copy_connect:${matchId}`).setLabel("Copy Connect Command").setStyle(ButtonStyle.Secondary)
      )
    ];
    const channel = await getTextChannel(channelIds.liveMatches || channelIds.queue);
    if (channel) await channel.send({ embeds: [embed], components: buttons });
    return;
  }
  if (event.type === "match_finished") {
    const finalScore = String(event.finalScore ?? "0-0");
    await postToChannel(channelIds.matchResults || channelIds.liveMatches, baseEmbed("ðŸ”¥ Match Finished", `Match \`${matchId}\` finished (**${finalScore}**).`));
  }
}

async function handlePubsubEvent(channel: string, event: any): Promise<void> {
  if (channel === "queue-events") {
    await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
    return;
  }

  if (channel === "match-events") {
    await postLiveMatchEvent(event);
    if (event.type === "match_finished") {
      await upsertPanel("serverStatus", { embed: await buildServerStatusPanelEmbed() });
    }
    return;
  }

  if (channel === "overwatch-events") {
    if (event.type === "case_created") {
      await postToChannel(
        channelIds.reports || channelIds.cheaterAlerts,
        baseEmbed("ðŸ›¡ Overwatch Case Created", `Case ${event.case?.id ?? "?"} for player ${event.case?.reported_player_id ?? "?"}`)
      );
      return;
    }

    if (event.type === "anti_cheat_alert" || event.type === "cheat_alert" || event.type === "steam_link_flagged") {
      await postToChannel(channelIds.cheaterAlerts, baseEmbed("ðŸ›¡ Cheater Alert", `Event: ${event.type}`));
      return;
    }

    if (event.type === "ban_evasion_case_updated" && (event.action === "ban" || event.status === "banned")) {
      await postToChannel(channelIds.banLog, baseEmbed("ðŸ›¡ Ban Event", `Ban evasion case ${event.case_id} updated to ${event.status}`));
    }
    return;
  }

  if (channel === "moderation-events") {
    if (event.type === "clan_request_created") {
      await postToChannel(
        channelIds.modLog || channelIds.updates,
        baseEmbed("ðŸ‘¥ Clan Request")
          .setDescription(`Applicant: ${event.applicant_username ?? event.applicant_steam_id}`)
          .addFields(
            { name: "Clan Name", value: String(event.clan_name ?? "-"), inline: true },
            { name: "Clan Tag", value: String(event.clan_tag ?? "-"), inline: true },
            { name: "Request ID", value: String(event.request_id ?? "-"), inline: false }
          )
      );
      return;
    }

    if (event.type === "clan_request_resolved") {
      await postToChannel(channelIds.updates, baseEmbed("ðŸ‘¥ Clan Request Resolved", `Request ${event.request_id} ${event.decision}`));
    }
    return;
  }

  if (channel === "security-events") {
    await postToChannel(channelIds.cheaterAlerts, baseEmbed("ðŸ›¡ Security Event", `${event.type ?? "event"}`));
  }
}

client.on("ready", async () => {
  console.log(`Discord bot connected as ${client.user?.tag}`);

  if (client.user) {
    await client.user.setPresence({
      activities: [{ name: "Starting FragHub systems...", type: ActivityType.Watching }],
      status: "online"
    });
  }

  await registerCommands();
  await refreshPanels();
  await rotatePresence();

  setInterval(async () => {
    await rotatePresence().catch(() => undefined);
  }, 15_000);

  setInterval(async () => {
    await upsertPanel("serverStatus", { embed: await buildServerStatusPanelEmbed() }).catch(() => undefined);
  }, 15_000);

  setInterval(async () => {
    await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() }).catch(() => undefined);
  }, 20_000);
});

client.on("messageCreate", async (message) => {
  if (!managedPanelChannels.some((key) => channelIds[key] && message.channelId === channelIds[key])) return;

  const key = managedPanelChannels.find((k) => channelIds[k] === message.channelId) as PanelKey | undefined;
  if (!key) return;

  // Never delete bot/system messages in managed channels.
  if (message.author.bot || message.system) return;

  // Preserve the managed panel message even if in-memory cache is empty after restart.
  const marker = message.embeds[0]?.footer?.text;
  if (parsePanelKey(marker) === key) return;

  const keep = panelMessageIds.get(key);
  if (keep && message.id === keep) return;
  await safeDeleteMessage(message);
});
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "verify") {
        await handleVerifyCommand(interaction);
        return;
      }
      if (interaction.commandName === "servers") {
        await handleServersCommand(interaction);
        return;
      }
      if (interaction.commandName === "profile") {
        await handleProfileCommand(interaction);
        return;
      }
      if (interaction.commandName === "username") {
        await handleUsernameCreate(interaction);
        return;
      }
      if (interaction.commandName === "username-change") {
        await handleUsernameChange(interaction);
        return;
      }
      if (interaction.commandName === "tag") {
        await handleTagChange(interaction);
        return;
      }
      if (interaction.commandName === "queue") {
        await handleQueueCommand(interaction);
        return;
      }
      if (interaction.commandName === "clan") {
        await handleClanCommand(interaction);
        return;
      }
      if (interaction.commandName === "skins") {
        await handleSkinsCommand(interaction);
        return;
      }
      if (interaction.commandName === "matchend") {
        await handleMatchEndCommand(interaction);
        return;
      }
      if (interaction.commandName === "testmatch") {
        await handleTestMatchCommand(interaction);
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "verify_now") {
        const { nonce, question } = createCaptcha(interaction.user.id);
        await interaction.showModal(buildVerifyCaptchaModal(`verify_captcha:${nonce}`, question));
        return;
      }

      if (interaction.customId === "verify_check") {
        const status = await getVerificationStatus(interaction.user.id);
        if (!status?.verified) {
          await replyEmbed(interaction, baseEmbed("ðŸ›¡ Verification", "Verification not complete yet."));
          return;
        }
        await updateVerificationRoles(interaction.user.id, status);
        if (!status.username) {
          await replyEmbed(interaction, baseEmbed("ðŸ›¡ Verification", "Steam linked. Set username via `/username <name>`."));
          return;
        }
        await replyEmbed(interaction, baseEmbed("ðŸ›¡ Verification Complete", `Welcome **${status.display_name ?? status.username}**.`));
        return;
      }

      if (interaction.customId.startsWith("queue_join_")) {
        const mode = interaction.customId.replace("queue_join_", "") as QueueMode;
        const steamId = await resolveSteamIdForDiscord(interaction.user.id);
        if (!steamId) {
          await replyEmbed(interaction, baseEmbed("🎮 Queue", "Complete verification first."));
          return;
        }

        const result = await userApi("/internal/queue/join", interaction.user.id, {
          method: "POST",
          body: JSON.stringify({ steam_id: steamId, mode, region: defaultRegion })
        });

        const status = await api(`/queue/status?mode=${mode}`).catch(() => ({ size: Number(result.size ?? 0), needed: 0 }));
        const currentSize = Number(status.size ?? result.size ?? 0);
        const entryElo = Number(result?.entry?.elo ?? 1000);
        const queueEmbed = await buildQueueJoinedEmbed(mode, entryElo, currentSize);
        await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
        stopQueueSearchSession(interaction.user.id);
        await interaction.reply({ embeds: [queueEmbed], ephemeral: true });

        const session = {
          mode,
          steamId,
          frame: 0,
          intervalHandle: setInterval(async () => {
            const active = queueSearchSessions.get(interaction.user.id);
            if (!active) return;
            const stillQueued = await isUserStillQueued(active.mode, active.steamId).catch(() => false);
            if (!stillQueued) {
              stopQueueSearchSession(interaction.user.id);
              return;
            }
            active.frame = (active.frame + 1) % SEARCH_FRAMES.length;
            const currentStatus = await api(`/queue/status?mode=${active.mode}`).catch(() => ({ size: 0 }));
            const size = Number(currentStatus.size ?? 0);
            const animatedEmbed = buildQueueSearchingEmbed(active.mode, entryElo, size, SEARCH_FRAMES[active.frame]);
            await interaction.editReply({ embeds: [animatedEmbed] }).catch(() => {
              stopQueueSearchSession(interaction.user.id);
            });
          }, 5_000)
        };

        queueSearchSessions.set(interaction.user.id, session);
        return;
      }

      if (interaction.customId.startsWith("ready_match:")) {
        const matchId = interaction.customId.split(":")[1] ?? "";
        const lobby = matchLobbyState.get(matchId);
        if (!lobby) {
          await replyEmbed(interaction, baseEmbed("🔥 Match Found", "Lobby no longer active."));
          return;
        }
        const steamId = await resolveSteamIdForDiscord(interaction.user.id);
        if (!steamId) {
          await replyEmbed(interaction, baseEmbed("🔥 Match Found", "Complete verification first."));
          return;
        }
        const profile = await botApi(`/internal/player/stats/${encodeURIComponent(steamId)}`).catch(() => null);
        const playerId = String(profile?.player?.id ?? "");
        const isParticipant = [...lobby.teamAIds, ...lobby.teamBIds].includes(playerId);
        if (!isParticipant) {
          await replyEmbed(interaction, baseEmbed("🔥 Match Found", "You are not part of this lobby."));
          return;
        }
        if (lobby.readyPlayerIds.has(playerId)) {
          await replyEmbed(
            interaction,
            baseEmbed("✅ Ready Confirmed", `You are already ready. Players Ready: ${lobby.readyPlayerIds.size} / ${lobby.requiredPlayers}`)
          );
          return;
        }
        lobby.readyPlayerIds.add(playerId);
        const updatedEmbed = buildMatchLobbyEmbed(lobby);
        const channel = await getTextChannel(lobby.channelId);
        if (channel) {
          const message = await channel.messages.fetch(lobby.messageId).catch(() => null);
          if (message) await message.edit({ embeds: [updatedEmbed], components: lobbyButtons(matchId) }).catch(() => undefined);
        }
        if (lobby.readyPlayerIds.size >= lobby.requiredPlayers) {
          clearTimeout(lobby.timeoutHandle);
          matchLobbyState.delete(matchId);
          const readyEmbed = baseEmbed("✅ All Players Ready", "Lobby locked. Server startup in progress.")
            .addFields({ name: "Players Ready", value: `${lobby.requiredPlayers} / ${lobby.requiredPlayers}`, inline: true });
          if (channel) {
            const message = await channel.messages.fetch(lobby.messageId).catch(() => null);
            if (message) await message.edit({ embeds: [readyEmbed], components: [] }).catch(() => undefined);
          }
        }
        await replyEmbed(
          interaction,
          baseEmbed("✅ Ready Confirmed", `Players Ready: ${lobby.readyPlayerIds.size} / ${lobby.requiredPlayers}`)
        );
        return;
      }

      if (interaction.customId.startsWith("leave_match:")) {
        const matchId = interaction.customId.split(":")[1] ?? "";
        const lobby = matchLobbyState.get(matchId);
        if (!lobby) {
          await replyEmbed(interaction, baseEmbed("🔥 Match Found", "Lobby no longer active."));
          return;
        }
        const steamId = await resolveSteamIdForDiscord(interaction.user.id);
        const profile = steamId ? await botApi(`/internal/player/stats/${encodeURIComponent(steamId)}`).catch(() => null) : null;
        const playerId = String(profile?.player?.id ?? "");
        const isParticipant = [...lobby.teamAIds, ...lobby.teamBIds].includes(playerId);
        if (!isParticipant) {
          await replyEmbed(interaction, baseEmbed("🔥 Match Found", "You are not part of this lobby."));
          return;
        }
        clearTimeout(lobby.timeoutHandle);
        matchLobbyState.delete(matchId);
        const cancelEmbed = baseEmbed("❌ Match Cancelled", "A player left the lobby before ready-check finished.")
          .addFields({ name: "Players Ready", value: `${lobby.readyPlayerIds.size} / ${lobby.requiredPlayers}`, inline: true });
        const channel = await getTextChannel(lobby.channelId);
        if (channel) {
          const message = await channel.messages.fetch(lobby.messageId).catch(() => null);
          if (message) await message.edit({ embeds: [cancelEmbed], components: [] }).catch(() => undefined);
        }
        await replyEmbed(interaction, baseEmbed("❌ Left Match", "You left the match lobby."));
        return;
      }

      if (interaction.customId === "queue_leave") {
        stopQueueSearchSession(interaction.user.id);
        const steamId = await resolveSteamIdForDiscord(interaction.user.id);
        if (!steamId) {
          await replyEmbed(interaction, baseEmbed("🎮 Queue", "Complete verification first."));
          return;
        }

        for (const mode of QUEUE_MODES) {
          await userApi("/internal/queue/leave", interaction.user.id, {
            method: "POST",
            body: JSON.stringify({ steam_id: steamId, mode })
          }).catch(() => undefined);
        }

        await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
        await replyEmbed(interaction, baseEmbed("✅ Queue Updated", "You left all queues."));
        return;
      }

      if (interaction.customId === "mapvote_refresh") {
        await upsertPanel("mapVote", { embed: await buildMapVotePanelEmbed(), components: mapVotePanelButtons() });
        await replyEmbed(interaction, baseEmbed("ðŸŽ® Map Pool", "Map pool refreshed."));
        return;
      }

      if (interaction.customId.startsWith("join_server:")) {
        const matchId = interaction.customId.split(":")[1] ?? "";
        const cached = matchConnectionCache.get(matchId);
        if (!cached?.serverIp || !cached?.port || !cached?.serverPassword) {
          await replyEmbed(interaction, baseEmbed("🔥 MATCH FOUND", "Server details are still initializing. Try again in a few seconds."));
          return;
        }
        const cmd = `connect ${cached.serverIp}:${cached.port}; password ${cached.serverPassword}`;
        await replyEmbed(interaction, baseEmbed("🚀 Match Server Ready", `Use this in CS console:\n\`\`\`\n${cmd}\n\`\`\``));
        return;
      }

      if (interaction.customId.startsWith("copy_connect:")) {
        const matchId = interaction.customId.split(":")[1] ?? "";
        const cached = matchConnectionCache.get(matchId);
        if (!cached?.serverIp || !cached?.port || !cached?.serverPassword) {
          await replyEmbed(interaction, baseEmbed("🚀 Match Server Ready", "Connect command not ready yet."));
          return;
        }
        const cmd = `connect ${cached.serverIp}:${cached.port}; password ${cached.serverPassword}`;
        await replyEmbed(interaction, baseEmbed("🚀 Copy Connect Command", `\`\`\`\n${cmd}\n\`\`\``));
        return;
      }

      if (interaction.customId.startsWith("spectate_match:")) {
        const matchId = interaction.customId.split(":")[1] ?? "";
        const cached = matchConnectionCache.get(matchId);
        if (!cached?.serverIp || !cached?.port || !cached?.spectatorPassword) {
          await replyEmbed(interaction, baseEmbed("ðŸ”¥ Spectate", "Spectator data not ready yet."));
          return;
        }
        const cmd = `connect ${cached.serverIp}:${cached.port}; password ${cached.spectatorPassword}`;
        await replyEmbed(interaction, baseEmbed("ðŸ”¥ Spectate Match", `Use this in CS console:\n\`\`\`\n${cmd}\n\`\`\``));
        return;
      }

      if (interaction.customId.startsWith("report_player:")) {
        await replyEmbed(interaction, baseEmbed("ðŸ›¡ Report", "Use the reports workflow in Overwatch channels."));
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("verify_captcha:")) {
      const nonce = interaction.customId.split(":")[1] ?? "";
      const state = captchaState.get(interaction.user.id);
      if (!state || state.nonce !== nonce || state.expiresAt < Date.now()) {
        await replyEmbed(interaction, baseEmbed("ðŸ›¡ Captcha", "Captcha expired. Click **Verify Now** again."));
        return;
      }

      const answer = interaction.fields.getTextInputValue("captcha_answer").trim();
      if (answer !== state.answer) {
        await replyEmbed(interaction, baseEmbed("ðŸ›¡ Captcha", "Captcha failed. Try again."));
        return;
      }

      captchaState.delete(interaction.user.id);
      const verifyUrl = await startVerificationFlow(interaction.user.id);
      await interaction.reply({
        embeds: [baseEmbed("ðŸ›¡ Captcha Successful", "Now link your Steam account, then click **Check Verification**.")],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Connect Steam").setURL(verifyUrl),
            new ButtonBuilder().setCustomId("verify_check").setLabel("Check Verification").setStyle(ButtonStyle.Secondary)
          )
        ],
        ephemeral: true
      });
    }
  } catch (error: any) {
    const normalized = normalizeApiError(error);
    const errorEmbed = baseEmbed("⚠ Action Failed", normalized.message || "Request failed. Please try again.");
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => undefined);
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => undefined);
      }
    }
  }
});

(async () => {
  await sub.subscribe("match-events", "overwatch-events", "queue-events", "moderation-events", "security-events");
  sub.on("message", async (channel, payload) => {
    try {
      const event = JSON.parse(payload);
      await handlePubsubEvent(channel, event);
    } catch (error) {
      console.error("pubsub handling failed", error);
    }
  });

  await client.login(token);
})();


