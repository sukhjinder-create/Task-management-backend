-- ============================================================
-- Migration: OKR → Goals
--
-- We keep the underlying table names (okr_objectives, okr_sprint_links)
-- unchanged to avoid breaking any existing data or queries.
-- The "Goals" rename is purely at the API/application layer.
--
-- The only DB change: drop okr_key_results — the KR concept is
-- removed. Progress is now 100% sprint-driven (or manually set).
-- ============================================================

-- Drop key results (KR concept removed — no longer used)
DROP TABLE IF EXISTS okr_key_results CASCADE;
