#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <cstrike>

public Plugin myinfo =
{
    name = "Gun Game Mode",
    author = "csgofaceit",
    description = "Unranked Gun Game progression mode.",
    version = "1.0.0",
    url = "https://play.maro.run"
};

ConVar gCvarEnabled;

char gWeaponOrder[][] =
{
    "weapon_glock",
    "weapon_hkp2000",
    "weapon_mp9",
    "weapon_ump45",
    "weapon_ak47",
    "weapon_awp",
    "weapon_knife"
};

char gWeaponLabel[][] =
{
    "Glock",
    "USP",
    "MP9",
    "UMP45",
    "AK47",
    "AWP",
    "Knife"
};

int gPlayerLevel[MAXPLAYERS + 1];

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_gungame_enabled",
        "0",
        "Enable Gun Game mode.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );

    AutoExecConfig(true, "gun_game_mode");

    HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
    HookEvent("player_death", Event_PlayerDeath, EventHookMode_Post);
    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);

    for (int i = 1; i <= MaxClients; i++)
    {
        gPlayerLevel[i] = 0;
    }
}

public void OnClientPutInServer(int client)
{
    gPlayerLevel[client] = 0;
}

public void OnClientDisconnect(int client)
{
    gPlayerLevel[client] = 0;
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    PrintToChatAll("[GunGame] Mode active (Unranked). Get kills to progress weapons.");
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

    EquipLevelWeapon(client);
    return Plugin_Continue;
}

public Action Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    int attacker = GetClientOfUserId(event.GetInt("attacker"));
    int victim = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(attacker) || attacker == victim)
    {
        return Plugin_Continue;
    }
    if (!IsPlayerAlive(attacker))
    {
        return Plugin_Continue;
    }
    if (GetClientTeam(attacker) == GetClientTeam(victim))
    {
        return Plugin_Continue;
    }

    int level = gPlayerLevel[attacker];
    int finalLevel = sizeof(gWeaponOrder) - 1;

    if (level >= finalLevel)
    {
        PrintToChatAll("[GunGame] %N wins Gun Game!", attacker);
        CS_TerminateRound(3.0, CSRoundEnd_Draw);
        ResetAllLevels();
        return Plugin_Continue;
    }

    gPlayerLevel[attacker] = level + 1;
    int newLevel = gPlayerLevel[attacker];
    PrintToChat(attacker, "[GunGame] Level up! New weapon: %s", gWeaponLabel[newLevel]);

    EquipLevelWeapon(attacker);
    return Plugin_Continue;
}

void EquipLevelWeapon(int client)
{
    int level = gPlayerLevel[client];
    if (level < 0) level = 0;
    if (level >= sizeof(gWeaponOrder)) level = sizeof(gWeaponOrder) - 1;

    StripWeapons(client);
    GivePlayerItem(client, gWeaponOrder[level]);
    if (level != sizeof(gWeaponOrder) - 1)
    {
        GivePlayerItem(client, "weapon_knife");
    }
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

void ResetAllLevels()
{
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i))
        {
            continue;
        }
        gPlayerLevel[i] = 0;
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
