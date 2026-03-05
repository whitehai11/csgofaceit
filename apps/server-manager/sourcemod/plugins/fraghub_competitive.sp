#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <cstrike>

public Plugin myinfo =
{
    name = "FragHub Competitive",
    author = "csgofaceit",
    description = "Knife round, pause/tech timeout system, and competitive match chat flow.",
    version = "1.0.0",
    url = "https://play.maro.run"
};

// CS team ids.
#define TEAM_T 2
#define TEAM_CT 3

ConVar gCvarEnabled;
ConVar gCvarKnifeRoundEnabled;
ConVar gCvarMaxPausesPerTeam;
ConVar gCvarMaxTechTimeouts;
ConVar gCvarPauseDuration;
ConVar gCvarTechTimeoutDuration;
ConVar gCvarPauseCooldown;
ConVar gCvarOvertimeWinByTwo;
ConVar gCvarReconnectWindowMinutes;
ConVar gCvarBotReplaceOnDisconnect;
ConVar gCvarMatchId;

bool gKnifeRoundActive;
bool gAwaitingKnifeChoice;
bool gLiveStarted;
bool gHalftimeAnnounced;
bool gPauseActive;
bool gPauseIsTech;
bool gOvertimeActive;

int gKnifeWinnerGameTeam;
int gPauseOwnerGameTeam;
int gRoundsPlayed;
int gOvertimeRoundsPlayed;

int gLogicalTeam1GameTeam;
int gLogicalTeam2GameTeam;

int gTeamPauses[4];
int gTeamTechTimeouts[4];
float gTeamPauseCooldownUntil[4];

Handle gPauseEndTimer = INVALID_HANDLE;
Handle gUnpauseCountdownTimer = INVALID_HANDLE;
int gUnpauseCountdownSeconds;

StringMap gMatchRosterTeams;
StringMap gReconnectTeams;
StringMap gReconnectDeadline;

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_fraghub_comp_enabled",
        "1",
        "Enable FragHub competitive plugin.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    gCvarKnifeRoundEnabled = CreateConVar(
        "sm_fraghub_comp_knife_round_enabled",
        "1",
        "Enable automatic knife round before live start.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    gCvarMaxPausesPerTeam = CreateConVar(
        "sm_fraghub_comp_max_pauses_per_team",
        "2",
        "Maximum regular pauses per team per match.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        10.0
    );

    gCvarMaxTechTimeouts = CreateConVar(
        "sm_fraghub_comp_max_tech_timeouts",
        "2",
        "Maximum technical timeouts per team per match.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        10.0
    );

    gCvarPauseDuration = CreateConVar(
        "sm_fraghub_comp_pause_duration",
        "180",
        "Regular pause duration in seconds.",
        FCVAR_NOTIFY,
        true,
        10.0,
        true,
        900.0
    );

    gCvarTechTimeoutDuration = CreateConVar(
        "sm_fraghub_comp_tech_timeout_duration",
        "300",
        "Technical timeout duration in seconds.",
        FCVAR_NOTIFY,
        true,
        10.0,
        true,
        1200.0
    );

    gCvarPauseCooldown = CreateConVar(
        "sm_fraghub_comp_pause_cooldown",
        "60",
        "Cooldown between pauses for the same team in seconds.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        600.0
    );

    gCvarOvertimeWinByTwo = CreateConVar(
        "sm_fraghub_comp_overtime_win_by_two",
        "1",
        "Enable infinite overtime where first team to lead by 2 rounds wins.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    gCvarReconnectWindowMinutes = CreateConVar(
        "sm_fraghub_comp_reconnect_window_minutes",
        "10",
        "Minutes a disconnected player can reconnect to reclaim team slot.",
        FCVAR_NOTIFY,
        true,
        1.0,
        true,
        60.0
    );

    gCvarBotReplaceOnDisconnect = CreateConVar(
        "sm_fraghub_comp_bot_replace_on_disconnect",
        "1",
        "Assign a temporary bot if reconnect window expires.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    gCvarMatchId = CreateConVar(
        "sm_fraghub_comp_match_id",
        "unknown",
        "Current FragHub match identifier.",
        FCVAR_NOTIFY
    );

    AutoExecConfig(true, "fraghub_competitive");

    AddCommandListener(Command_SayListener, "say");
    AddCommandListener(Command_SayListener, "say_team");

    HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
    HookEvent("round_end", Event_RoundEnd, EventHookMode_Post);
    HookEvent("player_disconnect", Event_PlayerDisconnect, EventHookMode_Post);

    gMatchRosterTeams = new StringMap();
    gReconnectTeams = new StringMap();
    gReconnectDeadline = new StringMap();

    ResetMatchState();
}

