#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>

public Plugin myinfo =
{
    name = "FragHub Match Intro",
    author = "csgofaceit",
    description = "Sends one-time per-match introduction messages with team and report guidance.",
    version = "1.0.0",
    url = "https://play.maro.run"
};

ConVar gCvarEnabled;
ConVar gCvarModeLabel;
ConVar gCvarReportCommand;
ConVar gCvarJoinDelay;

StringMap gIntroSentBySteamId;
bool gRoundStartIntroAttempted;

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_fraghub_match_intro_enabled",
        "1",
        "Enable FragHub match introduction messages.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    gCvarModeLabel = CreateConVar(
        "sm_fraghub_match_intro_mode",
        "Ranked 5v5",
        "Match mode label shown in intro message.",
        FCVAR_NOTIFY
    );

    gCvarReportCommand = CreateConVar(
        "sm_fraghub_match_intro_report_command",
        "!report <player> cheating",
        "Report command example shown to players.",
        FCVAR_NOTIFY
    );

    gCvarJoinDelay = CreateConVar(
        "sm_fraghub_match_intro_join_delay",
        "3.0",
        "Delay in seconds before sending intro after player joins.",
        FCVAR_NOTIFY,
        true,
        0.5,
        true,
        20.0
    );

    gIntroSentBySteamId = new StringMap();
    gRoundStartIntroAttempted = false;

    AutoExecConfig(true, "fraghub_match_intro");

    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
    HookEvent("player_team", Event_PlayerTeam, EventHookMode_Post);
}

public void OnMapStart()
{
    if (gIntroSentBySteamId != null)
    {
        delete gIntroSentBySteamId;
    }
    gIntroSentBySteamId = new StringMap();
    gRoundStartIntroAttempted = false;
}

public void OnClientPostAdminCheck(int client)
{
    if (!IsPluginEnabled() || !IsValidHumanClient(client))
    {
        return;
    }

    float delay = gCvarJoinDelay.FloatValue;
    CreateTimer(delay, Timer_SendIntroForClient, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public Action Event_PlayerTeam(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    int client = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(client))
    {
        return Plugin_Continue;
    }

    int team = GetClientTeam(client);
    if (team < 2)
    {
        return Plugin_Continue;
    }

    if (HasIntroBeenSent(client))
    {
        return Plugin_Continue;
    }

    CreateTimer(1.0, Timer_SendIntroForClient, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
    return Plugin_Continue;
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    // Match-start fallback: attempt intro for players who joined before teams stabilized.
    gRoundStartIntroAttempted = true;
    for (int client = 1; client <= MaxClients; client++)
    {
        if (!IsValidHumanClient(client) || HasIntroBeenSent(client))
        {
            continue;
        }
        TrySendIntro(client);
    }

    return Plugin_Continue;
}

public Action Timer_SendIntroForClient(Handle timer, any userId)
{
    int client = GetClientOfUserId(userId);
    if (!IsValidHumanClient(client) || HasIntroBeenSent(client))
    {
        return Plugin_Stop;
    }

    TrySendIntro(client);
    return Plugin_Stop;
}

bool IsPluginEnabled()
{
    return gCvarEnabled != null && gCvarEnabled.BoolValue;
}

bool IsValidHumanClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

bool GetClientSteamId64(int client, char[] steamId, int steamIdLen)
{
    return GetClientAuthId(client, AuthId_SteamID64, steamId, steamIdLen, true);
}

bool HasIntroBeenSent(int client)
{
    char steamId[32];
    if (!GetClientSteamId64(client, steamId, sizeof(steamId)))
    {
        return false;
    }

    int sent = 0;
    if (!gIntroSentBySteamId.GetValue(steamId, sent))
    {
        return false;
    }

    return sent == 1;
}

void MarkIntroSent(int client)
{
    char steamId[32];
    if (!GetClientSteamId64(client, steamId, sizeof(steamId)))
    {
        return;
    }
    gIntroSentBySteamId.SetValue(steamId, 1, true);
}

void TrySendIntro(int client)
{
    if (!IsValidHumanClient(client) || HasIntroBeenSent(client))
    {
        return;
    }

    int team = GetClientTeam(client);
    if (team != 2 && team != 3)
    {
        return;
    }

    PrintIntroLines(client, team);
    MarkIntroSent(client);
}

void PrintIntroLines(int client, int team)
{
    char mapName[64];
    char modeLabel[64];
    char reportExample[128];
    char sideLabel[8];
    char teamLabel[16];

    GetCurrentMap(mapName, sizeof(mapName));
    gCvarModeLabel.GetString(modeLabel, sizeof(modeLabel));
    gCvarReportCommand.GetString(reportExample, sizeof(reportExample));

    if (team == 2)
    {
        strcopy(teamLabel, sizeof(teamLabel), "Team 1");
        strcopy(sideLabel, sizeof(sideLabel), "T");
    }
    else
    {
        strcopy(teamLabel, sizeof(teamLabel), "Team 2");
        strcopy(sideLabel, sizeof(sideLabel), "CT");
    }

    PrintToChat(client, "\x04[FragHub]\x01 Welcome to FragHub Matchmaking.");
    PrintToChat(client, "\x04[FragHub]\x01 This is a competitive match.");
    PrintToChat(client, "\x03[Team]\x01 You are playing for %s. Starting side: %s", teamLabel, sideLabel);

    PrintToChat(client, "\x03[Team]\x01 Your teammates:");
    PrintRoster(client, team, true);

    PrintToChat(client, "\x02[Enemy]\x01 Your enemies:");
    PrintRoster(client, team, false);

    PrintToChat(client, "\x05[Help]\x01 If you encounter cheating or griefing:");
    PrintToChat(client, "\x05[Help]\x01 Use command: \x01!report <player>");
    PrintToChat(client, "\x05[Help]\x01 Example: \x01%s", reportExample);
    PrintToChat(client, "\x05[Help]\x01 Reports will be reviewed by the FragHub Overwatch system.");

    PrintToChat(client, "\x04[Match]\x01 Map: %s", mapName);
    PrintToChat(client, "\x04[Match]\x01 Mode: %s", modeLabel);
    if (StrContains(modeLabel, "Clan War", false) != -1)
    {
        PrintToChatAll("\x04[FragHub]\x01 Clan War Match");
        PrintToChatAll("\x04[FragHub]\x01 %s", modeLabel);
        PrintToChatAll("\x04[FragHub]\x01 Good luck.");
    }
    PrintToChat(client, "\x04[FragHub]\x01 Good luck and have fun.");
}

void PrintRoster(int viewer, int viewerTeam, bool teammates)
{
    bool found = false;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i))
        {
            continue;
        }

        int team = GetClientTeam(i);
        if (team != 2 && team != 3)
        {
            continue;
        }

        if (teammates)
        {
            if (i == viewer || team != viewerTeam)
            {
                continue;
            }
        }
        else if (team == viewerTeam)
        {
            continue;
        }

        char name[64];
        GetClientName(i, name, sizeof(name));
        PrintToChat(viewer, "\x01 - %s", name);
        found = true;
    }

    if (!found)
    {
        if (teammates)
        {
            PrintToChat(viewer, "\x01 - No teammates detected yet.");
        }
        else
        {
            PrintToChat(viewer, "\x01 - No enemies detected yet.");
        }
    }
}
