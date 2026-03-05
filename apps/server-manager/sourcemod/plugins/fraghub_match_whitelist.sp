#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <cstrike>
#tryinclude <steamworks>

public Plugin myinfo =
{
    name = "FragHub Match Whitelist",
    author = "csgofaceit",
    description = "Secure roster whitelist with API verification, spectator lock, and reconnect support.",
    version = "1.0.0",
    url = "https://play.maro.run"
};

#define TEAM_T 2
#define TEAM_CT 3

ConVar gCvarEnabled;
ConVar gCvarMatchId;
ConVar gCvarApiBase;
ConVar gCvarApiToken;
ConVar gCvarVerifyApiEnabled;
ConVar gCvarReconnectWindowMinutes;
ConVar gCvarBotReplaceOnDisconnect;
ConVar gCvarSpectatorDisabled;

StringMap gVerifiedTeamBySteam;
StringMap gVerifiedSlotBySteam;
StringMap gReconnectDeadlineBySteam;
StringMap gReconnectTeamBySteam;
StringMap gReconnectSlotBySteam;

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_fraghub_whitelist_enabled",
        "1",
        "Enable FragHub secure match whitelist.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );
    gCvarMatchId = CreateConVar("sm_fraghub_whitelist_match_id", "unknown", "FragHub match id.", FCVAR_NOTIFY);
    gCvarApiBase = CreateConVar("sm_fraghub_whitelist_api_base", "http://api:3001", "FragHub API base URL.", FCVAR_NOTIFY);
    gCvarApiToken = CreateConVar("sm_fraghub_whitelist_api_token", "", "Internal API token for whitelist verification.", FCVAR_PROTECTED);
    gCvarVerifyApiEnabled = CreateConVar("sm_fraghub_whitelist_verify_api_enabled", "1", "Enable API verification for join authorization.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
    gCvarReconnectWindowMinutes = CreateConVar("sm_fraghub_whitelist_reconnect_window_minutes", "10", "Reconnect window in minutes.", FCVAR_NOTIFY, true, 1.0, true, 60.0);
    gCvarBotReplaceOnDisconnect = CreateConVar("sm_fraghub_whitelist_bot_replace_on_disconnect", "1", "Assign bot if reconnect window expires.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
    gCvarSpectatorDisabled = CreateConVar("sm_fraghub_whitelist_spectator_disabled", "1", "Block spectator team joins for competitive matches.", FCVAR_NOTIFY, true, 0.0, true, 1.0);

    AutoExecConfig(true, "fraghub_match_whitelist");

    AddCommandListener(Command_JoinTeam, "jointeam");
    HookEvent("player_disconnect", Event_PlayerDisconnect, EventHookMode_Post);

    gVerifiedTeamBySteam = new StringMap();
    gVerifiedSlotBySteam = new StringMap();
    gReconnectDeadlineBySteam = new StringMap();
    gReconnectTeamBySteam = new StringMap();
    gReconnectSlotBySteam = new StringMap();
}

public void OnMapStart()
{
    if (gVerifiedTeamBySteam != null)
    {
        delete gVerifiedTeamBySteam;
    }
    if (gVerifiedSlotBySteam != null)
    {
        delete gVerifiedSlotBySteam;
    }
    if (gReconnectDeadlineBySteam != null)
    {
        delete gReconnectDeadlineBySteam;
    }
    if (gReconnectTeamBySteam != null)
    {
        delete gReconnectTeamBySteam;
    }
    if (gReconnectSlotBySteam != null)
    {
        delete gReconnectSlotBySteam;
    }

    gVerifiedTeamBySteam = new StringMap();
    gVerifiedSlotBySteam = new StringMap();
    gReconnectDeadlineBySteam = new StringMap();
    gReconnectTeamBySteam = new StringMap();
    gReconnectSlotBySteam = new StringMap();
}

bool IsPluginEnabled()
{
    return gCvarEnabled != null && gCvarEnabled.BoolValue;
}

bool IsValidHumanClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

void ChatInfoAll(const char[] fmt, any ...)
{
    char message[256];
    VFormat(message, sizeof(message), fmt, 2);
    PrintToChatAll("\x04[FragHub]\x01 %s", message);
}

void ChatWarnClient(int client, const char[] fmt, any ...)
{
    char message[256];
    VFormat(message, sizeof(message), fmt, 3);
    PrintToChat(client, "\x02[FragHub]\x01 %s", message);
}

bool GetSteamId64(int client, char[] steamId, int maxLen)
{
    return GetClientAuthId(client, AuthId_SteamID64, steamId, maxLen, true);
}

int TeamFromApiName(const char[] teamName)
{
    if (StrEqual(teamName, "team1", false) || StrEqual(teamName, "A", false))
    {
        return TEAM_T;
    }
    if (StrEqual(teamName, "team2", false) || StrEqual(teamName, "B", false))
    {
        return TEAM_CT;
    }
    return 0;
}

void KickRestricted(int client)
{
    KickClient(client, "This server is restricted to FragHub match players.");
}

void KickSpectator(int client)
{
    KickClient(client, "Spectating is disabled for competitive matches.");
}

#if defined _steamworks_included
void FetchAndApplyUsername(int client, const char[] steamId)
{
    if (!IsValidHumanClient(client))
    {
        return;
    }
    if (!LibraryExists("SteamWorks"))
    {
        return;
    }

    char base[256];
    char token[256];
    gCvarApiBase.GetString(base, sizeof(base));
    gCvarApiToken.GetString(token, sizeof(token));
    if (base[0] == '\0' || token[0] == '\0' || steamId[0] == '\0')
    {
        return;
    }

    char url[512];
    Format(url, sizeof(url), "%s/internal/player/profile?steam_id=%s", base, steamId);
    Handle request = SteamWorks_CreateHTTPRequest(k_EHTTPMethodGET, url);
    if (request == INVALID_HANDLE)
    {
        return;
    }

    SteamWorks_SetHTTPRequestHeaderValue(request, "x-internal-token", token);
    SteamWorks_SetHTTPRequestNetworkActivityTimeout(request, 5);
    SteamWorks_SetHTTPCallbacks(request, OnFetchUsernameHttpCompleted);
    SteamWorks_SetHTTPRequestContextValue(request, GetClientUserId(client));
    SteamWorks_SendHTTPRequest(request);
}
#endif

public Action Command_JoinTeam(int client, const char[] command, int argc)
{
    if (!IsPluginEnabled() || !IsValidHumanClient(client) || !gCvarSpectatorDisabled.BoolValue)
    {
        return Plugin_Continue;
    }

    char arg[16];
    GetCmdArg(1, arg, sizeof(arg));
    int requested = StringToInt(arg);
    if (requested == 1)
    {
        ChatWarnClient(client, "Spectating is disabled for competitive matches.");
        return Plugin_Handled;
    }
    return Plugin_Continue;
}

public void OnClientPostAdminCheck(int client)
{
    if (!IsPluginEnabled() || !IsValidHumanClient(client))
    {
        return;
    }

    if (gCvarSpectatorDisabled.BoolValue && GetClientTeam(client) == 1)
    {
        ChatWarnClient(client, "Spectating is disabled for competitive matches.");
    }

    CreateTimer(0.2, Timer_VerifyJoin, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_VerifyJoin(Handle timer, any userId)
{
    int client = GetClientOfUserId(userId);
    if (!IsValidHumanClient(client))
    {
        return Plugin_Stop;
    }

    char steamId[32];
    if (!GetSteamId64(client, steamId, sizeof(steamId)))
    {
        KickRestricted(client);
        return Plugin_Stop;
    }

    if (!gCvarVerifyApiEnabled.BoolValue)
    {
        KickRestricted(client);
        return Plugin_Stop;
    }

    #if defined _steamworks_included
    if (!LibraryExists("SteamWorks"))
    {
        KickClient(client, "Whitelist verification unavailable.");
        return Plugin_Stop;
    }

    char base[256];
    char token[256];
    char matchId[128];
    gCvarApiBase.GetString(base, sizeof(base));
    gCvarApiToken.GetString(token, sizeof(token));
    gCvarMatchId.GetString(matchId, sizeof(matchId));

    if (base[0] == '\0' || token[0] == '\0' || matchId[0] == '\0' || StrEqual(matchId, "unknown", false))
    {
        KickClient(client, "Whitelist verification unavailable.");
        return Plugin_Stop;
    }

    char url[512];
    Format(url, sizeof(url), "%s/internal/match/verify-player?match_id=%s&steam_id=%s", base, matchId, steamId);

    Handle request = SteamWorks_CreateHTTPRequest(k_EHTTPMethodGET, url);
    if (request == INVALID_HANDLE)
    {
        KickClient(client, "Whitelist verification unavailable.");
        return Plugin_Stop;
    }

    SteamWorks_SetHTTPRequestHeaderValue(request, "x-internal-token", token);
    SteamWorks_SetHTTPRequestNetworkActivityTimeout(request, 5);
    SteamWorks_SetHTTPCallbacks(request, OnVerifyPlayerHttpCompleted);
    SteamWorks_SetHTTPRequestContextValue(request, userId);
    SteamWorks_SendHTTPRequest(request);
    #else
    KickClient(client, "Whitelist verification unavailable.");
    #endif

    return Plugin_Stop;
}

#if defined _steamworks_included
public int OnVerifyPlayerHttpCompleted(Handle request, bool failure, bool requestSuccessful, EHTTPStatusCode statusCode, any userId)
{
    int client = GetClientOfUserId(userId);
    if (!IsValidHumanClient(client))
    {
        if (request != INVALID_HANDLE)
        {
            delete request;
        }
        return 0;
    }

    if (failure || !requestSuccessful || statusCode != k_EHTTPStatusCode200OK)
    {
        if (request != INVALID_HANDLE)
        {
            delete request;
        }
        KickRestricted(client);
        return 0;
    }

    int bodySize = 0;
    SteamWorks_GetHTTPResponseBodySize(request, bodySize);
    if (bodySize <= 0 || bodySize > 4096)
    {
        if (request != INVALID_HANDLE)
        {
            delete request;
        }
        KickRestricted(client);
        return 0;
    }

    char body[4096];
    SteamWorks_GetHTTPResponseBodyData(request, body, sizeof(body));
    if (request != INVALID_HANDLE)
    {
        delete request;
    }

    if (StrContains(body, "\"allowed\":true", false) == -1)
    {
        KickRestricted(client);
        return 0;
    }

    char teamToken[32];
    int slot = 0;
    if (!ParseJsonFieldString(body, "\"team\":\"", teamToken, sizeof(teamToken)))
    {
        KickRestricted(client);
        return 0;
    }
    ParseJsonFieldInt(body, "\"slot\":", slot);

    int team = TeamFromApiName(teamToken);
    if (team != TEAM_T && team != TEAM_CT)
    {
        KickRestricted(client);
        return 0;
    }

    char steamId[32];
    if (!GetSteamId64(client, steamId, sizeof(steamId)))
    {
        KickRestricted(client);
        return 0;
    }

    int prevDeadline = 0;
    bool hadReconnect = gReconnectDeadlineBySteam.GetValue(steamId, prevDeadline);
    bool reconnectActive = hadReconnect && prevDeadline >= GetTime();

    gVerifiedTeamBySteam.SetValue(steamId, team, true);
    gVerifiedSlotBySteam.SetValue(steamId, slot, true);
    gReconnectDeadlineBySteam.Remove(steamId);
    gReconnectTeamBySteam.Remove(steamId);
    gReconnectSlotBySteam.Remove(steamId);

    if (GetClientTeam(client) != team)
    {
        CS_SwitchTeam(client, team);
        CS_RespawnPlayer(client);
    }

    FetchAndApplyUsername(client, steamId);

    if (reconnectActive)
    {
        KickOneBotOnTeam(team);
        ChatInfoAll("Player reconnected to the match.");
    }

    return 0;
}
#endif

#if defined _steamworks_included
public int OnFetchUsernameHttpCompleted(Handle request, bool failure, bool requestSuccessful, EHTTPStatusCode statusCode, any userId)
{
    int client = GetClientOfUserId(userId);
    if (!IsValidHumanClient(client))
    {
        if (request != INVALID_HANDLE)
        {
            delete request;
        }
        return 0;
    }

    if (failure || !requestSuccessful || statusCode != k_EHTTPStatusCode200OK)
    {
        if (request != INVALID_HANDLE)
        {
            delete request;
        }
        return 0;
    }

    int bodySize = 0;
    SteamWorks_GetHTTPResponseBodySize(request, bodySize);
    if (bodySize <= 0 || bodySize > 2048)
    {
        if (request != INVALID_HANDLE)
        {
            delete request;
        }
        return 0;
    }

    char body[2048];
    SteamWorks_GetHTTPResponseBodyData(request, body, sizeof(body));
    if (request != INVALID_HANDLE)
    {
        delete request;
    }

    char username[64];
    if (!ParseJsonFieldString(body, "\"display_name\":\"", username, sizeof(username)))
    {
        if (!ParseJsonFieldString(body, "\"username\":\"", username, sizeof(username)))
        {
            return 0;
        }
    }
    if (username[0] == '\0')
    {
        return 0;
    }

    SetClientName(client, username);
    return 0;
}
#endif

bool ParseJsonFieldString(const char[] json, const char[] prefix, char[] outValue, int outLen)
{
    int start = StrContains(json, prefix, false);
    if (start == -1)
    {
        return false;
    }
    start += strlen(prefix);
    int end = start;
    while (json[end] != '\0' && json[end] != '"' && end - start < outLen - 1)
    {
        end++;
    }
    if (end <= start)
    {
        return false;
    }
    int copyLen = end - start;
    if (copyLen >= outLen)
    {
        copyLen = outLen - 1;
    }
    for (int i = 0; i < copyLen; i++)
    {
        outValue[i] = json[start + i];
    }
    outValue[copyLen] = '\0';
    return true;
}

bool ParseJsonFieldInt(const char[] json, const char[] prefix, int &outValue)
{
    int start = StrContains(json, prefix, false);
    if (start == -1)
    {
        return false;
    }
    start += strlen(prefix);
    char numberRaw[32];
    int i = 0;
    while (json[start] != '\0' && i < sizeof(numberRaw) - 1)
    {
        char c = json[start];
        if (c < '0' || c > '9')
        {
            break;
        }
        numberRaw[i++] = c;
        start++;
    }
    numberRaw[i] = '\0';
    if (i == 0)
    {
        return false;
    }
    outValue = StringToInt(numberRaw);
    return true;
}

void KickOneBotOnTeam(int team)
{
    for (int client = 1; client <= MaxClients; client++)
    {
        if (!IsClientInGame(client) || !IsFakeClient(client))
        {
            continue;
        }
        if (GetClientTeam(client) != team)
        {
            continue;
        }
        KickClient(client, "FragHub player reconnected");
        return;
    }
}

public Action Event_PlayerDisconnect(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    char steamId[32];
    steamId[0] = '\0';
    int userId = event.GetInt("userid");
    int client = GetClientOfUserId(userId);
    if (client > 0 && client <= MaxClients)
    {
        GetSteamId64(client, steamId, sizeof(steamId));
    }
    if (steamId[0] == '\0')
    {
        event.GetString("networkid", steamId, sizeof(steamId));
    }
    if (steamId[0] == '\0' || StrEqual(steamId, "BOT", false))
    {
        return Plugin_Continue;
    }

    int team = 0;
    if (!gVerifiedTeamBySteam.GetValue(steamId, team))
    {
        return Plugin_Continue;
    }
    int slot = 0;
    gVerifiedSlotBySteam.GetValue(steamId, slot);

    int deadline = GetTime() + (gCvarReconnectWindowMinutes.IntValue * 60);
    gReconnectDeadlineBySteam.SetValue(steamId, deadline, true);
    gReconnectTeamBySteam.SetValue(steamId, team, true);
    gReconnectSlotBySteam.SetValue(steamId, slot, true);

    ChatInfoAll("Player disconnected. Waiting for reconnect.");

    DataPack pack = new DataPack();
    pack.WriteString(steamId);
    pack.WriteCell(team);
    CreateDataTimer(float(gCvarReconnectWindowMinutes.IntValue * 60), Timer_ReconnectExpired, pack, TIMER_FLAG_NO_MAPCHANGE);
    return Plugin_Continue;
}

public Action Timer_ReconnectExpired(Handle timer, DataPack pack)
{
    pack.Reset();
    char steamId[32];
    int team;
    pack.ReadString(steamId, sizeof(steamId));
    team = pack.ReadCell();
    delete pack;

    int deadline = 0;
    if (!gReconnectDeadlineBySteam.GetValue(steamId, deadline))
    {
        return Plugin_Stop;
    }

    if (deadline > GetTime())
    {
        return Plugin_Stop;
    }

    gReconnectDeadlineBySteam.Remove(steamId);
    gReconnectTeamBySteam.Remove(steamId);
    gReconnectSlotBySteam.Remove(steamId);

    if (gCvarBotReplaceOnDisconnect.BoolValue)
    {
        if (team == TEAM_T)
        {
            ServerCommand("bot_add_t");
        }
        else if (team == TEAM_CT)
        {
            ServerCommand("bot_add_ct");
        }
        ChatInfoAll("Player failed to reconnect. Bot assigned temporarily.");
    }

    return Plugin_Stop;
}
