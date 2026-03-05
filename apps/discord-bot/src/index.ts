import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  IntentsBitField,
  StringSelectMenuBuilder,
  TextChannel,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import crypto from "node:crypto";
import Redis from "ioredis";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://api:3001";
const serverManagerBaseUrl = process.env.SERVER_MANAGER_BASE_URL ?? "http://server-manager:3003";
const liveMatchesChannelId = process.env.DISCORD_CHANNEL_LIVE_MATCHES ?? "";
const queueChannelId = process.env.DISCORD_CHANNEL_QUEUE ?? "";
const overwatchChannelId = process.env.DISCORD_CHANNEL_OVERWATCH ?? "";
const serverStatusChannelId = process.env.DISCORD_CHANNEL_SERVER_STATUS ?? "";
const mapVoteChannelId = process.env.DISCORD_CHANNEL_MAP_VOTE ?? "";
const guildId = process.env.DISCORD_GUILD_ID ?? "";
const modJwt = process.env.DISCORD_MOD_JWT ?? "";
const botApiToken = process.env.DISCORD_BOT_API_TOKEN ?? "";
const enableTestMode = (process.env.DISCORD_ENABLE_TEST_MODE ?? "false").toLowerCase() === "true";
const moderatorRoleId = process.env.DISCORD_MODERATOR_ROLE_ID ?? "";
const playerLinksRaw = process.env.DISCORD_PLAYER_LINKS_JSON ?? "{}";
const playerDiscordMap: Record<string, string> = (() => {
  try {
    const parsed = JSON.parse(playerLinksRaw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();
const COMMUNITY_MAPS = ["de_mirage", "de_inferno", "de_dust2", "de_overpass", "de_ancient", "de_nuke", "de_vertigo"];
const REPORT_REASONS = ["cheating", "griefing", "toxic", "afk"] as const;

const SKINS_CATALOG: Record<string, Array<{ id: string; name: string }>> = {
  ak47: [
    { id: "redline", name: "Redline" },
    { id: "asiimov", name: "Asiimov" },
    { id: "vulcan", name: "Vulcan" },
    { id: "fire_serpent", name: "Fire Serpent" }
  ],
  "m4a1-s": [
    { id: "printstream", name: "Printstream" },
    { id: "nightmare", name: "Nightmare" },
    { id: "golden_coil", name: "Golden Coil" },
    { id: "mecha_industries", name: "Mecha Industries" }
  ],
  awp: [
    { id: "dragon_lore", name: "Dragon Lore" },
    { id: "asiimov", name: "Asiimov" },
    { id: "medusa", name: "Medusa" },
    { id: "wildfire", name: "Wildfire" }
  ],
  knife: [
    { id: "karambit_fade", name: "Karambit | Fade" },
    { id: "m9_doppler", name: "M9 Bayonet | Doppler" },
    { id: "butterfly_slaughter", name: "Butterfly | Slaughter" }
  ],
  gloves: [
    { id: "sport_pandora", name: "Sport Gloves | Pandora's Box" },
    { id: "specialist_fade", name: "Specialist Gloves | Fade" },
    { id: "driver_king_snake", name: "Driver Gloves | King Snake" }
  ]
};

const client = new Client({
  intents: [IntentsBitField.Flags.Guilds, IntentsBitField.Flags.GuildMessages, IntentsBitField.Flags.MessageContent]
});

const sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const liveMessageIndex = new Map<string, string>();
const matchChannels = new Map<
  string,
  {
    channelId: string;
    playerIds: string[];
  }
>();
let dailyMapVoteState:
  | {
      date: string;
      channelId: string;
      votes: Record<string, number>;
      votedUsers: Set<string>;
      endTimer: NodeJS.Timeout;
    }
  | null = null;
const matchVotes = new Map<
  string,
  {
    matchId: string;
    channelId: string;
    voteMessageId: string;
    teamA: any[];
    teamB: any[];
    maps: string[];
    votes: Record<string, number>;
    votedUsers: Set<string>;
    simulateEnd: boolean;
    timer: NodeJS.Timeout;
  }
>();

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

async function getChannel(channelId: string): Promise<TextChannel | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return null;
  return channel as TextChannel;
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
  const embed = new EmbedBuilder()
    .setTitle("LIVE MATCH")
    .addFields(
      { name: "Match", value: matchId, inline: true },
      { name: "Map", value: String(match.map ?? event.map ?? "unknown"), inline: true },
      { name: "Players", value: players || "unknown" },
      { name: "Spectate", value: `\`${spectateCommand}\`` }
    );
  const row = linkRow("Open Match", `${process.env.BASE_URL ?? "https://play.maro.run"}/match/${matchId}`);
  const msg = await channel.send({ embeds: [embed], components: [row] });

  liveMessageIndex.set(matchId, msg.id);
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
    return;
  }

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

  const temp = matchChannels.get(matchId);
  if (temp) {
    const matchChannel = await getChannel(temp.channelId);
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
        try {
          await matchChannel.delete("Match completed: cleanup temporary channel");
        } catch (error) {
          console.error("failed to delete temporary match channel", error);
        }
      }, 30 * 1000);
    }
    matchChannels.delete(matchId);
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
    `Reasons: ${(event.reasons ?? []).join(", ") || "n/a"}`
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

async function postServerStatus(text: string): Promise<void> {
  const channel = await getChannel(serverStatusChannelId);
  if (!channel) return;
  await channel.send({ embeds: [new EmbedBuilder().setTitle("Server Status").setDescription(text)] });
}

async function postQueueStatus(text: string): Promise<void> {
  const channel = await getChannel(queueChannelId);
  if (!channel) return;
  await channel.send({
    embeds: [new EmbedBuilder().setTitle("Queue Update").setDescription(text)],
    components: [linkRow("Open Queue", `${process.env.BASE_URL ?? "https://play.maro.run"}/queue`)]
  });
}

function linkRow(label: string, url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url)
  );
}