public void OnMapStart()
{
    ResetMatchState();
    if (!IsPluginEnabled())
    {
        return;
    }

    CreateTimer(3.0, Timer_BeginKnifeRound, _, TIMER_FLAG_NO_MAPCHANGE);
}

void ResetMatchState()
{
    gKnifeRoundActive = false;
    gAwaitingKnifeChoice = false;
    gLiveStarted = false;
    gHalftimeAnnounced = false;
    gPauseActive = false;
    gPauseIsTech = false;
    gOvertimeActive = false;
    gKnifeWinnerGameTeam = 0;
    gPauseOwnerGameTeam = 0;
    gRoundsPlayed = 0;
    gOvertimeRoundsPlayed = 0;
    gLogicalTeam1GameTeam = TEAM_T;
    gLogicalTeam2GameTeam = TEAM_CT;
    gUnpauseCountdownSeconds = 0;

    for (int i = 0; i < 4; i++)
    {
        gTeamPauses[i] = 0;
        gTeamTechTimeouts[i] = 0;
        gTeamPauseCooldownUntil[i] = 0.0;
    }

    if (gPauseEndTimer != INVALID_HANDLE)
    {
        KillTimer(gPauseEndTimer);
        gPauseEndTimer = INVALID_HANDLE;
    }
    if (gUnpauseCountdownTimer != INVALID_HANDLE)
    {
        KillTimer(gUnpauseCountdownTimer);
        gUnpauseCountdownTimer = INVALID_HANDLE;
    }

    if (gMatchRosterTeams != null)
    {
        delete gMatchRosterTeams;
    }
    if (gReconnectTeams != null)
    {
        delete gReconnectTeams;
    }
    if (gReconnectDeadline != null)
    {
        delete gReconnectDeadline;
    }

    gMatchRosterTeams = new StringMap();
    gReconnectTeams = new StringMap();
    gReconnectDeadline = new StringMap();
}

bool IsPluginEnabled()
{
    return gCvarEnabled != null && gCvarEnabled.BoolValue;
}

void ChatInfoAll(const char[] fmt, any ...)
{
    char message[256];
    VFormat(message, sizeof(message), fmt, 2);
    PrintToChatAll("\x04[FragHub]\x01 %s", message);
}

void ChatCommandAll(const char[] fmt, any ...)
{
    char message[256];
    VFormat(message, sizeof(message), fmt, 2);
    PrintToChatAll("\x03[FragHub]\x01 %s", message);
}

void ChatWarnAll(const char[] fmt, any ...)
{
    char message[256];
    VFormat(message, sizeof(message), fmt, 2);
    PrintToChatAll("\x02[FragHub]\x01 %s", message);
}

void ChatWarnClient(int client, const char[] fmt, any ...)
{
    char message[256];
    VFormat(message, sizeof(message), fmt, 3);
    PrintToChat(client, "\x02[FragHub]\x01 %s", message);
}

bool IsValidHumanClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

bool GetSteamId64(int client, char[] steamId, int steamIdLen)
{
    return GetClientAuthId(client, AuthId_SteamID64, steamId, steamIdLen, true);
}

bool IsCompetitiveTeam(int team)
{
    return team == TEAM_T || team == TEAM_CT;
}

int GetLogicalTeamLabelByGameTeam(int team)
{
    return (team == gLogicalTeam1GameTeam) ? 1 : 2;
}

const char[] SideLabel(int team)
{
    return (team == TEAM_T) ? "T" : "CT";
}

int TeamDiffAbs(int a, int b)
{
    int diff = a - b;
    if (diff < 0)
    {
        diff = -diff;
    }
    return diff;
}

int GetRoundsToWin()
{
    int maxRounds = 30;
    ConVar cvarMaxRounds = FindConVar("mp_maxrounds");
    if (cvarMaxRounds != null)
    {
        maxRounds = cvarMaxRounds.IntValue;
    }
    return (maxRounds / 2) + 1;
}

