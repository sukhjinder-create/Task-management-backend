-- Make Row Level Security automatic for every table created from now on.
--
-- WHY THIS EXISTS
-- Supabase publishes a REST endpoint for every table in `public`. RLS is the
-- only thing that stops an anon or authenticated key reading one directly,
-- bypassing the backend and all of its permission middleware. So a table without
-- RLS is a public read of whatever is in it.
--
-- Both previous attempts at this invariant were snapshots, not rules:
-- 20260430_enable_rls_all_tables.sql listed tables BY NAME, which protected that
-- day's tables and nothing afterwards; by 2026-08-05 that had decayed into 85
-- unprotected tables, including meeting transcripts and billing.
-- 20260805_enable_rls_remaining_tables.sql repaired those 85 -- and would have
-- started the same clock again, because it too is a list.
--
-- A database-level rule cannot decay. This event trigger fires on every CREATE
-- TABLE and enables RLS immediately, so a new table is protected at birth
-- regardless of who creates it: a migration, a hand-run statement, or a tool
-- that never touches this repository. Nobody has to remember anything.
--
-- DEFENCE IN DEPTH — this is the third of three layers, not a replacement:
--   1. tests/migrations-rls-guard.test.js  blocks the pull request (static)
--   2. this trigger                        protects the table at creation
--   3. scripts/verify-rls.js               audits the live database
-- They fail differently on purpose: the guard cannot see a table created outside
-- this repo, the trigger cannot run if it is ever dropped, and the audit catches
-- whatever the other two missed.
--
-- SCOPE AND SAFETY
--  * `public` only. Extensions create tables in their own schemas, and enabling
--    RLS on those could break them; they are also not REST-exposed.
--  * Extension-owned tables in public are skipped for the same reason.
--  * Temporary tables land in pg_temp_*, so the schema filter already excludes
--    them; they are session-scoped and never REST-exposed.
--  * FAIL-OPEN BY DESIGN. If enabling RLS raises for some edge case, the trigger
--    emits a WARNING and lets the DDL succeed. A trigger that can abort CREATE
--    TABLE is a trigger that can break a production migration at 3am, and the
--    two other layers already catch anything that slips through. Availability
--    here is worth more than the few seconds of exposure before an audit fires.
--
-- Idempotent: safe to run repeatedly.

CREATE OR REPLACE FUNCTION public.auto_enable_rls_on_new_table()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    -- Ordinary tables in public only. `object_type` excludes views, indexes,
    -- sequences and foreign tables, none of which take RLS.
    IF obj.object_type = 'table' AND obj.schema_name = 'public' THEN

      -- Skip anything an extension owns: it manages its own objects, and
      -- altering them can break the extension.
      IF EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = obj.objid
          AND d.deptype = 'e'
      ) THEN
        CONTINUE;
      END IF;

      BEGIN
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXCEPTION WHEN OTHERS THEN
        -- Never abort the DDL. See FAIL-OPEN above.
        RAISE WARNING 'auto_enable_rls: could not enable RLS on % (%)',
          obj.object_identity, SQLERRM;
      END;

    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.auto_enable_rls_on_new_table() IS
  'Enables RLS on every new public table. See migrations/20260805b_auto_enable_rls_event_trigger.sql.';

DROP EVENT TRIGGER IF EXISTS auto_enable_rls_on_new_table;

CREATE EVENT TRIGGER auto_enable_rls_on_new_table
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.auto_enable_rls_on_new_table();

-- Verification (expects 0 rows):
-- SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
--
-- Confirm the trigger is installed and enabled ('O' = enabled):
-- SELECT evtname, evtevent, evtenabled FROM pg_event_trigger
--  WHERE evtname = 'auto_enable_rls_on_new_table';
