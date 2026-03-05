# Ranked Banner SourceMod Plugin

## Files
- `plugins/ranked_banner.sp`: SourcePawn source
- `cfg/sourcemod/ranked_banner.cfg`: runtime configuration
- `plugins/superpower_mode.sp`: SourcePawn source
- `cfg/sourcemod/superpower_mode.cfg`: runtime configuration
- `plugins/gun_game_mode.sp`: SourcePawn source
- `cfg/sourcemod/gun_game_mode.cfg`: runtime configuration
- `plugins/zombie_mode.sp`: SourcePawn source
- `cfg/sourcemod/zombie_mode.cfg`: runtime configuration
- `plugins/anti_cheat_telemetry.sp`: SourcePawn source (telemetry skeleton)
- `cfg/sourcemod/anti_cheat_telemetry.cfg`: runtime configuration
- `plugins/fraghub_cosmetic_skins.sp`: SourcePawn source (server-side cosmetic skins skeleton)
- `cfg/sourcemod/fraghub_cosmetic_skins.cfg`: runtime configuration
- `plugins/match_intro.sp`: SourcePawn source (server-side match introduction messages)
- `cfg/sourcemod/fraghub_match_intro.cfg`: runtime configuration
- `plugins/fraghub_competitive.sp`: SourcePawn source (knife round, pause, tech timeout, halftime chat)
- `cfg/sourcemod/fraghub_competitive.cfg`: runtime configuration
- `plugins/fraghub_match_whitelist.sp`: SourcePawn source (secure whitelist, reconnect, spectator lock)
- `cfg/sourcemod/fraghub_match_whitelist.cfg`: runtime configuration

## Behavior
- Round start: prints `sm_ranked_banner_round_start` to all players.
- Player join: prints `sm_ranked_banner_player_join` to the joining player.
- Kill event: prints `sm_ranked_banner_kill` to the attacker.

## Build
Compile `plugins/ranked_banner.sp` with `spcomp` to produce `ranked_banner.smx`.
Compile `plugins/superpower_mode.sp` with `spcomp` to produce `superpower_mode.smx`.
Compile `plugins/gun_game_mode.sp` with `spcomp` to produce `gun_game_mode.smx`.
Compile `plugins/zombie_mode.sp` with `spcomp` to produce `zombie_mode.smx`.
Compile `plugins/anti_cheat_telemetry.sp` with `spcomp` to produce `anti_cheat_telemetry.smx`.
Compile `plugins/fraghub_cosmetic_skins.sp` with `spcomp` to produce `fraghub_cosmetic_skins.smx`.
Compile `plugins/match_intro.sp` with `spcomp` to produce `match_intro.smx`.
Compile `plugins/fraghub_competitive.sp` with `spcomp` to produce `fraghub_competitive.smx`.
Compile `plugins/fraghub_match_whitelist.sp` with `spcomp` to produce `fraghub_match_whitelist.smx`.