void SetRoundsToWin(int roundsToWin)
{
    ConVar cvarMaxRounds = FindConVar("mp_maxrounds");
    if (cvarMaxRounds == null)
    {
        return;
    }

    int targetMaxRounds = (roundsToWin - 1) * 2;
    if (targetMaxRounds < 2)
    {
        targetMaxRounds = 2;
    }
    cvarMaxRounds.IntValue = targetMaxRounds;
}

void RegisterMatchRoster()
{
    if (gMatchRosterTeams == null)
    {
        gMatchRosterTeams = new StringMap();
    }
    else
    {
        delete gMatchRosterTeams;
        gMatchRosterTeams = new StringMap();
    }

    for (int client = 1; client <= MaxClients; client++)
    {
        if (!IsValidHumanClient(client))
        {
            continue;
        }

        int team = GetClientTeam(client);
        if (!IsCompetitiveTeam(team))
        {
            continue;
        }

        char steamId[32];
        if (!GetSteamId64(client, steamId, sizeof(steamId)))
        {
            continue;
        }
        gMatchRosterTeams.SetValue(steamId, team, true);
    }
}

bool IsRosterPlayerBySteam(const char[] steamId)
{
    if (gMatchRosterTeams == null)
    {
        return false;
    }
    int team = 0;
    return gMatchRosterTeams.GetValue(steamId, team);
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

        KickClient(client, "FragHub reconnect slot restored");
        return;
    }
}

public void OnClientPostAdminCheck(int client)
{
    if (!IsPluginEnabled() || !IsValidHumanClient(client) || !gLiveStarted)
    {
        return;
    }

    char steamId[32];
    if (!GetSteamId64(client, steamId, sizeof(steamId)))
    {
        return;
    }

    int rosterTeam = 0;
    if (!gMatchRosterTeams.GetValue(steamId, rosterTeam))
    {
        CS_SwitchTeam(client, 1);
        ChatWarnClient(client, "This match is restricted to registered players.");
        return;
    }

    int reconnectTeam = 0;
    if (gReconnectTeams.GetValue(steamId, reconnectTeam))
    {
        CS_SwitchTeam(client, reconnectTeam);
        CS_RespawnPlayer(client);
        KickOneBotOnTeam(reconnectTeam);
        gReconnectTeams.Remove(steamId);
        gReconnectDeadline.Remove(steamId);
        ChatInfoAll("Player reconnected to the match.");
    }
}

void StripToKnife(int client)
{
    int weapon = -1;
    for (int slot = 0; slot <= 4; slot++)
    {
        weapon = GetPlayerWeaponSlot(client, slot);
        if (weapon != -1)
        {
            RemovePlayerItem(client, weapon);
            RemoveEdict(weapon);
        }
    }

    GivePlayerItem(client, "weapon_knife");
}

public Action Timer_BeginKnifeRound(Handle timer, any data)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Stop;
    }

    if (gCvarKnifeRoundEnabled.BoolValue)
    {
        gKnifeRoundActive = true;
        gAwaitingKnifeChoice = false;
        gLiveStarted = false;

        ChatCommandAll("!knife");
        ChatCommandAll("!knife");
        ChatCommandAll("!knife");
        ChatInfoAll("Knife round starting.");
        ChatInfoAll("Winner chooses starting side.");
    }
    else
    {
        StartLiveMatch();
    }

    return Plugin_Stop;
}

public Action Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled() || !gKnifeRoundActive)
    {
        return Plugin_Continue;
    }

    int client = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(client))
    {
        return Plugin_Continue;
    }

    CreateTimer(0.1, Timer_ApplyKnifeLoadout, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
    return Plugin_Continue;
}

public Action Timer_ApplyKnifeLoadout(Handle timer, any userId)
{
    int client = GetClientOfUserId(userId);
    if (!IsValidHumanClient(client) || !gKnifeRoundActive)
    {
        return Plugin_Stop;
    }
    StripToKnife(client);
    return Plugin_Stop;
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    if (gKnifeRoundActive)
    {
        for (int client = 1; client <= MaxClients; client++)
        {
            if (IsValidHumanClient(client) && IsCompetitiveTeam(GetClientTeam(client)))
            {
                StripToKnife(client);
            }
        }
    }

    return Plugin_Continue;
}

