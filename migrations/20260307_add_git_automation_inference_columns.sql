ALTER TABLE git_project_automation_settings
  ADD COLUMN IF NOT EXISTS auto_infer_tasks BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS min_inference_confidence INT NOT NULL DEFAULT 62,
  ADD COLUMN IF NOT EXISTS max_inferred_tasks INT NOT NULL DEFAULT 2;
