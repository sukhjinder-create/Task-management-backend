-- Backfill ticket_number for existing tasks that have no ticket_number yet.
-- Starts each project's new numbers from (current max + 1) to avoid conflicts
-- with tasks that were already assigned a ticket number.

WITH max_per_project AS (
  -- Find the highest ticket_number already in use per project
  SELECT project_id, COALESCE(MAX(ticket_number), 0) AS max_num
  FROM tasks
  WHERE project_id IS NOT NULL
  GROUP BY project_id
),
numbered AS (
  -- Assign sequential numbers to unassigned tasks, continuing from max+1
  SELECT
    t.id,
    t.project_id,
    m.max_num + ROW_NUMBER() OVER (
      PARTITION BY t.project_id
      ORDER BY t.created_at ASC
    ) AS new_ticket_number
  FROM tasks t
  JOIN max_per_project m ON m.project_id = t.project_id
  WHERE t.ticket_number IS NULL
)
UPDATE tasks
SET ticket_number = numbered.new_ticket_number
FROM numbered
WHERE tasks.id = numbered.id;

-- Sync project_ticket_sequences to the highest ticket number now in use
INSERT INTO project_ticket_sequences (project_id, last_number)
SELECT
  project_id,
  MAX(ticket_number)
FROM tasks
WHERE project_id IS NOT NULL
  AND ticket_number IS NOT NULL
GROUP BY project_id
ON CONFLICT (project_id) DO UPDATE
  SET last_number = GREATEST(
    project_ticket_sequences.last_number,
    EXCLUDED.last_number
  );
