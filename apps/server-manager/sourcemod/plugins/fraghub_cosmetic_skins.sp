#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>

public Plugin myinfo =
{
    name = "FragHub Cosmetic Skins",
    author = "csgofaceit",
    description = "Applies server-side cosmetic skin selections fetched from API.",
    version = "0.1.0",
    url = "https://play.maro.run"
};

ConVar gEnabled;
ConVar gApiBaseUrl;
ConVar gApiToken;

public void OnPluginStart()
{
    gEnabled = CreateConVar("sm_fraghub_skins_enabled", "1", "Enable FragHub server-side cosmetic skins.");
    gApiBaseUrl = CreateConVar("sm_fraghub_skins_api_base", "http://api:3001", "FragHub API base URL.");
    gApiToken = CreateConVar("sm_fraghub_skins_api_token", "", "Bot/internal API token for skin fetches.");
    AutoExecConfig(true, "fraghub_cosmetic_skins");

    HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
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
        strcopy(outSteam, outLen, "");
    }
}

public Action Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsEnabled())
    {
        return Plugin_Continue;
    }

    int userid = event.GetInt("userid");
    int client = GetClientOfUserId(userid);
    if (!IsPlayableClient(client))
    {
        return Plugin_Continue;
    }

    char steamId[64];
    GetClientSteamIdSafe(client, steamId, sizeof(steamId));
    if (steamId[0] == '\0')
    {
        return Plugin_Continue;
    }

    FetchAndApplyCosmetics(client, steamId);
    return Plugin_Continue;
}

void FetchAndApplyCosmetics(int client, const char[] steamId)
{
    char baseUrl[256];
    gApiBaseUrl.GetString(baseUrl, sizeof(baseUrl));
    if (baseUrl[0] == '\0')
    {
        return;
    }

    // Skeleton integration:
    // 1) GET {sm_fraghub_skins_api_base}/player/skins/<steamId>
    // 2) Parse JSON response: { steam_id, skins: [{ weapon, skin_id, ... }] }
    // 3) Apply paint kits to currently owned weapons via SourceMod/SDK calls.
    //
    // Notes:
    // - This is visual-only and server-local (FragHub servers), no Steam inventory interaction.
    // - Keep a small per-client cache and refresh on spawn / weapon equip for performance.
    LogMessage("[fraghub_cosmetic_skins] player_spawn steam_id=%s -> fetch /player/skins/%s", steamId, steamId);
    ApplyCachedDefaultSkin(client);
}

void ApplyCachedDefaultSkin(int client)
{
    // Placeholder: hook weapon entities and set fallback paint kits if no cached selection exists.
    // This avoids gameplay impact and keeps system cosmetic-only.
    if (!IsPlayableClient(client))
    {
        return;
    }
}
