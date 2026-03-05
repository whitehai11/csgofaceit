# CS:GO Matchmaking Platform (Discord + Web)

CS:GO community matchmaking stack with Discord automation, web platform, server orchestration, moderation, and anti-cheat analysis.

## Services
- `apps/api` Fastify API (auth, queue, matches, reports, moderation, anti-cheat, rewards)
- `apps/web` Next.js 14 web platform (landing, dashboard, match, leaderboard, clans, admin)
- `apps/discord-bot` Discord bot (queue UX, streamer lobbies, map veto, moderation actions)
- `apps/matchmaker` Redis queue consumer and match creator
- `apps/server-manager` Docker-based CS server lifecycle manager
- `apps/watchdog` service watchdog and auto-recovery orchestrator
- `postgres` persistence
- `redis` queue/pubsub/cache

## Web Platform
- Routes:
  - `/`
  - `/dashboard`
  - `/match/[id]`
  - `/leaderboard`
  - `/clans`
  - `/clan/[tag]`
  - `/admin`
- Realtime events:
  - `stats:update`
  - `queue:update`
  - `match:update`
  - `match:timeline`
  - `match:mapvote`
  - `servers:update`
- Required env for web:
  - `NEXT_PUBLIC_API_BASE_URL`
  - `NEXT_PUBLIC_SOCKET_URL`
  - `CORS_ORIGINS`
  - `COOKIE_SECURE`, `COOKIE_SAMESITE`, `COOKIE_DOMAIN`

Run web locally:
1. `npm install`
2. `npm run dev -w @csgofaceit/web`

## Asset Pipeline
- Local asset cache root: `apps/web/public/assets`
  - `skins/`
  - `maps/`
  - `ranks/`
  - `weapons/`
  - `icons/`
- Runtime loader: `apps/web/lib/assets.ts`
  - `getSkinImage(weapon, skin)`
  - `getMapImage(map)`
  - `getRankIcon(rank)`
  - local-first with external fallback (Steam CDN / CSGOStash where available)
- Sync command:
  - `npm run assets:sync`
- Skin asset DB table migration:
  - `packages/db/migrations/045_skin_assets.sql`

## Discord Bot Permissions and Scopes
- OAuth2 scopes:
  - `bot`
  - `applications.commands`
- Bot permissions:
  - `View Channels`
  - `Send Messages`
  - `Embed Links`
  - `Read Message History`
  - `Manage Channels` (temporary match channels + clan categories/channels)
  - `Use Application Commands`
  - `Manage Roles` (required for clan role assignment)

## Environment Setup
Copy `.env.example` to `.env` and set secure values.

Required secrets/tokens:
- `JWT_SECRET` (>=32 chars)
- `INTERNAL_API_TOKEN`
- `INTERNAL_WEBHOOK_SECRET`
- `SERVER_MANAGER_API_TOKEN`
- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_BOT_API_TOKEN`

Required Discord channel IDs:
- `DISCORD_CHANNEL_QUEUE`
- `DISCORD_CHANNEL_LIVE_MATCHES`
- `DISCORD_CHANNEL_OVERWATCH`
- `DISCORD_CHANNEL_SERVER_STATUS`
- `DISCORD_CHANNEL_MAP_VOTE`
- `DISCORD_CHANNEL_ANNOUNCEMENTS`
- `DISCORD_CHANNEL_MATCH_RESULTS`
- `DISCORD_CHANNEL_VERIFY`
- `DISCORD_CHANNEL_BAN_LOG` (public transparency channel)
- `DISCORD_CHANNEL_MOD_LOG` (mods/admin only)

Required verification role IDs:
- `DISCORD_ROLE_UNVERIFIED_ID`
- `DISCORD_ROLE_VERIFIED_ID`
- `DISCORD_ROLE_STEAM_VERIFIED_ID` (recommended, falls back to `DISCORD_ROLE_VERIFIED_ID`)
- `DISCORD_ADMIN_ROLE_ID` (optional, for clan channel access)
- `DISCORD_DEVELOPER_ROLE_ID` (optional, for clan channel access)

Optional:
- `AUTH_CALLBACK_REDIRECT_URL` for Steam callback redirect target
- `CORS_ORIGINS` comma-separated allowlist for browser clients

## Run Locally (Docker)
1. Configure `.env`.
2. Run `docker compose up --build`.
3. Validate:
  - Proxy/API health: `http://localhost:8080/health`

