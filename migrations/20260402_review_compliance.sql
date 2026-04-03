-- Review compliance: 3-day reminders + missed review tracking

-- Track whether the 3-day reminder was sent for each cycle
ALTER TABLE review_cycles
  ADD COLUMN IF NOT EXISTS reminder_sent_3d boolean DEFAULT false;

-- Fast lookup: find all users who missed their self-review in a closed cycle
CREATE INDEX IF NOT EXISTS idx_perf_reviews_missed
  ON performance_reviews(reviewee_id, type, status)
  WHERE status = 'missed';

-- Fast lookup: find missed reviews by cycle (for monthly scoring penalty)
CREATE INDEX IF NOT EXISTS idx_perf_reviews_cycle_missed
  ON performance_reviews(cycle_id, type, status)
  WHERE status = 'missed';