public Action Event_RoundEnd(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    int winner = event.GetInt("winner");
    if (gKnifeRoundActive)
    {
        if (!IsCompetitiveTeam(winner))
        {
            ChatWarnAll("Knife round ended without a winner. Replaying knife round.");
            CreateTimer(3.0, Timer_BeginKnifeRound, _, TIMER_FLAG_NO_MAPCHANGE);
            return Plugin_Continue;
        }

        gKnifeRoundActive = false;
        gAwaitingKnifeChoice = true;
        gKnifeWinnerGameTeam = winner;

        int logicalWinner = GetLogicalTeamLabelByGameTeam(winner);
        ChatInfoAll("Knife round winner: Team %d", logicalWinner);
        ChatCommandAll("Type !stay to keep sides or !switch to swap sides.");
        return Plugin_Continue;
    }

    if (gLiveStarted)
    {
        gRoundsPlayed++;
        int halftimeRound = 15;
        if (!gHalftimeAnnounced && halftimeRound > 0 && gRoundsPlayed >= halftimeRound)
        {
            gHalftimeAnnounced = true;
            int tmp = gLogicalTeam1GameTeam;
            gLogicalTeam1GameTeam = gLogicalTeam2GameTeam;
            gLogicalTeam2GameTeam = tmp;

            ChatInfoAll("Sides have been switched.");
            ChatInfoAll("Team 1 now plays %s.", SideLabel(gLogicalTeam1GameTeam));
            ChatInfoAll("Team 2 now plays %s.", SideLabel(gLogicalTeam2GameTeam));
        }

        if (gCvarOvertimeWinByTwo.BoolValue)
        {
            int tScore = CS_GetTeamScore(TEAM_T);
            int ctScore = CS_GetTeamScore(TEAM_CT);
            int roundsToWin = GetRoundsToWin();

            if (!gOvertimeActive && tScore == 15 && ctScore == 15)
            {
                gOvertimeActive = true;
                gOvertimeRoundsPlayed = 0;
                ChatInfoAll("Overtime started.");
                ChatInfoAll("First team to lead by 2 rounds wins.");
            }

            if (gOvertimeActive)
            {
                gOvertimeRoundsPlayed++;

                int minScore = (tScore < ctScore) ? tScore : ctScore;
                int targetRoundsToWin = minScore + 2;
                if (targetRoundsToWin > roundsToWin)
                {
                    SetRoundsToWin(targetRoundsToWin);
                }

                int diff = TeamDiffAbs(tScore, ctScore);
                if (diff >= 2 && (tScore >= targetRoundsToWin || ctScore >= targetRoundsToWin))
                {
                    ChatInfoAll("Overtime finished: win by 2 condition reached.");
                }
                else if (gOvertimeRoundsPlayed % 6 == 0)
                {
                    ServerCommand("mp_swapteams");
                    int tmp = gLogicalTeam1GameTeam;
                    gLogicalTeam1GameTeam = gLogicalTeam2GameTeam;
                    gLogicalTeam2GameTeam = tmp;
                    ChatInfoAll("Overtime sides swapped.");
                    ChatInfoAll("Team 1 now plays %s.", SideLabel(gLogicalTeam1GameTeam));
                    ChatInfoAll("Team 2 now plays %s.", SideLabel(gLogicalTeam2GameTeam));
                }
            }
        }
    }

    return Plugin_Continue;
}

public Action Command_SayListener(int client, const char[] command, int argc)
{
    if (!IsPluginEnabled() || !IsValidHumanClient(client))
    {
        return Plugin_Continue;
    }

    char text[192];
    GetCmdArgString(text, sizeof(text));
    StripQuotes(text);
    TrimString(text);

    if (text[0] == '\0')
    {
        return Plugin_Continue;
    }

    if (StrEqual(text, "!stay", false))
    {
        HandleKnifeChoice(client, false);
        return Plugin_Handled;
    }
    if (StrEqual(text, "!switch", false))
    {
        HandleKnifeChoice(client, true);
        return Plugin_Handled;
    }
    if (StrEqual(text, "!pause", false))
    {
        HandlePauseCommand(client, false);
        return Plugin_Handled;
    }
    if (StrEqual(text, "!tech", false))
    {
        HandlePauseCommand(client, true);
        return Plugin_Handled;
    }
    if (StrEqual(text, "!unpause", false))
    {
        HandleUnpauseCommand(client);
        return Plugin_Handled;
    }

    return Plugin_Continue;
}

