ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS threading_mode text NOT NULL DEFAULT 'new_thread',
  ADD COLUMN IF NOT EXISTS parent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_parent_message_idx ON messages(parent_message_id);