## Production Deployment
1. Generate unique 32+ char secrets for:
  - `JWT_SECRET`
  - `INTERNAL_API_TOKEN`
  - `INTERNAL_WEBHOOK_SECRET`
  - `SERVER_MANAGER_API_TOKEN`
2. Restrict network exposure:
  - expose only reverse proxy (`proxy`) to the internet
  - keep `api`, `server-manager`, `postgres`, and `redis` internal only
  - set `INTERNAL_ALLOWED_IPS` and `SERVER_MANAGER_ALLOWED_IPS` to trusted CIDRs
3. Keep control-plane protected:
  - all `/internal/*` API routes require internal token/HMAC and replay-safe nonce checks
  - `server-manager` endpoints require `SERVER_MANAGER_API_TOKEN` and optional IP allowlist
4. Validate before go-live:
  - `docker compose up -d --build`
  - `npm run typecheck`
  - `npm run test:security`
  - `npm run audit:deps:ci`
5. Operations baseline:
  - enable automated Postgres backups and restore drills
  - rotate runtime secrets on a schedule and after any suspected leak
  - monitor mod-log/security alerts for rate-limit spikes and webhook signature failures

## Local Dev (Node)
1. `npm install`
2. `npm run dev`

This starts workspace dev processes (API, bot, matchmaker, server-manager).

## Slash Commands
- `/verify` (start CAPTCHA)
- `/linksteam` (verification flow)
- `/username <name>` (set required username)
- `/username-change <newname>` (1 change per 30 days)
- `/tag` (choose staff/clan/no tag based on permissions)
- `/clan create|join|approve|invite|kick|leave|leaderboard|info`
- `/queue`
- `/queue mode:clanwars` (Clan Wars 5v5 shortcut)
- `/leave`
- `/match`
- `/stats`
- `/skins`
- `/report`
- `/clip`
- `/modlogs`
- `/creator`
- `/streamer lobby`
- `/ban` (captain veto)
- `/testmatch` (when `DISCORD_ENABLE_TEST_MODE=true`)

## Discord Verification Flow
- New members are assigned `Unverified` role by the bot.
- Bot keeps a verification panel in `#verify` with a `Verify` button.
- User runs `/verify` (or presses `Verify`) and solves CAPTCHA.
- User runs `/linksteam`.
- Bot sends unique verification URL (`/steam/verify?token=...`) and user completes Steam OpenID login.
- On callback success:
  - API stores mapping in `steam_links(discord_id, steam_id, steam_profile_url, steam_account_age, cs_hours, linked_at)` and `verified_users`.
  - User must set a unique username with `/username <name>` before queue access.
  - Username is stored in `users(discord_id, steam_id, username, created_at)`.
  - Bot removes `Unverified` and adds `Steam Verified`.
- Steam checks on link:
  - VAC bans > 0 => moderation alert
  - Steam account age < 30 days => suspicious moderation alert
- Unverified users are blocked from command/button usage.

## Clan System
- Clan creation: `/clan create` submits a request for moderator approval.
- Moderator flow: request is posted to `#mod-log` with `Approve/Reject` buttons.
- Clan tags:
  - format `^[A-Z0-9]{3,5}$`
  - reserved tags blocked (configured via `CLAN_RESERVED_TAGS`)
  - unique globally
- Join flow:
  - `/clan join <tag>` creates owner-approval request
  - owner approves with `/clan approve <player>`
- Leave flow:
  - `/clan leave`
  - owner must transfer ownership first if clan has other members
- Owner tools:
  - `/clan invite <player>`
  - `/clan kick <player>`
- Name rendering priority:
  - users can select tag preference via `/tag`:
    - staff: `Developer`, `Admin`, `Moderator`, `Clan`, `No Tag` (only allowed options shown)
    - non-staff: `Clan`, `No Tag`
  - if a selected staff tag is no longer permitted, system auto-reverts to `Clan` or `No Tag`.
- Discord integration:
  - clan approval auto-creates:
    - role: `Clan <TAG>`
    - category: `[TAG] Clan`
    - channels: `#clan-chat`, `#clan-war-planning`, `clan-voice`
  - role is assigned/removed automatically on join/leave/invite/kick
  - disbanding a clan removes its role/category/channels
  - unauthorized manual clan-role assignments are auto-removed by bot integrity checks
  - clan max members configurable via `CLAN_MAX_MEMBERS` (default `50`)

