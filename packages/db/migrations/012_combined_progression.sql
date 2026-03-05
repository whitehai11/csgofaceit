ALTER TABLE players
  ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS level INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS trust_score INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS commendations_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accurate_reports_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS toxic_reports_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_cheating_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS progression_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'match_result',
    'commendation',
    'accurate_report',
    'toxic_report',
    'confirmed_cheating'
  )),
  mmr_delta INTEGER NOT NULL DEFAULT 0,
  xp_delta INTEGER NOT NULL DEFAULT 0,
  trust_delta INTEGER NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_progression_events_player_created
  ON progression_events (player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS level_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level_required INTEGER NOT NULL UNIQUE CHECK (level_required > 0),
  reward_code TEXT NOT NULL UNIQUE,
  reward_name TEXT NOT NULL,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('basic_skins', 'rare_skins', 'knife_skins', 'gloves', 'exclusive_skins')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_level_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reward_code TEXT NOT NULL REFERENCES level_rewards(reward_code) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, reward_code)
);

CREATE INDEX IF NOT EXISTS idx_player_level_rewards_player_unlocked
  ON player_level_rewards (player_id, unlocked_at DESC);

INSERT INTO level_rewards (level_required, reward_code, reward_name, reward_type)
VALUES
  (5, 'lvl_5_basic_skin_pack', 'Level 5 Basic Skin Pack', 'basic_skins'),
  (10, 'lvl_10_rare_skin_pack', 'Level 10 Rare Skin Pack', 'rare_skins'),
  (20, 'lvl_20_knife_skin_pack', 'Level 20 Knife Skin Pack', 'knife_skins'),
  (30, 'lvl_30_gloves_pack', 'Level 30 Gloves Pack', 'gloves'),
  (40, 'lvl_40_exclusive_pack', 'Level 40 Exclusive Pack', 'exclusive_skins')
ON CONFLICT (level_required) DO NOTHING;

