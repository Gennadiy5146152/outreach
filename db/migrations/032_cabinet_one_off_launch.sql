-- Store bounded day/window metadata only on the exact approved jobs.
ALTER TABLE cabinet_plans
  DROP CONSTRAINT cabinet_plans_kind_check,
  ADD CONSTRAINT cabinet_plans_kind_check CHECK (kind IN ('launch','stop','queue_edit','one_off_launch'));

ALTER TABLE cabinet_jobs
  ADD COLUMN one_off_day date,
  ADD COLUMN one_off_window_start time,
  ADD COLUMN one_off_window_end time,
  ADD COLUMN one_off_daily_limit integer,
  ADD CONSTRAINT cabinet_jobs_one_off_check CHECK (
    (one_off_day IS NULL AND one_off_window_start IS NULL AND one_off_window_end IS NULL AND one_off_daily_limit IS NULL)
    OR
    (one_off_day IS NOT NULL AND one_off_window_start IS NOT NULL AND one_off_window_end IS NOT NULL AND one_off_daily_limit IS NOT NULL
      AND one_off_daily_limit BETWEEN 1 AND 100
      AND one_off_window_end > one_off_window_start
      AND (scheduled_at AT TIME ZONE 'Europe/Moscow')::date = one_off_day
      AND (scheduled_at AT TIME ZONE 'Europe/Moscow')::time >= one_off_window_start
      AND (scheduled_at AT TIME ZONE 'Europe/Moscow')::time < one_off_window_end)
  );