## Clan Wars
- Mode: `clanwars` (5v5 competitive clan-vs-clan).
- Queue integrity:
  - Clan Wars requires clan membership.
  - Matchmaker only forms matches from two full 5-player clan teams.
  - Mixed-clan teams are rejected for Clan Wars matching.
- Clan rating:
  - starts at `CLAN_RATING_START` (default `1000`)
  - updates via ELO-style expected-score formula after each Clan War.
- Leaderboard:
  - `/clan leaderboard` shows top clans.
  - `/clan info` shows clan profile, members, rating, and rank.
- Season integration:
  - clan leaderboard is frozen at season end
  - stored in `clan_season_results`
  - clan rewards granted and stored in `clan_rewards`
- Discord result posting:
  - Clan War results are posted to `#match-results`.

## Security Checks
- `npm run typecheck`
- `npm run test:security`
- `npm run lint:security`
- `npm run audit:deps:ci`

See `SECURITY.md` for threat model, findings, and hardening notes.

## DDoS & Abuse Protection
- Reverse proxy baseline:
  - `proxy` service (nginx) sits in front of API.
  - API is internal-only in compose; public traffic should enter via proxy (`:8080`).
  - Proxy enforces request body limits, connection limits, and IP rate limiting.
- App-layer protections:
  - Global `@fastify/rate-limit` plus per-route policies:
    - `/queue/join`: strict
    - `/report`: strict
    - `/matches/:id`, `/cases`, `/overwatch/cases`, `/cases/vote`: moderated
  - Queue anti-spam:
    - cooldown after leave
    - burst spam detection + blocking
  - Report anti-spam:
    - duplicate report per match+target blocked
    - spam reporter auto-mute window
    - new-account reduced report weight
- Internal/webhook protection:
  - Internal endpoints require token or HMAC signature (`timestamp + nonce + signature`).
  - Replay protection via Redis nonce TTL.
- Observability:
  - Internal metrics endpoints:
    - `GET /internal/metrics` (API)
    - `GET /internal/metrics` (server-manager)
  - Security events published to Redis and forwarded by Discord bot to `#server-status`.

## Ban Evasion Detection
- Queue joins run ban-evasion checks against known banned accounts.
- Signals:
  - new Steam account age (<30d)
  - shared identifier hashes (`ip_hash`, optional `hardware_hash`, `discord_id`)
  - play-time similarity
  - Discord account creation pattern
- Outcomes:
  - score `>5`: flagged + moderator alert in `#overwatch`
  - score `>8`: queue access automatically blocked
- Moderator buttons on alerts:
  - `Allow`
  - `Monitor`
  - `Ban`

## Public Ban Log
- Every ban action creates a `ban_logs` record and emits a public Discord embed in `#ban-log`.
- Embed fields:
  - Player, Steam ID, Discord ID, Ban Reason, Match ID, Date
  - Evidence: video/demo URL, demo timestamp, case ID
- Embed buttons:
  - `Watch Demo`
  - `View Case`

## Moderator Log
- All moderation-relevant actions are written to `moderation_logs` and emitted to `#mod-log`:
  - reports, timeouts, bans, unbans
  - Overwatch case decisions
  - cheating alerts
  - ban evasion alerts
  - Steam verification failures
- Use `/modlogs <player>` (Steam ID optional) for recent history.

## Crash Detection & Restart
- All core services expose `GET /health` with `{ "status": "ok" }`.
- Docker services run with `restart: always`.
- `server-manager` monitors:
  - `api`
  - `discord-bot`
  - `matchmaker`
  - `server-manager`
  - managed CS servers
- If a target is unhealthy for >30s:
  - crash is stored in `server_crashes`
  - moderation event is emitted to `#mod-log` (`⚠️ Server Crash Detected`)
- If a managed CS match server crashes:
  - container is restarted
  - match state is re-activated from DB
  - reconnect/connect flow is re-emitted via match activation event

## Automatic Server Scaling
- `server-manager` checks queue demand every 10s (configurable).
- Scaling rules:
  - queue `>20` players: pre-warm `+2` servers
  - queue `>40` players: pre-warm `+4` servers
- Maintains a minimum pre-warmed idle pool (`SCALER_MIN_IDLE_SERVERS`, default `2`).
- Idle unmanaged/pool servers older than 10 minutes are shut down automatically (`IDLE_SERVER_TTL_MS`).
- Status metrics are published to `#server-status`:
  - Active Servers
  - Matches Running
  - Queue Players