CREATE OR REPLACE FUNCTION calculate_level_from_xp(input_xp INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF input_xp <= 0 THEN
    RETURN 1;
  END IF;
  RETURN FLOOR(input_xp / 1000.0)::INTEGER + 1;
END;
$$;

CREATE OR REPLACE FUNCTION apply_match_progression(
  p_player_id UUID,
  p_match_id UUID,
  p_is_win BOOLEAN,
  p_mvps INTEGER DEFAULT 0
)
RETURNS TABLE(
  player_id UUID,
  match_id UUID,
  mmr_before INTEGER,
  mmr_after INTEGER,
  mmr_delta INTEGER,
  rank_before TEXT,
  rank_after TEXT,
  xp_before INTEGER,
  xp_after INTEGER,
  xp_delta INTEGER,
  level_before INTEGER,
  level_after INTEGER,
  unlocked_level_rewards TEXT[]
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_player RECORD;
  v_mmr_delta INTEGER := CASE WHEN p_is_win THEN 25 ELSE -25 END;
  v_xp_delta INTEGER := 100 + (CASE WHEN p_is_win THEN 50 ELSE 0 END) + (GREATEST(COALESCE(p_mvps, 0), 0) * 10);
  v_new_mmr INTEGER;
  v_new_rank TEXT;
  v_new_xp INTEGER;
  v_new_level INTEGER;
BEGIN
  SELECT id, mmr, player_rank, xp, level
  INTO v_player
  FROM players
  WHERE id = p_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not found: %', p_player_id;
  END IF;

  v_new_mmr := GREATEST(0, COALESCE(v_player.mmr, 1000) + v_mmr_delta);
  v_new_rank := calculate_rank_from_mmr(v_new_mmr);
  v_new_xp := GREATEST(0, COALESCE(v_player.xp, 0) + v_xp_delta);
  v_new_level := calculate_level_from_xp(v_new_xp);

  UPDATE players
  SET
    mmr = v_new_mmr,
    elo = v_new_mmr,
    player_rank = v_new_rank,
    xp = v_new_xp,
    level = v_new_level
  WHERE id = p_player_id;

  INSERT INTO player_stats (player_id, wins, losses, matches_played, updated_at)
  VALUES (
    p_player_id,
    CASE WHEN p_is_win THEN 1 ELSE 0 END,
    CASE WHEN p_is_win THEN 0 ELSE 1 END,
    1,
    NOW()
  )
  ON CONFLICT (player_id)
  DO UPDATE SET
    wins = player_stats.wins + EXCLUDED.wins,
    losses = player_stats.losses + EXCLUDED.losses,
    matches_played = player_stats.matches_played + 1,
    updated_at = NOW();

  INSERT INTO rank_history (player_id, match_id, previous_rank, new_rank, mmr_delta)
  VALUES (p_player_id, p_match_id, COALESCE(v_player.player_rank, calculate_rank_from_mmr(COALESCE(v_player.mmr, 1000))), v_new_rank, v_mmr_delta);

  INSERT INTO progression_events (player_id, match_id, event_type, mmr_delta, xp_delta, trust_delta, meta)
  VALUES (
    p_player_id,
    p_match_id,
    'match_result',
    v_mmr_delta,
    v_xp_delta,
    0,
    jsonb_build_object('win', p_is_win, 'mvps', GREATEST(COALESCE(p_mvps, 0), 0))
  );

  INSERT INTO player_level_rewards (player_id, reward_code)
  SELECT p_player_id, lr.reward_code
  FROM level_rewards lr
  WHERE lr.level_required <= v_new_level
  ON CONFLICT (player_id, reward_code) DO NOTHING;

  RETURN QUERY
  SELECT
    p_player_id,
    p_match_id,
    COALESCE(v_player.mmr, 1000),
    v_new_mmr,
    v_mmr_delta,
    COALESCE(v_player.player_rank, calculate_rank_from_mmr(COALESCE(v_player.mmr, 1000))),
    v_new_rank,
    COALESCE(v_player.xp, 0),
    v_new_xp,
    v_xp_delta,
    COALESCE(v_player.level, 1),
    v_new_level,
    COALESCE(
      (
        SELECT array_agg(plr.reward_code ORDER BY plr.unlocked_at DESC)
        FROM player_level_rewards plr
        JOIN level_rewards lr ON lr.reward_code = plr.reward_code
        WHERE plr.player_id = p_player_id
          AND lr.level_required = v_new_level
      ),
      ARRAY[]::TEXT[]
    );
END;
$$;

CREATE OR REPLACE FUNCTION apply_trust_score_event(
  p_player_id UUID,
  p_event_type TEXT,
  p_count INTEGER DEFAULT 1,
  p_match_id UUID DEFAULT NULL
)
RETURNS TABLE(
  player_id UUID,
  event_type TEXT,
  trust_before INTEGER,
  trust_after INTEGER,
  trust_delta INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_player RECORD;
  v_count INTEGER := GREATEST(COALESCE(p_count, 1), 1);
  v_unit_delta INTEGER;
  v_delta INTEGER;
  v_new_trust INTEGER;
BEGIN
  IF p_event_type NOT IN ('commendation', 'accurate_report', 'toxic_report', 'confirmed_cheating') THEN
    RAISE EXCEPTION 'Invalid trust event type: %', p_event_type;
  END IF;

  v_unit_delta := CASE p_event_type
    WHEN 'commendation' THEN 3
    WHEN 'accurate_report' THEN 5
    WHEN 'toxic_report' THEN -15
    WHEN 'confirmed_cheating' THEN -60
  END;
  v_delta := v_unit_delta * v_count;

  SELECT id, trust_score
  INTO v_player
  FROM players
  WHERE id = p_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not found: %', p_player_id;
  END IF;

  v_new_trust := LEAST(1000, GREATEST(0, COALESCE(v_player.trust_score, 100) + v_delta));

  UPDATE players
  SET
    trust_score = v_new_trust,
    commendations_count = commendations_count + CASE WHEN p_event_type = 'commendation' THEN v_count ELSE 0 END,
    accurate_reports_count = accurate_reports_count + CASE WHEN p_event_type = 'accurate_report' THEN v_count ELSE 0 END,
    toxic_reports_count = toxic_reports_count + CASE WHEN p_event_type = 'toxic_report' THEN v_count ELSE 0 END,
    confirmed_cheating_count = confirmed_cheating_count + CASE WHEN p_event_type = 'confirmed_cheating' THEN v_count ELSE 0 END
  WHERE id = p_player_id;

  INSERT INTO progression_events (player_id, match_id, event_type, mmr_delta, xp_delta, trust_delta, meta)
  VALUES (
    p_player_id,
    p_match_id,
    p_event_type,
    0,
    0,
    v_delta,
    jsonb_build_object('count', v_count)
  );

  RETURN QUERY
  SELECT p_player_id, p_event_type, COALESCE(v_player.trust_score, 100), v_new_trust, v_delta;
END;
$$;
