#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>

public Plugin myinfo =
{
    name = "Ranked Banner",
    author = "csgofaceit",
    description = "Shows configurable ranked ladder banner messages.",
    version = "1.0.0",
    url = "https://play.maro.run"
};

ConVar gCvarEnabled;
ConVar gCvarPrefix;
ConVar gCvarRoundStartMessage;
ConVar gCvarPlayerJoinMessage;
ConVar gCvarKillMessage;

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_ranked_banner_enabled",
        "1",
        "Enable ranked banner messages.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    gCvarPrefix = CreateConVar(
        "sm_ranked_banner_prefix",
        "[play.maro.run]",
        "Prefix used for banner messages.",
        FCVAR_NOTIFY
    );

    gCvarRoundStartMessage = CreateConVar(
        "sm_ranked_banner_round_start",
        "Playing ranked on play.maro.run",
        "Message sent at round start.",
        FCVAR_NOTIFY
    );

    gCvarPlayerJoinMessage = CreateConVar(
        "sm_ranked_banner_player_join",
        "Match hosted by play.maro.run",
        "Message sent when a player joins.",
        FCVAR_NOTIFY
    );

    gCvarKillMessage = CreateConVar(
        "sm_ranked_banner_kill",
        "This match is part of the ranked ladder",
        "Message sent on kill events.",
        FCVAR_NOTIFY
    );

    AutoExecConfig(true, "ranked_banner");

    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
    HookEvent("player_death", Event_PlayerDeath, EventHookMode_Post);
}

public void OnClientPutInServer(int client)
{
    if (!IsPluginEnabled() || !IsValidHumanClient(client))
    {
        return;
    }

    PrintBannerToClient(client, gCvarPlayerJoinMessage);
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    PrintBannerToAll(gCvarRoundStartMessage);
    return Plugin_Continue;
}

public Action Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsPluginEnabled())
    {
        return Plugin_Continue;
    }

    int attackerUserId = event.GetInt("attacker");
    int attacker = GetClientOfUserId(attackerUserId);
    if (!IsValidHumanClient(attacker))
    {
        return Plugin_Continue;
    }

    PrintBannerToClient(attacker, gCvarKillMessage);
    return Plugin_Continue;
}

bool IsPluginEnabled()
{
    return gCvarEnabled != null && gCvarEnabled.BoolValue;
}

bool IsValidHumanClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

void PrintBannerToAll(ConVar messageCvar)
{
    char prefix[128];
    char message[192];
    gCvarPrefix.GetString(prefix, sizeof(prefix));
    messageCvar.GetString(message, sizeof(message));

    PrintToChatAll("%s %s", prefix, message);
}

void PrintBannerToClient(int client, ConVar messageCvar)
{
    char prefix[128];
    char message[192];
    gCvarPrefix.GetString(prefix, sizeof(prefix));
    messageCvar.GetString(message, sizeof(message));

    PrintToChat(client, "%s %s", prefix, message);
}
