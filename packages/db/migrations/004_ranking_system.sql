ALTER TABLE players
  ADD COLUMN IF NOT EXISTS mmr INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS player_rank TEXT NOT NULL DEFAULT 'Gold Nova',
  ADD COLUMN IF NOT EXISTS win_streak INTEGER NOT NULL DEFAULT 0;

UPDATE players
SET mmr = COALESCE(mmr, elo, 1000),
    player_rank = CASE
      WHEN COALESCE(mmr, elo, 1000) < 900 THEN 'Silver'
      WHEN COALESCE(mmr, elo, 1000) < 1100 THEN 'Gold Nova'
      WHEN COALESCE(mmr, elo, 1000) < 1300 THEN 'Master Guardian'
      WHEN COALESCE(mmr, elo, 1000) < 1500 THEN 'Distinguished Master Guardian'
      WHEN COALESCE(mmr, elo, 1000) < 1700 THEN 'Legendary Eagle'
      WHEN COALESCE(mmr, elo, 1000) < 1900 THEN 'Supreme'
      ELSE 'Global Elite'
    END;

CREATE OR REPLACE FUNCTION calculate_rank_from_mmr(input_mmr INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  IF input_mmr < 900 THEN
    RETURN 'Silver';
  ELSIF input_mmr < 1100 THEN
    RETURN 'Gold Nova';
  ELSIF input_mmr < 1300 THEN
    RETURN 'Master Guardian';
  ELSIF input_mmr < 1500 THEN
    RETURN 'Distinguished Master Guardian';
  ELSIF input_mmr < 1700 THEN
    RETURN 'Legendary Eagle';
  ELSIF input_mmr < 1900 THEN
    RETURN 'Supreme';
  ELSE
    RETURN 'Global Elite';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION update_player_rank_from_mmr(player_uuid UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE players
  SET player_rank = calculate_rank_from_mmr(mmr)
  WHERE id = player_uuid;
END;
$$;
