
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
const guildId = process.env.DISCORD_GUILD_ID ?? "";
const botApiToken = process.env.DISCORD_BOT_API_TOKEN ?? "";
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? process.env.DISCORD_BOT_API_TOKEN ?? "";
const defaultRegion = process.env.DISCORD_DEFAULT_REGION ?? "eu";
const enableTestMode = (process.env.DISCORD_ENABLE_TEST_MODE ?? "false").toLowerCase() === "true";
const moderatorRoleId = process.env.DISCORD_MODERATOR_ROLE_ID ?? "";
const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID ?? "";

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

type PresenceStats = {
  liveMatches: number;
  serversOnline: number;
  playersQueue: number;
};

let presenceIndex = 0;
let presenceCache: { stats: PresenceStats; fetchedAt: number } | null = null;

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
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

function isModerator(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return [moderatorRoleId, adminRoleId].filter(Boolean).some((id) => member.roles.cache.has(id));
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
  return new EmbedBuilder()
    .setTitle("FragHub Verification")
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
  const modes = ["ranked", "wingman", "casual", "clanwars"] as const;
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  for (const mode of modes) {
    try {
      const status = await api(`/queue/status?mode=${mode}`);
      fields.push({ name: mode.toUpperCase(), value: `In queue: ${status.size ?? 0}\nNeeded: ${status.needed ?? 0}`, inline: true });
    } catch {
      fields.push({ name: mode.toUpperCase(), value: "Unavailable", inline: true });
    }
  }
  return new EmbedBuilder().setTitle("FragHub Queue").setDescription("Use buttons below to join/leave queue.").addFields(fields);
}

async function buildMapVotePanelEmbed(): Promise<EmbedBuilder> {
  try {
    const daily = await api("/maps/daily");
    const maps = Array.isArray(daily?.maps) ? daily.maps : [];
    return new EmbedBuilder().setTitle("Daily Map Pool").setDescription(maps.length ? maps.map((m: string) => `- ${m}`).join("\n") : "No active map pool.");
  } catch {
    return new EmbedBuilder().setTitle("Daily Map Pool").setDescription("Map pool unavailable.");
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
  return new EmbedBuilder()
    .setTitle("FragHub Server Status")
    .setDescription("Live platform health and activity")
    .addFields(
      { name: "Live Matches", value: String(stats.liveMatches), inline: true },
      { name: "Servers Online", value: String(stats.serversOnline), inline: true },
      { name: "Players in Queue", value: String(stats.playersQueue), inline: true }
    )
    .setTimestamp(new Date());
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
      new ButtonBuilder().setCustomId("queue_join_ranked").setLabel("Join Ranked").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("queue_join_wingman").setLabel("Join Wingman").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("queue_join_casual").setLabel("Join Casual").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("queue_join_clanwars").setLabel("Join Clan Wars").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("queue_leave").setLabel("Leave Queue").setStyle(ButtonStyle.Danger)
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
    await interaction.reply({ content: "Click Verify Now in #verify and complete captcha + Steam link.", ephemeral: true });
    return;
  }

  if (!status.username) {
    await interaction.reply({ content: "Steam linked. Set your username with /username <name>.", ephemeral: true });
    return;
  }

  await updateVerificationRoles(interaction.user.id, status);
  await interaction.reply({ content: `Verified as ${status.display_name ?? status.username}.`, ephemeral: true });
}

async function handleUsernameCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.options.getString("name", true);
  const result = await userApi("/internal/player/username", interaction.user.id, {
    method: "POST",
    body: JSON.stringify({ username })
  });
  const status = await getVerificationStatus(interaction.user.id);
  await updateVerificationRoles(interaction.user.id, status);
  await interaction.reply({ content: `Username set: ${result.username}`, ephemeral: true });
}

async function handleUsernameChange(interaction: ChatInputCommandInteraction): Promise<void> {
  const username = interaction.options.getString("newname", true);
  const result = await userApi("/internal/player/username/change", interaction.user.id, {
    method: "POST",
    body: JSON.stringify({ username })
  });
  const status = await getVerificationStatus(interaction.user.id);
  await updateVerificationRoles(interaction.user.id, status);
  await interaction.reply({ content: `Username changed: ${result.username}`, ephemeral: true });
}

async function handleTagChange(interaction: ChatInputCommandInteraction): Promise<void> {
  const tagType = interaction.options.getString("type", true);
  const result = await userApi("/internal/player/tag", interaction.user.id, {
    method: "POST",
    body: JSON.stringify({ selected_tag_type: tagType })
  });
  const status = await getVerificationStatus(interaction.user.id);
  await updateVerificationRoles(interaction.user.id, status);
  await interaction.reply({ content: `Tag changed: ${result.display_name}`, ephemeral: true });
}

async function resolveSteamIdForDiscord(discordId: string): Promise<string | null> {
  const status = await getVerificationStatus(discordId);
  if (!status?.verified || !status?.steam_id) return null;
  return String(status.steam_id);
}

