#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <sdkhooks>

public Plugin myinfo =
{
    name = "Superpower Mode",
    author = "csgofaceit",
    description = "Unranked mode with rotating round abilities.",
    version = "1.0.0",
    url = "https://play.maro.run"
};

enum Superpower
{
    SP_NONE = 0,
    SP_DOUBLE_JUMP,
    SP_SPEED_BOOST,
    SP_LOW_GRAVITY,
    SP_INFINITE_AMMO,
    SP_HEALTH_REGEN,
    SP_TELEPORT,
    SP_WALL_PING
};

ConVar gCvarEnabled;
ConVar gCvarTeleportCooldown;
ConVar gCvarRegenPerTick;
ConVar gCvarRegenTickSeconds;

Superpower gPlayerPower[MAXPLAYERS + 1];
bool gDoubleJumpUsed[MAXPLAYERS + 1];
bool gJumpHeld[MAXPLAYERS + 1];
float gNextTeleportAt[MAXPLAYERS + 1];
Handle gRegenTimer = null;
Handle gWallPingTimer = null;

public void OnPluginStart()
{
    gCvarEnabled = CreateConVar(
        "sm_superpower_enabled",
        "1",
        "Enable Superpower Mode abilities.",
        FCVAR_NOTIFY,
        true,
        0.0,
        true,
        1.0
    );
    gCvarTeleportCooldown = CreateConVar("sm_superpower_teleport_cooldown", "15.0", "Teleport cooldown in seconds.", FCVAR_NOTIFY);
    gCvarRegenPerTick = CreateConVar("sm_superpower_regen_per_tick", "5", "HP regenerated per tick.", FCVAR_NOTIFY);
    gCvarRegenTickSeconds = CreateConVar("sm_superpower_regen_tick_seconds", "1.0", "Health regen interval in seconds.", FCVAR_NOTIFY);

    AutoExecConfig(true, "superpower_mode");

    HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
    HookEvent("player_spawn", Event_PlayerSpawn, EventHookMode_Post);
    HookEvent("weapon_fire", Event_WeaponFire, EventHookMode_Post);

    for (int i = 1; i <= MaxClients; i++)
    {
        ResetPlayerState(i);
    }
}

public void OnMapStart()
{
    RestartAbilityTimers();
}

public void OnClientDisconnect(int client)
{
    ResetPlayerState(client);
}

public Action Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i))
        {
            continue;
        }
        AssignRandomPower(i);
        gDoubleJumpUsed[i] = false;
        gJumpHeld[i] = false;
        PrintToChat(i, "[Superpower] Superpower: %s", PowerDisplayName(gPlayerPower[i]));
    }

    RestartAbilityTimers();
    return Plugin_Continue;
}

public Action Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    int client = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(client))
    {
        return Plugin_Continue;
    }

    gDoubleJumpUsed[client] = false;
    ApplyPassivePower(client);
    return Plugin_Continue;
}

public Action Event_WeaponFire(Event event, const char[] name, bool dontBroadcast)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    int client = GetClientOfUserId(event.GetInt("userid"));
    if (!IsValidHumanClient(client) || gPlayerPower[client] != SP_INFINITE_AMMO)
    {
        return Plugin_Continue;
    }

    int weapon = GetEntPropEnt(client, Prop_Send, "m_hActiveWeapon");
    if (weapon > MaxClients && IsValidEntity(weapon))
    {
        SetEntProp(weapon, Prop_Send, "m_iClip1", 200);
    }
    return Plugin_Continue;
}

public Action OnPlayerRunCmd(
    int client,
    int &buttons,
    int &impulse,
    float vel[3],
    float angles[3],
    int &weapon,
    int &subtype,
    int &cmdnum,
    int &tickcount,
    int &seed,
    int mouse[2]
)
{
    if (!IsModeEnabled() || !IsValidHumanClient(client))
    {
        return Plugin_Continue;
    }

    if (gPlayerPower[client] == SP_DOUBLE_JUMP)
    {
        HandleDoubleJump(client, buttons);
    }

    if (gPlayerPower[client] == SP_TELEPORT)
    {
        HandleTeleport(client, buttons);
    }

    return Plugin_Continue;
}

void HandleDoubleJump(int client, int buttons)
{
    bool onGround = (GetEntityFlags(client) & FL_ONGROUND) != 0;
    bool pressingJump = (buttons & IN_JUMP) != 0;

    if (onGround)
    {
        gDoubleJumpUsed[client] = false;
    }

    if (pressingJump && !gJumpHeld[client] && !onGround && !gDoubleJumpUsed[client])
    {
        float v[3];
        GetEntPropVector(client, Prop_Data, "m_vecVelocity", v);
        v[2] = 320.0;
        TeleportEntity(client, NULL_VECTOR, NULL_VECTOR, v);
        gDoubleJumpUsed[client] = true;
    }

    gJumpHeld[client] = pressingJump;
}