void HandleKnifeChoice(int client, bool shouldSwitch)
{
    if (!gAwaitingKnifeChoice || !IsCompetitiveTeam(gKnifeWinnerGameTeam))
    {
        ChatWarnClient(client, "Knife choice is not currently available.");
        return;
    }

    int team = GetClientTeam(client);
    if (team != gKnifeWinnerGameTeam)
    {
        ChatWarnClient(client, "Only the knife round winner can choose the side.");
        return;
    }

    int logicalWinner = GetLogicalTeamLabelByGameTeam(gKnifeWinnerGameTeam);
    if (shouldSwitch)
    {
        ServerCommand("mp_swapteams");
        int tmp = gLogicalTeam1GameTeam;
        gLogicalTeam1GameTeam = gLogicalTeam2GameTeam;
        gLogicalTeam2GameTeam = tmp;
        ChatInfoAll("Knife round winner: Team %d", logicalWinner);
        ChatInfoAll("They chose to switch sides.");
    }
    else
    {
        ChatInfoAll("Knife round winner: Team %d", logicalWinner);
        ChatInfoAll("They chose to stay on current sides.");
    }

    gAwaitingKnifeChoice = false;
    StartLiveMatch();
}

void StartLiveMatch()
{
    gLiveStarted = true;
    gRoundsPlayed = 0;
    gHalftimeAnnounced = false;
    gOvertimeActive = false;
    gOvertimeRoundsPlayed = 0;
    SetRoundsToWin(16);
    RegisterMatchRoster();

    ChatInfoAll("Live match is starting.");
    ServerCommand("mp_restartgame 3");
}

public Action Event_PlayerDisconnect(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled() || !gLiveStarted)
    {
        return Plugin_Continue;
    }

    char steamId[32];
    steamId[0] = '\0';
    int userid = event.GetInt("userid");
    int client = GetClientOfUserId(userid);
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

    int rosterTeam = 0;
    if (!gMatchRosterTeams.GetValue(steamId, rosterTeam))
    {
        return Plugin_Continue;
    }

    int reconnectWindowSeconds = gCvarReconnectWindowMinutes.IntValue * 60;
    int deadline = GetTime() + reconnectWindowSeconds;
    gReconnectTeams.SetValue(steamId, rosterTeam, true);
    gReconnectDeadline.SetValue(steamId, deadline, true);

    ChatWarnAll("Player disconnected. Waiting for reconnect.");

    DataPack pack = new DataPack();
    pack.WriteString(steamId);
    pack.WriteCell(rosterTeam);
    CreateDataTimer(float(reconnectWindowSeconds), Timer_ReconnectWindowExpired, pack, TIMER_FLAG_NO_MAPCHANGE);
    return Plugin_Continue;
}

public Action Timer_ReconnectWindowExpired(Handle timer, DataPack pack)
{
    pack.Reset();
    char steamId[32];
    steamId[0] = '\0';
    pack.ReadString(steamId, sizeof(steamId));
    int team = pack.ReadCell();
    delete pack;

    if (!gLiveStarted)
    {
        return Plugin_Stop;
    }

    int reconnectTeam = 0;
    if (!gReconnectTeams.GetValue(steamId, reconnectTeam))
    {
        return Plugin_Stop;
    }

    int deadline = 0;
    gReconnectDeadline.GetValue(steamId, deadline);
    if (GetTime() < deadline)
    {
        return Plugin_Stop;
    }

    gReconnectTeams.Remove(steamId);
    gReconnectDeadline.Remove(steamId);

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
        ChatWarnAll("Player failed to reconnect. Bot assigned temporarily.");
    }

    return Plugin_Stop;
}