## Install
1. Copy `ranked_banner.smx` to:
`csgo/addons/sourcemod/plugins/ranked_banner.smx`
Also copy `superpower_mode.smx` to:
`csgo/addons/sourcemod/plugins/superpower_mode.smx`
Also copy `gun_game_mode.smx` to:
`csgo/addons/sourcemod/plugins/gun_game_mode.smx`
Also copy `zombie_mode.smx` to:
`csgo/addons/sourcemod/plugins/zombie_mode.smx`
Also copy `anti_cheat_telemetry.smx` to:
`csgo/addons/sourcemod/plugins/anti_cheat_telemetry.smx`
Also copy `fraghub_cosmetic_skins.smx` to:
`csgo/addons/sourcemod/plugins/fraghub_cosmetic_skins.smx`
Also copy `match_intro.smx` to:
`csgo/addons/sourcemod/plugins/match_intro.smx`
Also copy `fraghub_competitive.smx` to:
`csgo/addons/sourcemod/plugins/fraghub_competitive.smx`
Also copy `fraghub_match_whitelist.smx` to:
`csgo/addons/sourcemod/plugins/fraghub_match_whitelist.smx`
2. Copy config to:
`csgo/cfg/sourcemod/ranked_banner.cfg`
And:
`csgo/cfg/sourcemod/superpower_mode.cfg`
And:
`csgo/cfg/sourcemod/gun_game_mode.cfg`
And:
`csgo/cfg/sourcemod/zombie_mode.cfg`
And:
`csgo/cfg/sourcemod/anti_cheat_telemetry.cfg`
And:
`csgo/cfg/sourcemod/fraghub_cosmetic_skins.cfg`
And:
`csgo/cfg/sourcemod/fraghub_match_intro.cfg`
And:
`csgo/cfg/sourcemod/fraghub_competitive.cfg`
And:
`csgo/cfg/sourcemod/fraghub_match_whitelist.cfg`
3. Restart server or run:
`sm plugins reload ranked_banner`
`sm plugins reload superpower_mode`
`sm plugins reload gun_game_mode`
`sm plugins reload zombie_mode`
`sm plugins reload anti_cheat_telemetry`
`sm plugins reload fraghub_cosmetic_skins`
`sm plugins reload match_intro`
`sm plugins reload fraghub_competitive`
`sm plugins reload fraghub_match_whitelist`

## Config Cvars
- `sm_ranked_banner_enabled` (`0|1`)
- `sm_ranked_banner_prefix`
- `sm_ranked_banner_round_start`
- `sm_ranked_banner_player_join`
- `sm_ranked_banner_kill`

## Superpower Cvars
- `sm_superpower_enabled` (`0|1`)
- `sm_superpower_teleport_cooldown`
- `sm_superpower_regen_per_tick`
- `sm_superpower_regen_tick_seconds`

## Gun Game Cvars
- `sm_gungame_enabled` (`0|1`)

## Zombie Cvars
- `sm_zombie_enabled` (`0|1`)
- `sm_zombie_health`
- `sm_zombie_speed`

## Anti-Cheat Telemetry Cvars
- `sm_ac_telemetry_enabled` (`0|1`)
- `sm_ac_telemetry_api_url`
- `sm_ac_telemetry_match_id`
- `sm_ac_telemetry_hmac_secret`

## FragHub Cosmetic Skins Cvars
- `sm_fraghub_skins_enabled` (`0|1`)
- `sm_fraghub_skins_api_base`
- `sm_fraghub_skins_api_token`

## Match Intro Cvars
- `sm_fraghub_match_intro_enabled` (`0|1`)
- `sm_fraghub_match_intro_mode`
- `sm_fraghub_match_intro_report_command`
- `sm_fraghub_match_intro_join_delay`

## FragHub Competitive Cvars
- `sm_fraghub_comp_enabled` (`0|1`)
- `sm_fraghub_comp_knife_round_enabled` (`0|1`)
- `sm_fraghub_comp_max_pauses_per_team`
- `sm_fraghub_comp_max_tech_timeouts`
- `sm_fraghub_comp_pause_duration` (seconds)
- `sm_fraghub_comp_tech_timeout_duration` (seconds)
- `sm_fraghub_comp_pause_cooldown` (seconds)
- `sm_fraghub_comp_overtime_win_by_two` (`0|1`)
- `sm_fraghub_comp_reconnect_window_minutes`
- `sm_fraghub_comp_bot_replace_on_disconnect` (`0|1`)
- `sm_fraghub_comp_match_id`

## Match Whitelist Cvars
- `sm_fraghub_whitelist_enabled` (`0|1`)
- `sm_fraghub_whitelist_match_id`
- `sm_fraghub_whitelist_api_base`
- `sm_fraghub_whitelist_api_token`
- `sm_fraghub_whitelist_verify_api_enabled` (`0|1`)
- `sm_fraghub_whitelist_reconnect_window_minutes`
- `sm_fraghub_whitelist_bot_replace_on_disconnect` (`0|1`)
- `sm_fraghub_whitelist_spectator_disabled` (`0|1`)