async function handleQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const action = interaction.options.getString("action") ?? "join";
  const mode = interaction.options.getString("mode") ?? "ranked";
  const region = interaction.options.getString("region") ?? defaultRegion;
  const steamId = await resolveSteamIdForDiscord(interaction.user.id);

  if (!steamId) {
    await interaction.reply({ content: "You must complete verification first.", ephemeral: true });
    return;
  }

  if (action === "leave") {
    const result = await userApi("/internal/queue/leave", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ steam_id: steamId, mode })
    });
    await interaction.reply({ content: `Left ${mode} queue. Size: ${result.size ?? 0}`, ephemeral: true });
  } else {
    const result = await userApi("/internal/queue/join", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ steam_id: steamId, mode, region })
    });
    await interaction.reply({ content: `Joined ${mode} queue. Size: ${result.size ?? 0}`, ephemeral: true });
  }

  await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
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
    await interaction.reply({ content: `Clan request sent: ${res.clan_tag} (${res.status})`, ephemeral: true });
    return;
  }

  if (subCommand === "join") {
    const clanTag = interaction.options.getString("tag", true);
    const res = await userApi("/internal/clan/join-request", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ clan_tag: clanTag })
    });
    await interaction.reply({ content: `Join request sent to [${res.clan_tag}] ${res.clan_name}.`, ephemeral: true });
    return;
  }

  if (subCommand === "approve") {
    const player = interaction.options.getString("player", true);
    const res = await userApi("/internal/clan/approve-member", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ player })
    });
    await interaction.reply({ content: `Approved ${res.player_steam_id} into ${res.clan_tag}.`, ephemeral: true });
    return;
  }

  if (subCommand === "invite") {
    const player = interaction.options.getString("player", true);
    const res = await userApi("/internal/clan/invite", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ player })
    });
    await interaction.reply({ content: `Invited ${res.player_steam_id} into ${res.clan_tag}.`, ephemeral: true });
    return;
  }

  if (subCommand === "kick") {
    const player = interaction.options.getString("player", true);
    const res = await userApi("/internal/clan/kick", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ player })
    });
    await interaction.reply({ content: `Kicked ${res.player_steam_id} from ${res.clan_tag}.`, ephemeral: true });
    return;
  }

  if (subCommand === "leave") {
    const res = await userApi("/internal/clan/leave", interaction.user.id, {
      method: "POST",
      body: JSON.stringify({})
    });
    await interaction.reply({ content: res.disbanded ? "Clan disbanded." : "You left the clan.", ephemeral: true });
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
      await interaction.reply({ content: "Verify first or provide /clan info <tag>", ephemeral: true });
      return;
    }

    const res = await botApi(query);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`[${res.clan.clan_tag}] ${res.clan.clan_name}`)
          .setDescription([
            `Rating: ${res.rating.rating}`,
            `Rank: ${res.rating.rank ?? "-"}`,
            `W/L: ${res.rating.wins}/${res.rating.losses}`,
            `Matches: ${res.rating.matches_played}`,
            `Members: ${(res.members ?? []).length}`
          ].join("\n"))
      ],
      ephemeral: true
    });
    return;
  }

  if (subCommand === "leaderboard") {
    const limit = interaction.options.getInteger("limit") ?? 10;
    const res = await botApi(`/internal/clan/leaderboard?limit=${limit}`);
    const lines = (res.leaderboard ?? []).map((r: any) => `#${r.rank} ${r.clan_tag} - ${r.rating}`);
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Clan Leaderboard").setDescription(lines.join("\n") || "No data")], ephemeral: true });
    return;
  }

  if (subCommand === "request-approve") {
    const requestId = interaction.options.getString("request_id", true);
    const res = await userApi(`/internal/clan/request/${requestId}/approve`, interaction.user.id, {
      method: "POST",
      body: JSON.stringify({})
    });
    await interaction.reply({ content: `Approved clan request: ${res.clan_tag}`, ephemeral: true });
    return;
  }

  if (subCommand === "request-reject") {
    const requestId = interaction.options.getString("request_id", true);
    const reason = interaction.options.getString("reason") ?? "Rejected";
    await userApi(`/internal/clan/request/${requestId}/reject`, interaction.user.id, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    await interaction.reply({ content: "Clan request rejected.", ephemeral: true });
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

  await interaction.reply({ content: `Saved ${weapon} skin: ${skin}`, ephemeral: true });
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

  await interaction.reply({ content: `Match ended: ${scoreA}-${scoreB}`, ephemeral: true });
}

async function handleTestMatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: "Use existing /testmatch flow from matchmaker integration.", ephemeral: true });
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
    commands.push(new SlashCommandBuilder().setName("testmatch").setDescription("Run test match flow"));
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
  if (event.type === "match_started") {
    await postToChannel(channelIds.liveMatches, new EmbedBuilder().setTitle("Match Started").setDescription(`Match ${matchId} is now live.`));
  }
  if (event.type === "match_finished") {
    const finalScore = String(event.finalScore ?? "0-0");
    await postToChannel(channelIds.matchResults || channelIds.liveMatches, new EmbedBuilder().setTitle("Match Finished").setDescription(`Match ${matchId} finished (${finalScore}).`));
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
        new EmbedBuilder().setTitle("Overwatch Case Created").setDescription(`Case ${event.case?.id ?? "?"} for player ${event.case?.reported_player_id ?? "?"}`)
      );
      return;
    }

    if (event.type === "anti_cheat_alert" || event.type === "cheat_alert" || event.type === "steam_link_flagged") {
      await postToChannel(channelIds.cheaterAlerts, new EmbedBuilder().setTitle("Cheater Alert").setDescription(`Event: ${event.type}`));
      return;
    }

    if (event.type === "ban_evasion_case_updated" && (event.action === "ban" || event.status === "banned")) {
      await postToChannel(channelIds.banLog, new EmbedBuilder().setTitle("Ban Event").setDescription(`Ban evasion case ${event.case_id} updated to ${event.status}`));
    }
    return;
  }

  if (channel === "moderation-events") {
    if (event.type === "clan_request_created") {
      await postToChannel(
        channelIds.modLog || channelIds.updates,
        new EmbedBuilder()
          .setTitle("Clan Request")
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
      await postToChannel(channelIds.updates, new EmbedBuilder().setTitle("Clan Request Resolved").setDescription(`Request ${event.request_id} ${event.decision}`));
    }
    return;
  }

  if (channel === "security-events") {
    await postToChannel(channelIds.cheaterAlerts, new EmbedBuilder().setTitle("Security Event").setDescription(`${event.type ?? "event"}`));
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
          await interaction.reply({ content: "Verification not complete yet.", ephemeral: true });
          return;
        }
        await updateVerificationRoles(interaction.user.id, status);
        if (!status.username) {
          await interaction.reply({ content: "Steam linked. Set username via /username <name>.", ephemeral: true });
          return;
        }
        await interaction.reply({ content: `Verification complete: ${status.display_name ?? status.username}`, ephemeral: true });
        return;
      }

      if (interaction.customId.startsWith("queue_join_")) {
        const mode = interaction.customId.replace("queue_join_", "");
        const steamId = await resolveSteamIdForDiscord(interaction.user.id);
        if (!steamId) {
          await interaction.reply({ content: "Complete verification first.", ephemeral: true });
          return;
        }

        const result = await userApi("/internal/queue/join", interaction.user.id, {
          method: "POST",
          body: JSON.stringify({ steam_id: steamId, mode, region: defaultRegion })
        });

        await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
        await interaction.reply({ content: `Joined ${mode} queue. Size: ${result.size ?? 0}`, ephemeral: true });
        return;
      }

      if (interaction.customId === "queue_leave") {
        const steamId = await resolveSteamIdForDiscord(interaction.user.id);
        if (!steamId) {
          await interaction.reply({ content: "Complete verification first.", ephemeral: true });
          return;
        }

        for (const mode of ["ranked", "wingman", "casual", "clanwars"]) {
          await userApi("/internal/queue/leave", interaction.user.id, {
            method: "POST",
            body: JSON.stringify({ steam_id: steamId, mode })
          }).catch(() => undefined);
        }

        await upsertPanel("queue", { embed: await buildQueuePanelEmbed(), components: queuePanelButtons() });
        await interaction.reply({ content: "Left queue.", ephemeral: true });
        return;
      }

      if (interaction.customId === "mapvote_refresh") {
        await upsertPanel("mapVote", { embed: await buildMapVotePanelEmbed(), components: mapVotePanelButtons() });
        await interaction.reply({ content: "Map pool refreshed.", ephemeral: true });
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("verify_captcha:")) {
      const nonce = interaction.customId.split(":")[1] ?? "";
      const state = captchaState.get(interaction.user.id);
      if (!state || state.nonce !== nonce || state.expiresAt < Date.now()) {
        await interaction.reply({ content: "Captcha expired. Click Verify Now again.", ephemeral: true });
        return;
      }

      const answer = interaction.fields.getTextInputValue("captcha_answer").trim();
      if (answer !== state.answer) {
        await interaction.reply({ content: "Captcha failed. Try again.", ephemeral: true });
        return;
      }

      captchaState.delete(interaction.user.id);
      const verifyUrl = await startVerificationFlow(interaction.user.id);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle("Captcha successful").setDescription("Now link your Steam account, then click Check Verification.")],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Connect Steam").setURL(verifyUrl),
            new ButtonBuilder().setCustomId("verify_check").setLabel("Check Verification").setStyle(ButtonStyle.Primary)
          )
        ],
        ephemeral: true
      });
    }
  } catch (error: any) {
    const errorMessage = `Action failed: ${error?.message ?? "unknown error"}`;
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => undefined);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => undefined);
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
