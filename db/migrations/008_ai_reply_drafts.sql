ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_reply_draft text,
  ADD COLUMN IF NOT EXISTS ai_draft_goal text,
  ADD COLUMN IF NOT EXISTS ai_draft_needs_user_edit boolean;

ALTER TABLE outreach_conversations
  ADD COLUMN IF NOT EXISTS ai_reply_draft text,
  ADD COLUMN IF NOT EXISTS ai_draft_goal text,
  ADD COLUMN IF NOT EXISTS ai_draft_needs_user_edit boolean;
