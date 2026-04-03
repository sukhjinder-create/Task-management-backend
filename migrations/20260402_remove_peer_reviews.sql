-- Remove peer reviews from active/draft cycles (keep completed for history)
DELETE FROM performance_reviews pr
USING review_cycles rc
WHERE pr.type = 'peer'
  AND pr.cycle_id = rc.id
  AND rc.status != 'completed';

-- Index to make the self-review lock check fast
CREATE INDEX IF NOT EXISTS idx_perf_reviews_self_lookup
  ON performance_reviews(cycle_id, reviewee_id, type, status);