void HandleTeleport(int client, int buttons)
{
    bool pressingUse = (buttons & IN_USE) != 0;
    bool pressingReload = (buttons & IN_RELOAD) != 0;
    if (!pressingUse || !pressingReload)
    {
        return;
    }

    float now = GetGameTime();
    if (now < gNextTeleportAt[client])
    {
        return;
    }
    gNextTeleportAt[client] = now + gCvarTeleportCooldown.FloatValue;

    float eye[3];
    float ang[3];
    float fwd[3];
    float dest[3];
    GetClientEyePosition(client, eye);
    GetClientEyeAngles(client, ang);
    GetAngleVectors(ang, fwd, NULL_VECTOR, NULL_VECTOR);

    dest[0] = eye[0] + (fwd[0] * 450.0);
    dest[1] = eye[1] + (fwd[1] * 450.0);
    dest[2] = eye[2] + (fwd[2] * 20.0);

    TeleportEntity(client, dest, NULL_VECTOR, NULL_VECTOR);
    PrintCenterText(client, "Superpower: Teleport!");
}

void ApplyPassivePower(int client)
{
    SetEntityGravity(client, 1.0);
    SetEntPropFloat(client, Prop_Send, "m_flLaggedMovementValue", 1.0);

    if (gPlayerPower[client] == SP_SPEED_BOOST)
    {
        SetEntPropFloat(client, Prop_Send, "m_flLaggedMovementValue", 1.35);
    }
    else if (gPlayerPower[client] == SP_LOW_GRAVITY)
    {
        SetEntityGravity(client, 0.55);
    }
}

void RestartAbilityTimers()
{
    if (gRegenTimer != null)
    {
        CloseHandle(gRegenTimer);
        gRegenTimer = null;
    }
    if (gWallPingTimer != null)
    {
        CloseHandle(gWallPingTimer);
        gWallPingTimer = null;
    }

    if (!IsModeEnabled())
    {
        return;
    }

    gRegenTimer = CreateTimer(gCvarRegenTickSeconds.FloatValue, Timer_HealthRegen, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
    gWallPingTimer = CreateTimer(8.0, Timer_WallPing, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_HealthRegen(Handle timer)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    int addHp = gCvarRegenPerTick.IntValue;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i) || !IsPlayerAlive(i))
        {
            continue;
        }
        if (gPlayerPower[i] != SP_HEALTH_REGEN)
        {
            continue;
        }

        int hp = GetClientHealth(i);
        if (hp < 100)
        {
            SetEntityHealth(i, hp + addHp > 100 ? 100 : hp + addHp);
        }
    }
    return Plugin_Continue;
}

public Action Timer_WallPing(Handle timer)
{
    if (!IsModeEnabled())
    {
        return Plugin_Continue;
    }

    for (int client = 1; client <= MaxClients; client++)
    {
        if (!IsValidHumanClient(client) || !IsPlayerAlive(client))
        {
            continue;
        }
        if (gPlayerPower[client] != SP_WALL_PING)
        {
            continue;
        }

        int target = FindNearestEnemy(client);
        if (target <= 0)
        {
            continue;
        }

        float from[3];
        float to[3];
        GetClientAbsOrigin(client, from);
        GetClientAbsOrigin(target, to);
        float dist = GetVectorDistance(from, to);
        PrintToChat(client, "[Superpower] Wall Ping: enemy spotted at %.0f units.", dist);
    }
    return Plugin_Continue;
}

int FindNearestEnemy(int client)
{
    int myTeam = GetClientTeam(client);
    float myPos[3];
    GetClientAbsOrigin(client, myPos);

    int nearest = 0;
    float best = 9999999.0;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsValidHumanClient(i) || !IsPlayerAlive(i))
        {
            continue;
        }
        if (GetClientTeam(i) == myTeam)
        {
            continue;
        }

        float pos[3];
        GetClientAbsOrigin(i, pos);
        float d = GetVectorDistance(myPos, pos);
        if (d < best)
        {
            best = d;
            nearest = i;
        }
    }

    return nearest;
}

void AssignRandomPower(int client)
{
    gPlayerPower[client] = view_as<Superpower>(GetRandomInt(1, 7));
}

const char[] PowerDisplayName(Superpower power)
{
    switch (power)
    {
        case SP_DOUBLE_JUMP: return "Double Jump";
        case SP_SPEED_BOOST: return "Speed Boost";
        case SP_LOW_GRAVITY: return "Low Gravity";
        case SP_INFINITE_AMMO: return "Infinite Ammo";
        case SP_HEALTH_REGEN: return "Health Regeneration";
        case SP_TELEPORT: return "Teleport";
        case SP_WALL_PING: return "Wall Ping";
    }
    return "None";
}

bool IsModeEnabled()
{
    return gCvarEnabled != null && gCvarEnabled.BoolValue;
}

bool IsValidHumanClient(int client)
{
    return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

void ResetPlayerState(int client)
{
    if (client < 1 || client > MaxClients)
    {
        return;
    }
    gPlayerPower[client] = SP_NONE;
    gDoubleJumpUsed[client] = false;
    gJumpHeld[client] = false;
    gNextTeleportAt[client] = 0.0;
}