function utcDateString(d = new Date()): string {
  return d.toISOString().slice(0, 10);
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

  const ranked = Object.entries(state.votes).sort(voteSortWithRandomTie);
  const selected = ranked.slice(0, 5).map(([map]) => map);

  await api("/internal/maps/daily", {
    method: "POST",
    headers: { "x-bot-token": botApiToken },
    body: JSON.stringify({ date: state.date, maps: selected })
  });

  const channel = await getChannel(state.channelId);
  if (channel) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Daily Map Pool Finalized")
          .setDescription(`Daily voting closed for ${state.date}.`)
          .addFields(
            { name: "Top 5 Maps", value: selected.join(", ") || "n/a" },
            { name: "Votes", value: ranked.map(([m, c]) => `${m}=${c}`).join(", ") || "n/a" }
          )
      ],
      components: [linkRow("Open Live Matches", `${process.env.BASE_URL ?? "https://play.maro.run"}/live`)]
    });
  }
}

async function startDailyMapVote() {
  const channel = await getChannel(mapVoteChannelId);
  if (!channel) return;

  const date = utcDateString();
  const embed = new EmbedBuilder()
    .setTitle("DAILY MAP POOL VOTE")
    .setDescription("Vote for today's map pool. Voting lasts 12 hours.")
    .addFields({ name: "Date (UTC)", value: date, inline: true });

  const row1 = new ActionRowBuilder<ButtonBuilder>();
  const row2 = new ActionRowBuilder<ButtonBuilder>();
  COMMUNITY_MAPS.forEach((map, idx) => {
    const btn = new ButtonBuilder()
      .setCustomId(`dailymap:${date}:${map}`)
      .setLabel(map.replace("de_", "").toUpperCase())
      .setStyle(ButtonStyle.Secondary);
    if (idx < 5) row1.addComponents(btn);
    else row2.addComponents(btn);
  });

  await channel.send({ embeds: [embed], components: [row1, row2] });

  const votes: Record<string, number> = {};
  COMMUNITY_MAPS.forEach((m) => (votes[m] = 0));
  const endTimer = setTimeout(async () => {
    await finalizeDailyMapVote();
  }, 12 * 60 * 60 * 1000);

  dailyMapVoteState = {
    date,
    channelId: channel.id,
    votes,
    votedUsers: new Set<string>(),
    endTimer
  };
}

