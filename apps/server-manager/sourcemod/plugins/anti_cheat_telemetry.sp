#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>

public Plugin myinfo =
{
    name = "Anti-Cheat Telemetry",
    author = "csgofaceit",
    description = "Server-side telemetry emitter for anti-cheat analysis (skeleton).",
    version = "0.1.0",
    url = "https://play.maro.run"
};

ConVar gEnabled;
ConVar gApiUrl;
ConVar gMatchId;
ConVar gWebhookSecret;

public void OnPluginStart()
{
    gEnabled = CreateConVar("sm_ac_telemetry_enabled", "1", "Enable anti-cheat telemetry.");
    gApiUrl = CreateConVar("sm_ac_telemetry_api_url", "http://api:3001/telemetry/event", "Telemetry ingest endpoint.");
    gMatchId = CreateConVar("sm_ac_telemetry_match_id", "", "Match UUID for this server.");
    gWebhookSecret = CreateConVar("sm_ac_telemetry_hmac_secret", "", "HMAC secret used by telemetry webhook.");
    AutoExecConfig(true, "anti_cheat_telemetry");

    HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
    HookEvent("player_death", Event_PlayerDeath, EventHookMode_Post);
    HookEvent("player_hurt", Event_PlayerHurt, EventHookMode_Post);
    HookEvent("weapon_fire", Event_WeaponFire, EventHookMode_Post);
    HookEvent("bomb_planted", Event_BombPlanted, EventHookMode_Post);
    HookEvent("bomb_defused", Event_BombDefused, EventHookMode_Post);
    HookEvent("bomb_exploded", Event_BombExploded, EventHookMode_Post);
    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
    HookEvent("round_end", Event_RoundEnd, EventHookMode_Post);
}

bool IsEnabled()
{
    return gEnabled != null && gEnabled.BoolValue;
}

bool IsPlayableClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

void GetClientSteamIdSafe(int client, char[] outSteam, int outLen)
{
    if (!GetClientAuthId(client, AuthId_SteamID64, outSteam, outLen, true))
    {
        strcopy(outSteam, outLen, "unknown");
    }
}

int UnixMs()
{
    return GetTime() * 1000;
}

void SendTelemetry(const char[] steamId, const char[] type, const char[] payloadJson)
{
    if (!IsEnabled())
    {
        return;
    }

    char apiUrl[256];
    char matchId[96];
    char secret[256];
    gApiUrl.GetString(apiUrl, sizeof(apiUrl));
    gMatchId.GetString(matchId, sizeof(matchId));
    gWebhookSecret.GetString(secret, sizeof(secret));

    if (apiUrl[0] == '\0' || matchId[0] == '\0')
    {
        return;
    }

    char body[1536];
    Format(
        body,
        sizeof(body),
        "{\"match_id\":\"%s\",\"steam_id\":\"%s\",\"type\":\"%s\",\"payload\":%s}",
        matchId,
        steamId,
        type,
        payloadJson
    );

    // Skeleton note:
    // Integrate an HTTP extension (SteamWorks/REST in Pawn) here and POST to sm_ac_telemetry_api_url.
    // Required headers expected by API:
    // - x-telemetry-timestamp
    // - x-telemetry-nonce
    // - x-telemetry-signature
    //
    // Signature format:
    //   HMAC_SHA256(secret, "<ts>.<nonce>.POST./telemetry/event.<sha256(body)>")
    // Since HMAC/SHA helpers vary by extension, this skeleton logs the payload and
    // leaves the HTTP/signature implementation to the chosen extension.
    LogMessage("[anti_cheat_telemetry] queued type=%s steam=%s body=%s", type, steamId, body);
}

public Action Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
    int userid = event.GetInt("userid");
    int client = GetClientOfUserId(userid);
    if (!IsPlayableClient(client))
    {
        return Plugin_Continue;
    }

    char steamId[64];
    GetClientSteamIdSafe(client, steamId, sizeof(steamId));
    int round = GameRules_GetProp("m_totalRoundsPlayed") + 1;

    char payload[128];
    Format(payload, sizeof(payload), "{\"round\":%d}", round);
    SendTelemetry(steamId, "player_spawn", payload);
    return Plugin_Continue;
}