void HandlePauseCommand(int client, bool isTech)
{
    if (!gLiveStarted || gKnifeRoundActive || gAwaitingKnifeChoice)
    {
        ChatWarnClient(client, "Pause is only available during the live match.");
        return;
    }

    int team = GetClientTeam(client);
    if (!IsCompetitiveTeam(team))
    {
        ChatWarnClient(client, "Only active team players can use pause commands.");
        return;
    }

    if (gPauseActive)
    {
        ChatWarnClient(client, "Match is already paused.");
        return;
    }

    float now = GetEngineTime();
    if (gTeamPauseCooldownUntil[team] > now)
    {
        int remaining = RoundToCeil(gTeamPauseCooldownUntil[team] - now);
        ChatWarnClient(client, "Pause cooldown active. Try again in %d seconds.", remaining);
        return;
    }

    if (isTech)
    {
        if (gTeamTechTimeouts[team] >= gCvarMaxTechTimeouts.IntValue)
        {
            ChatWarnClient(client, "Technical timeout limit reached.");
            return;
        }
        gTeamTechTimeouts[team]++;
    }
    else
    {
        if (gTeamPauses[team] >= gCvarMaxPausesPerTeam.IntValue)
        {
            ChatWarnClient(client, "Pause limit reached.");
            return;
        }
        gTeamPauses[team]++;
    }

    gTeamPauseCooldownUntil[team] = now + gCvarPauseCooldown.FloatValue;
    BeginPause(team, isTech);
}

void BeginPause(int team, bool isTech)
{
    gPauseActive = true;
    gPauseIsTech = isTech;
    gPauseOwnerGameTeam = team;

    if (gPauseEndTimer != INVALID_HANDLE)
    {
        KillTimer(gPauseEndTimer);
        gPauseEndTimer = INVALID_HANDLE;
    }
    if (gUnpauseCountdownTimer != INVALID_HANDLE)
    {
        KillTimer(gUnpauseCountdownTimer);
        gUnpauseCountdownTimer = INVALID_HANDLE;
    }

    if (isTech)
    {
        ChatWarnAll("Technical timeout called.");
        ChatWarnAll("Reason: Player disconnected.");
    }
    else
    {
        ChatWarnAll("Match paused by Team %d.", GetLogicalTeamLabelByGameTeam(team));
    }

    ServerCommand("mp_pause_match");

    float duration = isTech ? gCvarTechTimeoutDuration.FloatValue : gCvarPauseDuration.FloatValue;
    gPauseEndTimer = CreateTimer(duration, Timer_PauseExpired, _, TIMER_FLAG_NO_MAPCHANGE);
}

void HandleUnpauseCommand(int client)
{
    if (!gPauseActive)
    {
        ChatWarnClient(client, "Match is not paused.");
        return;
    }

    int team = GetClientTeam(client);
    if (!IsCompetitiveTeam(team))
    {
        ChatWarnClient(client, "Only active team players can unpause.");
        return;
    }

    if (gUnpauseCountdownTimer != INVALID_HANDLE)
    {
        ChatWarnClient(client, "Unpause countdown already in progress.");
        return;
    }

    gUnpauseCountdownSeconds = 5;
    ChatInfoAll("Match will resume in 5 seconds.");
    gUnpauseCountdownTimer = CreateTimer(1.0, Timer_UnpauseCountdown, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_UnpauseCountdown(Handle timer, any data)
{
    if (!gPauseActive)
    {
        gUnpauseCountdownTimer = INVALID_HANDLE;
        return Plugin_Stop;
    }

    gUnpauseCountdownSeconds--;
    if (gUnpauseCountdownSeconds <= 0)
    {
        ResumeMatch();
        return Plugin_Stop;
    }

    ChatInfoAll("Match will resume in %d seconds.", gUnpauseCountdownSeconds);
    return Plugin_Continue;
}

public Action Timer_PauseExpired(Handle timer, any data)
{
    gPauseEndTimer = INVALID_HANDLE;
    if (!gPauseActive)
    {
        return Plugin_Stop;
    }

    if (gPauseIsTech)
    {
        ChatWarnAll("Technical timeout ended. Match resumes now.");
    }
    else
    {
        ChatWarnAll("Pause time expired. Match resumes now.");
    }
    ResumeMatch();
    return Plugin_Stop;
}

void ResumeMatch()
{
    if (!gPauseActive)
    {
        return;
    }

    if (gPauseEndTimer != INVALID_HANDLE)
    {
        KillTimer(gPauseEndTimer);
        gPauseEndTimer = INVALID_HANDLE;
    }
    if (gUnpauseCountdownTimer != INVALID_HANDLE)
    {
        KillTimer(gUnpauseCountdownTimer);
        gUnpauseCountdownTimer = INVALID_HANDLE;
    }

    gPauseActive = false;
    gPauseIsTech = false;
    gPauseOwnerGameTeam = 0;
    gUnpauseCountdownSeconds = 0;

    ServerCommand("mp_unpause_match");
    ChatInfoAll("Match resumed.");
}
