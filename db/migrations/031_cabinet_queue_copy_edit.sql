-- The migration runner applies this expansion atomically; legacy plans remain valid.
ALTER TABLE cabinet_plans
  DROP CONSTRAINT cabinet_plans_kind_check,
  ADD CONSTRAINT cabinet_plans_kind_check CHECK (kind IN ('launch','stop','queue_edit'));
