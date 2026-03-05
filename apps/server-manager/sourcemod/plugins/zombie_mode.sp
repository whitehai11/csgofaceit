#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <cstrike>

public Plugin myinfo =
{
    name = "Zombie Mode",
    author = "csgofaceit",
    description = "Humans vs Zombies infection mode (unranked).",
    version = "1.0.0",
    url = "https://play.maro.run"
};

ConVar gCvarEnabled;
ConVar gCvarZombieHealth;
ConVar gCvarZombieSpeed;

bool gIsZombie[MAXPLAYERS + 1];
bool gRoundActive = false;

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_zombie_enabled",
        "0",
        "Enable Zombie mode.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );
    gCvarZombieHealth = CreateConVar(
        "sm_zombie_health",
        "250",
        "Zombie health value.",
        FCVAR_NOTIFY,
        true,
        100.0,
        true,
        5000.0
    );
    gCvarZombieSpeed = CreateConVar(
        "sm_zombie_speed",
        "1.30",
        "Zombie movement speed multiplier.",
        FCVAR_NOTIFY,
        true,
        1.0,
        true,
        3.0
    );

    AutoExecConfig(true, "zombie_mode");

    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
    HookEvent("round_end", Event_RoundEnd, EventHookMode_PostNoCopy);
    HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
    HookEvent("player_death", Event_PlayerDeath, EventHookMode_Post);

    ResetModeState();
}

public void OnClientPutInServer(int client)
{
    gIsZombie[client] = false;
}

public void OnClientDisconnect(int client)
{
    gIsZombie[client] = false;
    CheckWinConditions();
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        gRoundActive = false;
        return Plugin_Continue;
    }

    gRoundActive = true;
    for (int i = 1; i <= MaxClients; i++)
    {
        gIsZombie[i] = false;
    }

    int firstZombie = PickRandomHuman();
    if (firstZombie <= 0)
    {
        PrintToChatAll("[Zombie] Waiting for more players.");
        return Plugin_Continue;
    }

    gIsZombie[firstZombie] = true;
    PrintToChatAll("[Zombie] %N is the first zombie! Survive to win.", firstZombie);

    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i) || !IsPlayerAlive(i))
        {
            continue;
        }
        ApplyPlayerRole(i);
    }
    return Plugin_Continue;
}

public Action Event_RoundEnd(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    gRoundActive = false;
    int humans = CountHumans(false);
    if (humans > 0)
    {
        PrintToChatAll("[Zombie] Humans survived the round.");
    }
    return Plugin_Continue;
}

public Action Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    int client = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(client) || !IsPlayerAlive(client))
    {
        return Plugin_Continue;
    }

    ApplyPlayerRole(client);
    return Plugin_Continue;
}

public Action Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled() || !gRoundActive)
    {
        return Plugin_Continue;
    }

    int attacker = GetClientOfUserId(event.GetInt("attacker"));
    int victim = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(attacker) || !IsValidHumanClient(victim) || attacker == victim)
    {
        CheckWinConditions();
        return Plugin_Continue;
    }

    if (gIsZombie[attacker] && !gIsZombie[victim])
    {
        gIsZombie[victim] = true;
        PrintToChatAll("[Zombie] %N infected %N.", attacker, victim);
        CreateTimer(0.3, Timer_RespawnAsZombie, GetClientUserId(victim), TIMER_FLAG_NO_MAPCHANGE);
    }

    CheckWinConditions();
    return Plugin_Continue;
}

public Action Timer_RespawnAsZombie(Handle timer, any userid)
{
    if (!IsModeEnabled() || !gRoundActive)
    {
        return Plugin_Stop;
    }

    int client = GetClientOfUserId(userid);
    if (!IsValidHumanClient(client) || IsPlayerAlive(client))
    {
        return Plugin_Stop;
    }

    CS_RespawnPlayer(client);
    if (IsPlayerAlive(client))
    {
        ApplyPlayerRole(client);
    }
    return Plugin_Stop;
}

void ApplyPlayerRole(int client)
{
    if (gIsZombie[client])
    {
        StripWeapons(client);
        GivePlayerItem(client, "weapon_knife");
        SetEntityHealth(client, gCvarZombieHealth.IntValue);
        SetEntPropFloat(client, Prop_Send, "m_flLaggedMovementValue", gCvarZombieSpeed.FloatValue);
        PrintCenterText(client, "You are a ZOMBIE. Infect humans!");
        return;
    }

    SetEntPropFloat(client, Prop_Send, "m_flLaggedMovementValue", 1.0);
    PrintCenterText(client, "You are HUMAN. Survive the round!");
}

void StripWeapons(int client)
{
    int weapon = -1;
    for (int slot = 0; slot < 6; slot++)
    {
        weapon = GetPlayerWeaponSlot(client, slot);
        if (weapon > MaxClients && IsValidEntity(weapon))
        {
            RemovePlayerItem(client, weapon);
            AcceptEntityInput(weapon, "Kill");
        }
    }
}

void CheckWinConditions()
{
    if (!IsModeEnabled() || !gRoundActive)
    {
        return;
    }

    int humansAlive = CountHumans(true);
    int zombiesAlive = CountZombies(true);

    if (humansAlive <= 0 && zombiesAlive > 0)
    {
        PrintToChatAll("[Zombie] Zombies infected everyone.");
        gRoundActive = false;
        CS_TerminateRound(3.0, CSRoundEnd_TerroristWin);
        return;
    }

    if (zombiesAlive <= 0 && humansAlive > 0)
    {
        PrintToChatAll("[Zombie] Humans eliminated all zombies.");
        gRoundActive = false;
        CS_TerminateRound(3.0, CSRoundEnd_CTWin);
    }
}

int PickRandomHuman()
{
    int candidates[MAXPLAYERS + 1];
    int count = 0;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i) || !IsPlayerAlive(i))
        {
            continue;
        }
        candidates[count++] = i;
    }
    if (count <= 0)
    {
        return 0;
    }
    return candidates[GetRandomInt(0, count - 1)];
}

int CountHumans(bool aliveOnly)
{
    int count = 0;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i))
        {
            continue;
        }
        if (aliveOnly && !IsPlayerAlive(i))
        {
            continue;
        }
        if (!gIsZombie[i])
        {
            count++;
        }
    }
    return count;
}

int CountZombies(bool aliveOnly)
{
    int count = 0;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i))
        {
            continue;
        }
        if (aliveOnly && !IsPlayerAlive(i))
        {
            continue;
        }
        if (gIsZombie[i])
        {
            count++;
        }
    }
    return count;
}

void ResetModeState()
{
    gRoundActive = false;
    for (int i = 1; i <= MaxClients; i++)
    {
        gIsZombie[i] = false;
    }
}

bool IsModeEnabled()
{
    return gCvarEnabled != null && gCvarEnabled.BoolValue;
}

bool IsValidHumanClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}