function scheduleDailyMapVoteLoop() {
  const delay = msUntilNextUtcMidnight();
  setTimeout(async () => {
    try {
      await startDailyMapVote();
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

function balanceTeamsByElo(players: Array<{ player_id: string; elo: number; region: string; timestamp: string }>) {
  const ordered = [...players].sort((a, b) => b.elo - a.elo);
  const teamA: typeof players = [];
  const teamB: typeof players = [];
  let eloA = 0;
  let eloB = 0;

  for (const p of ordered) {
    const canA = teamA.length < 5;
    const canB = teamB.length < 5;
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
        .setLabel(mapLabel(map))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled)
    );
  });
  rows.push(currentRow);
  return rows;
}

function buildMapVoteEmbed(matchId: string, maps: string[], votes: Record<string, number>, winnerMap?: string): EmbedBuilder {
  const lines = maps.map((m) => {
    const prefix = winnerMap === m ? "🏆" : mapEmoji(m);
    return `${prefix} ${mapLabel(m)} - **${votes[m] ?? 0}**`;
  });

  return new EmbedBuilder()
    .setTitle("🗺️ Map Vote")
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Match ID", value: matchId, inline: true },
      { name: "Status", value: winnerMap ? `Winner: ${mapEmoji(winnerMap)} ${mapLabel(winnerMap)}` : "Voting live", inline: true }
    );
}

async function createMatchVoteChannel(event: any): Promise<void> {
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId);
  const matchId = String(event.matchId ?? "unknown");
  const maps: string[] = Array.isArray(event.daily_map_pool) && event.daily_map_pool.length > 0 ? event.daily_map_pool : ["de_mirage"];
  const playerIds: string[] = Array.isArray(event.players) ? event.players : [];
  const allowedDiscordUsers = playerIds.map((id) => playerDiscordMap[id]).filter(Boolean);

  await api("/internal/matches/reserve", {
    method: "POST",
    body: JSON.stringify({
      match_id: matchId,
      teamA: event.team_a ?? [],
      teamB: event.team_b ?? []
    })
  });

  const channel = await guild.channels.create({
    name: `match-${matchId.slice(0, 8)}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: ["ViewChannel"]
      },
      ...(moderatorRoleId
        ? [
            {
              id: moderatorRoleId,
              allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"]
            }
          ]
        : []),
      ...allowedDiscordUsers.map((discordUserId) => ({
        id: discordUserId,
        allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"]
      }))
    ],
    reason: `Temporary vote channel for match ${matchId}`
  });

  const embed = buildMapVoteEmbed(matchId, maps, Object.fromEntries(maps.map((m) => [m, 0])));
  const rows = buildMapVoteRows(matchId, maps, false);

  const voteMessage = await (channel as TextChannel).send({ embeds: [embed], components: rows });

  const votes: Record<string, number> = {};
  maps.forEach((m) => {
    votes[m] = 0;
  });

  const timer = setTimeout(async () => {
    const voteState = matchVotes.get(matchId);
    if (!voteState) return;
    matchVotes.delete(matchId);

    const highest = Math.max(...Object.values(voteState.votes));
    const tied = Object.keys(voteState.votes).filter((m) => voteState.votes[m] === highest);
    const selectedMap = tied[Math.floor(Math.random() * tied.length)];

    try {
      const voteMsg = await (channel as TextChannel).messages.fetch(voteState.voteMessageId);
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
    await (channel as TextChannel).send(
      [
        `Map selected: **${selectedMap}**`,
        `Votes: ${Object.entries(voteState.votes)
          .map(([m, c]) => `${m}=${c}`)
          .join(", ")}`,
        "",
        connectCommand,
        "",
        "Match updates will be posted in this channel."
      ].join("\n")
    );

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
              demoUrl: `https://play.maro.run/demos/${matchId}.dem`,
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
    channelId: channel.id,
    voteMessageId: voteMessage.id,
    teamA: event.team_a ?? [],
    teamB: event.team_b ?? [],
    maps,
    votes,
    votedUsers: new Set<string>(),
    simulateEnd: Boolean(event.test_mode),
    timer
  });
  matchChannels.set(matchId, {
    channelId: channel.id,
    playerIds
  });
}

