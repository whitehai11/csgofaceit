ALTER TABLE users
  ADD COLUMN IF NOT EXISTS selected_tag_type TEXT NOT NULL DEFAULT 'none'
  CHECK (selected_tag_type IN ('dev', 'admin', 'mod', 'clan', 'none'));