public Action Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
    int attackerUserId = event.GetInt("attacker");
    int victimUserId = event.GetInt("userid");
    int attacker = GetClientOfUserId(attackerUserId);
    int victim = GetClientOfUserId(victimUserId);
    if (!IsPlayableClient(attacker) || !IsPlayableClient(victim))
    {
        return Plugin_Continue;
    }

    char killerSteam[64];
    char victimSteam[64];
    GetClientSteamIdSafe(attacker, killerSteam, sizeof(killerSteam));
    GetClientSteamIdSafe(victim, victimSteam, sizeof(victimSteam));

    char weapon[64];
    event.GetString("weapon", weapon, sizeof(weapon));
    bool hs = event.GetBool("headshot");
    bool wallbang = event.GetBool("penetrated");

    char payload[384];
    Format(
        payload,
        sizeof(payload),
        "{\"killer\":\"%s\",\"victim\":\"%s\",\"weapon\":\"%s\",\"headshot\":%s,\"wallbang\":%s,\"distance\":0,\"timestamp\":%d}",
        killerSteam,
        victimSteam,
        weapon,
        hs ? "true" : "false",
        wallbang ? "true" : "false",
        UnixMs()
    );
    SendTelemetry(killerSteam, "player_death", payload);
    return Plugin_Continue;
}

public Action Event_PlayerHurt(Event event, const char[] name, bool dontBroadcast)
{
    int attackerUserId = event.GetInt("attacker");
    int victimUserId = event.GetInt("userid");
    int attacker = GetClientOfUserId(attackerUserId);
    int victim = GetClientOfUserId(victimUserId);
    if (!IsPlayableClient(attacker) || !IsPlayableClient(victim))
    {
        return Plugin_Continue;
    }

    char attackerSteam[64];
    char victimSteam[64];
    GetClientSteamIdSafe(attacker, attackerSteam, sizeof(attackerSteam));
    GetClientSteamIdSafe(victim, victimSteam, sizeof(victimSteam));

    int damage = event.GetInt("dmg_health");
    int hitgroup = event.GetInt("hitgroup");
    char payload[256];
    Format(
        payload,
        sizeof(payload),
        "{\"attacker\":\"%s\",\"victim\":\"%s\",\"damage\":%d,\"hitgroup\":\"%d\",\"timestamp\":%d}",
        attackerSteam,
        victimSteam,
        damage,
        hitgroup,
        UnixMs()
    );
    SendTelemetry(attackerSteam, "player_hurt", payload);
    return Plugin_Continue;
}

public Action Event_WeaponFire(Event event, const char[] name, bool dontBroadcast)
{
    int userid = event.GetInt("userid");
    int client = GetClientOfUserId(userid);
    if (!IsPlayableClient(client))
    {
        return Plugin_Continue;
    }

    char steamId[64];
    char weapon[64];
    GetClientSteamIdSafe(client, steamId, sizeof(steamId));
    event.GetString("weapon", weapon, sizeof(weapon));

    char payload[192];
    Format(payload, sizeof(payload), "{\"player\":\"%s\",\"weapon\":\"%s\",\"timestamp\":%d}", steamId, weapon, UnixMs());
    SendTelemetry(steamId, "weapon_fire", payload);
    return Plugin_Continue;
}

public Action Event_BombPlanted(Event event, const char[] name, bool dontBroadcast)
{
    char payload[96];
    Format(payload, sizeof(payload), "{\"event\":\"plant\",\"timestamp\":%d}", UnixMs());
    SendTelemetry("server", "bomb_event", payload);
    return Plugin_Continue;
}

public Action Event_BombDefused(Event event, const char[] name, bool dontBroadcast)
{
    char payload[96];
    Format(payload, sizeof(payload), "{\"event\":\"defuse\",\"timestamp\":%d}", UnixMs());
    SendTelemetry("server", "bomb_event", payload);
    return Plugin_Continue;
}

public Action Event_BombExploded(Event event, const char[] name, bool dontBroadcast)
{
    char payload[96];
    Format(payload, sizeof(payload), "{\"event\":\"explode\",\"timestamp\":%d}", UnixMs());
    SendTelemetry("server", "bomb_event", payload);
    return Plugin_Continue;
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    int round = GameRules_GetProp("m_totalRoundsPlayed") + 1;
    int scoreA = GetTeamScore(2);
    int scoreB = GetTeamScore(3);
    char payload[160];
    Format(payload, sizeof(payload), "{\"round\":%d,\"score_team_a\":%d,\"score_team_b\":%d,\"timestamp\":%d}", round, scoreA, scoreB, UnixMs());
    SendTelemetry("server", "round_start", payload);
    return Plugin_Continue;
}

public Action Event_RoundEnd(Event event, const char[] name, bool dontBroadcast)
{
    int round = GameRules_GetProp("m_totalRoundsPlayed");
    int scoreA = GetTeamScore(2);
    int scoreB = GetTeamScore(3);
    char winner[4];
    int winnerTeam = event.GetInt("winner");
    strcopy(winner, sizeof(winner), winnerTeam == 2 ? "A" : "B");
    char payload[192];
    Format(
        payload,
        sizeof(payload),
        "{\"round\":%d,\"score_team_a\":%d,\"score_team_b\":%d,\"winner\":\"%s\",\"timestamp\":%d}",
        round,
        scoreA,
        scoreB,
        winner,
        UnixMs()
    );
    SendTelemetry("server", "round_end", payload);
    return Plugin_Continue;
}