async function setPlayerSkin(steamId: string, weapon: string, skinId: string): Promise<void> {
  await api("/player/skins", {
    method: "POST",
    headers: {
      "x-bot-token": botApiToken
    },
    body: JSON.stringify({
      steam_id: steamId,
      weapon,
      skin_id: skinId
    })
  });
}

function makeWeaponMenu(steamId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`skins:weapon:${steamId}`)
    .setPlaceholder("Select weapon category")
    .addOptions([
      { label: "AK47", value: "ak47" },
      { label: "M4A1-S", value: "m4a1-s" },
      { label: "AWP", value: "awp" },
      { label: "Knife", value: "knife" },
      { label: "Gloves", value: "gloves" }
    ]);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function makeSkinMenu(steamId: string, weapon: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const skins = SKINS_CATALOG[weapon] ?? [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`skins:skin:${steamId}:${weapon}`)
    .setPlaceholder(`Select ${weapon} skin`)
    .addOptions(
      skins.map((s) => ({
        label: s.name,
        value: s.id
      }))
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function handleSlashSkins(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = interaction.options.getString("steamid", true);
  await interaction.reply({
    content: `Skin selection for **${steamId}**`,
    components: [makeWeaponMenu(steamId)],
    ephemeral: true
  });
}

async function handleSlashQueue(interaction: ChatInputCommandInteraction): Promise<void> {
  const steamId = interaction.options.getString("steamid", true);
  const action = interaction.options.getString("action") ?? "join";
  const region = interaction.options.getString("region") ?? "eu";

  if (action === "leave") {
    const result = await api("/internal/queue/leave", {
      method: "POST",
      headers: { "x-bot-token": botApiToken },
      body: JSON.stringify({ steam_id: steamId })
    });
    await interaction.reply({ content: `Removed **${steamId}** from queue. Queue size: ${result.size}`, ephemeral: true });
    return;
  }

  const result = await api("/internal/queue/join", {
    method: "POST",
    headers: { "x-bot-token": botApiToken },
    body: JSON.stringify({ steam_id: steamId, region })
  });
  await interaction.reply({
    content: `Queued **${steamId}** (${region}). Queue size: ${result.size}${result.duplicate ? " (already queued)" : ""}`,
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

  await createMatchVoteChannel({
    matchId,
    players: players.map((p) => p.player_id),
    team_a: teamA,
    team_b: teamB,
    daily_map_pool: mapsData.maps,
    test_mode: true
  });

  await interaction.editReply(`Test match started: ${matchId}. Simulated flow is now running.`);
}

async function handleSlashMatchEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const matchId = interaction.options.getString("matchid", true);
  const scoreA = interaction.options.getInteger("score_a") ?? 13;
  const scoreB = interaction.options.getInteger("score_b") ?? 8;
  const demoUrl = interaction.options.getString("demo_url") ?? `https://play.maro.run/demos/${matchId}.dem`;

  const match = await api(`/matches/${matchId}`);
  const players: Array<{ id: string; team: "A" | "B" }> = (match.players ?? []).map((p: any) => ({ id: p.id, team: p.team }));
  const winner = scoreA >= scoreB ? "A" : "B";
  const results = players.map((p) => ({
    player_id: p.id,
    result: p.team === winner ? "win" : "loss",
    adr: p.team === winner ? 95 : 72,
    mvps: p.team === winner ? 2 : 0,
    kd: p.team === winner ? 1.3 : 0.8
  }));

  await api(`/internal/matches/${matchId}/end`, {
    method: "POST",
    body: JSON.stringify({
      demoUrl,
      teamAScore: scoreA,
      teamBScore: scoreB,
      results
    })
  });

  await interaction.reply({ content: `Marked match ${matchId} as finished (${scoreA}-${scoreB}).`, ephemeral: true });
}

async function handleSkinMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const [scope, type, steamId, weapon] = interaction.customId.split(":");
  if (scope !== "skins") return;

  if (type === "weapon") {
    const selectedWeapon = interaction.values[0];
    await interaction.update({
      content: `Skin selection for **${steamId}**\nWeapon: **${selectedWeapon.toUpperCase()}**`,
      components: [makeSkinMenu(steamId, selectedWeapon)]
    });
    return;
  }

  if (type === "skin") {
    const selectedSkin = interaction.values[0];
    if (!weapon) {
      await interaction.reply({ content: "Invalid weapon selection state.", ephemeral: true });
      return;
    }

    await setPlayerSkin(steamId, weapon, selectedSkin);
    await interaction.update({
      content: `Saved skin for **${steamId}**\nWeapon: **${weapon.toUpperCase()}**\nSkin: **${selectedSkin}**`,
      components: []
    });
  }
}

async function handleCommand(message: Message): Promise<void> {
  if (!message.content.startsWith("!")) return;

  const [command, ...args] = message.content.trim().split(/\s+/);

  try {
    if (command === "!servers") {
      const servers = await serverApi("/servers");
      if (!Array.isArray(servers) || servers.length === 0) {
        await message.reply("No active servers.");
        return;
      }

      const active = servers.filter((s: any) => s.state === "running");
      if (active.length === 0) {
        await message.reply("No active servers.");
        return;
      }

      await message.reply(
        active
          .map(
            (s: any) =>
              `${s.server_id.slice(0, 12)} | ${s.map ?? "unknown"} | ${s.server_ip}:${s.port}`
          )
          .join("\n")
      );
      return;
    }

    if (command === "!match" && args[0]) {
      const match = await api(`/matches/${args[0]}`);
      await message.reply([
        `Match ${match.id}`,
        `Status: ${match.status}`,
        `Map: ${match.map}`,
        `Players: ${(match.players ?? []).map((p: any) => p.display_name ?? p.id).join(", ") || "n/a"}`,
        `Connect: ${match.connect_string ?? "n/a"}`,
        `Demo: ${match.demo_url ?? "n/a"}`
      ].join("\n"));
      return;
    }

    if (command === "!case" && args[0]) {
      const cases = await api("/overwatch/cases", {
        headers: { authorization: `Bearer ${modJwt}` }
      });
      const found = cases.find((c: any) => c.id === args[0] || c.case_id === args[0]);
      if (!found) {
        await message.reply("Case not found");
        return;
      }
      await message.reply([
        `Case: ${found.id ?? found.case_id}`,
        `Status: ${found.status}`,
        `Player: ${found.reported_player_id ?? found.player_id}`,
        `Match: ${found.match_id}`,
        `Demo: ${found.demo_url ?? "pending"}`
      ].join("\n"));
      return;
    }

    if (command === "!timeout" && args[0]) {
      await api("/moderation/timeout", {
        method: "POST",
        headers: { authorization: `Bearer ${modJwt}` },
        body: JSON.stringify({ playerId: args[0], minutes: Number(args[1] ?? 30) })
      });
      await message.reply(`Timeout applied to ${args[0]}`);
      return;
    }

    if (command === "!ban" && args[0]) {
      await api("/moderation/ban", {
        method: "POST",
        headers: { authorization: `Bearer ${modJwt}` },
        body: JSON.stringify({ playerId: args[0], reason: args.slice(1).join(" ") || "Discord moderation action" })
      });
      await message.reply(`Ban applied to ${args[0]}`);
      return;
    }
  } catch (error: any) {
    await message.reply(`Command failed: ${error.message}`);
  }
}

client.on("ready", async () => {
  console.log(`Discord bot connected as ${client.user?.tag}`);

  if (client.application && guildId) {
    const skinsCommand = new SlashCommandBuilder()
      .setName("skins")
      .setDescription("Select cosmetic skins for your Steam account")
      .addStringOption((opt) =>
        opt
          .setName("steamid")
          .setDescription("Steam ID (used by game server skin fetch)")
          .setRequired(true)
      );

    const queueCommand = new SlashCommandBuilder()
      .setName("queue")
      .setDescription("Join or leave the Discord matchmaking queue")
      .addStringOption((opt) =>
        opt.setName("steamid").setDescription("Steam ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("action")
          .setDescription("Queue action")
          .setRequired(false)
          .addChoices(
            { name: "join", value: "join" },
            { name: "leave", value: "leave" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("region").setDescription("Region").setRequired(false)
      );

    const matchEndCommand = new SlashCommandBuilder()
      .setName("matchend")
      .setDescription("Mark a match as ended and trigger ranking update")
      .addStringOption((opt) => opt.setName("matchid").setDescription("Match ID").setRequired(true))
      .addIntegerOption((opt) => opt.setName("score_a").setDescription("Team A score").setRequired(false))
      .addIntegerOption((opt) => opt.setName("score_b").setDescription("Team B score").setRequired(false))
      .addStringOption((opt) => opt.setName("demo_url").setDescription("Demo URL").setRequired(false));

    const testMatchCommand = new SlashCommandBuilder()
      .setName("testmatch")
      .setDescription("Run a full mock match flow (queue -> vote -> server -> end)");

    await client.application.commands.create(skinsCommand.toJSON(), guildId);
    await client.application.commands.create(queueCommand.toJSON(), guildId);
    await client.application.commands.create(matchEndCommand.toJSON(), guildId);
    if (enableTestMode) {
      await client.application.commands.create(testMatchCommand.toJSON(), guildId);
    }
  }

  await postServerStatus("Discord bot online.");
  scheduleDailyMapVoteLoop();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "skins") {
      await handleSlashSkins(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "queue") {
      await handleSlashQueue(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "matchend") {
      await handleSlashMatchEnd(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "testmatch") {
      if (!enableTestMode) {
        await interaction.reply({ content: "Test mode is disabled.", ephemeral: true });
        return;
      }
      await handleSlashTestMatch(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("skins:")) {
      await handleSkinMenu(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("mapvote:")) {
      const [, matchId, map] = interaction.customId.split(":");
      const voteState = matchVotes.get(matchId);
      if (!voteState) {
        await interaction.reply({ content: "Voting has ended for this match.", ephemeral: true });
        return;
      }

      if (voteState.channelId !== interaction.channelId) {
        await interaction.reply({ content: "Invalid voting channel.", ephemeral: true });
        return;
      }

      if (voteState.votedUsers.has(interaction.user.id)) {
        await interaction.reply({ content: "You have already voted.", ephemeral: true });
        return;
      }

      if (!voteState.maps.includes(map)) {
        await interaction.reply({ content: "Invalid map choice.", ephemeral: true });
        return;
      }

      voteState.votedUsers.add(interaction.user.id);
      voteState.votes[map] = (voteState.votes[map] ?? 0) + 1;
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
      await interaction.reply({ content: `Vote recorded for **${map}**`, ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("dailymap:")) {
      const [, date, map] = interaction.customId.split(":");
      const state = dailyMapVoteState;
      if (!state || state.date !== date) {
        await interaction.reply({ content: "Daily map voting is closed.", ephemeral: true });
        return;
      }
      if (interaction.channelId !== state.channelId) {
        await interaction.reply({ content: "Vote in the #map-vote channel.", ephemeral: true });
        return;
      }
      if (state.votedUsers.has(interaction.user.id)) {
        await interaction.reply({ content: "You already voted for today's pool.", ephemeral: true });
        return;
      }
      if (!(map in state.votes)) {
        await interaction.reply({ content: "Invalid map choice.", ephemeral: true });
        return;
      }

      state.votedUsers.add(interaction.user.id);
      state.votes[map] += 1;
      await interaction.reply({ content: `Daily vote recorded for **${map}**`, ephemeral: true });
      return;
    }
  } catch (error: any) {
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Interaction failed: ${error.message}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `Interaction failed: ${error.message}`, ephemeral: true });
      }
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  await handleCommand(message);
});

(async () => {
  await sub.subscribe("match-events", "overwatch-events");
  sub.on("message", async (channel, payload) => {
    const event = JSON.parse(payload);

    try {
      if (channel === "match-events" && event.type === "match_started") {
        await postMatchStarted(event);
      }
      if (channel === "match-events" && event.type === "match_found") {
        await createMatchVoteChannel(event);
      }
      if (channel === "match-events" && event.type === "match_finished") {
        await postMatchFinished(event);
      }
      if (channel === "overwatch-events" && event.type === "case_created") {
        await postCaseCreated(event);
      }
      if (channel === "overwatch-events" && event.type === "cheat_alert") {
        await postCheatAlert(event);
      }
    } catch (error) {
      console.error("event handling failed", error);
    }
  });

  await client.login(token);
})();