## Watchdog Service
- `watchdog` checks every `WATCHDOG_CHECK_INTERVAL_MS` (default 10s):
  - HTTP `/health` for `api`, `discord-bot`, `matchmaker`, `server-manager`
  - PostgreSQL connectivity (`SELECT 1`)
  - Redis connectivity (`PING`)
  - Managed CS:GO containers (`csgofaceit.managed=true`) with UDP Source query ping
- Recovery behavior:
  - container restart attempts for core services with exponential backoff
  - restart loop protection: max `WATCHDOG_MAX_RESTARTS_PER_WINDOW` per `WATCHDOG_RESTART_WINDOW_MS`
  - when exceeded, incident marked for manual intervention
- Match-server recovery:
  - marks match interrupted
  - spawns replacement server
  - reactivates match + reconnect flow
  - if not recovered within `WATCHDOG_MATCH_RECOVERY_TIMEOUT_MS`, cancels recovery and triggers MMR rollback flow
- Incident persistence:
  - table: `watchdog_incidents`
  - moderation alerts are emitted to `#mod-log` through `moderation-events`

### Docker Socket Security Note
- The watchdog needs Docker API access to restart containers and recover match servers.
- Current compose mounts `/var/run/docker.sock` into watchdog (high privilege).
- For stricter production hardening, prefer a minimal restart/recovery agent inside `server-manager` and keep watchdog read-only.

## Clip Evidence
- Suspicious highlight events automatically persist evidence timestamps.
- Moderators can generate clips with:
  - `/clip <match_id> <timestamp>`
- API stores clip records in `evidence_clips` and returns `clip_url`.

## Anti-Cheat Telemetry (Server-Side)
- Telemetry ingest endpoint:
  - `POST /telemetry/event` (HMAC protected with timestamp + nonce + signature replay protection)
- Stored tables:
  - `telemetry_events`
  - `player_match_metrics`
  - `player_anti_cheat_profile`
  - `anti_cheat_alerts`
- Continuous worker:
  - `matchmaker` runs `POST /internal/anti-cheat/process` every 5s to compute metrics and suspicion scores.
- Moderator APIs:
  - `GET /anti-cheat/player/:steamId`
  - `GET /anti-cheat/alerts`
  - `POST /anti-cheat/alerts/:id/resolve`
- Discord:
  - Alerts are posted as embeds with buttons in `#mod-log`:
    - `👀 Spectate`
    - `📁 Open Case`
    - `⚠️ Timeout (24h)`
    - `✅ Mark False Positive`

## Smurf / Alt Detection (Non-Invasive)
- Risk model inputs:
  - Steam age/hours/VAC metadata
  - platform performance (ADR/KD/HS), winrate, MMR gain velocity
  - report pressure/accuracy
  - shared hashed identifiers (`ip_hash`, `device_hash`, Discord mapping)
- Data tables:
  - `player_risk_profile`
  - `risk_alerts`
  - `identifier_links`
- Outcomes:
  - `<40`: normal
  - `40-69`: suspected smurf -> routed into smurf pool queue
  - `70-89`: high suspicion -> ranked queue restricted, unranked allowed
  - `>=90`: ban-evasion likely -> queue blocked + mod alert
- Moderator APIs:
  - `GET /risk/smurf/:steamId`
  - `GET /risk/smurf-alerts`
  - `POST /risk/smurf/:steamId/action`
- Worker:
  - matchmaker periodically calls `POST /internal/risk/smurf/process`
- Discord:
  - `#mod-log` receives `🕵️ Smurf / Alt Alert` embed with action buttons:
    - `✅ Allow`
    - `👀 Monitor`
    - `🧾 Open Evidence`
    - `⛔ Block Ranked`
    - `🚫 Ban`

### Production Cloudflare Notes
- Put Cloudflare in front of proxy with orange-cloud (proxied) DNS, not DNS-only.
- Recommended rules:
  - Bot fight mode / managed challenge on suspicious paths.
  - Rate limit rules on `/queue/join`, `/report`, `/matches/*`, `/cases/*`.
  - Block malformed payloads and oversized bodies at edge.
- Keep origin restricted:
  - allow Cloudflare IP ranges only at firewall for proxy ingress.
  - do not expose internal API/service ports publicly.
