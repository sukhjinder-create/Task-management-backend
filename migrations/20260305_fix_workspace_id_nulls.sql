-- Fix NULL workspace_id in tasks and prevent future occurrences

-- Step 1: Fix any remaining tasks with NULL workspace_id by inheriting from projects
UPDATE tasks t
SET workspace_id = p.workspace_id
FROM projects p
WHERE t.project_id = p.id
  AND t.workspace_id IS NULL
  AND p.workspace_id IS NOT NULL;

-- Step 2: For tasks with NULL workspace_id and no project, delete or handle manually
-- (Check first if any exist)
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM tasks
  WHERE workspace_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE NOTICE 'Warning: % tasks still have NULL workspace_id. These need manual review.', orphan_count;
    -- Optionally delete them:
    -- DELETE FROM tasks WHERE workspace_id IS NULL;
  ELSE
    RAISE NOTICE 'All tasks have valid workspace_id';
  END IF;
END $$;

-- Step 3: Add NOT NULL constraint to prevent future NULLs
-- (Only if all tasks have workspace_id)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_id IS NULL) THEN
    ALTER TABLE tasks ALTER COLUMN workspace_id SET NOT NULL;
    RAISE NOTICE 'NOT NULL constraint added to tasks.workspace_id';
  ELSE
    RAISE NOTICE 'Skipping constraint - NULL values still exist';
  END IF;
END $$;

-- Step 4: Add a check constraint as additional safety
ALTER TABLE tasks
DROP CONSTRAINT IF EXISTS tasks_workspace_id_not_null;

ALTER TABLE tasks
ADD CONSTRAINT tasks_workspace_id_not_null
CHECK (workspace_id IS NOT NULL);

-- Verification query
SELECT
  COUNT(*) as total_tasks,
  COUNT(workspace_id) as tasks_with_workspace,
  COUNT(*) - COUNT(workspace_id) as tasks_without_workspace
FROM tasks;
