ALTER TABLE personalization_pilots
  DROP CONSTRAINT IF EXISTS personalization_pilots_requested_limit_check;

ALTER TABLE personalization_pilots
  ADD CONSTRAINT personalization_pilots_requested_limit_check
  CHECK (requested_limit BETWEEN 1 AND 1000);
