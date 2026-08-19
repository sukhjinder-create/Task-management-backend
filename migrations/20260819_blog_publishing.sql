-- Asystence Insights publishing pipeline.
--
-- Workspace admins author posts inside their own workspace and submit them for
-- review. Super Admins own the review queue, can author directly, and are the
-- only role that can move a post to `published`.
--
-- Additive and rollback-safe: nothing here alters an existing table. The six
-- launch articles currently living in the landing repo's blogData.js are seeded
-- by scripts/seed-blog-from-landing.js, which is idempotent on slug.

CREATE TABLE IF NOT EXISTS blog_posts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT NOT NULL UNIQUE,

  -- Lifecycle. Only a Super Admin may write 'published'.
  status                TEXT NOT NULL DEFAULT 'draft',

  -- Editorial payload. Shapes mirror the landing renderer exactly so a DB post
  -- and a seeded launch article render through identical code.
  title                 TEXT NOT NULL,
  short_title           TEXT,
  dek                   TEXT,
  category              TEXT NOT NULL DEFAULT 'execution',
  seo_title             TEXT,
  seo_description       TEXT,
  keywords              TEXT[] NOT NULL DEFAULT '{}',
  takeaways             JSONB NOT NULL DEFAULT '[]'::jsonb,
  sections              JSONB NOT NULL DEFAULT '[]'::jsonb,
  sources               JSONB NOT NULL DEFAULT '[]'::jsonb,
  related               TEXT[] NOT NULL DEFAULT '{}',
  product_links         TEXT[] NOT NULL DEFAULT '{}',
  reading_minutes       INTEGER NOT NULL DEFAULT 1,
  featured              BOOLEAN NOT NULL DEFAULT false,

  -- Authorship. Exactly one of (workspace author, superadmin author) is set.
  author_workspace_id   UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  author_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  author_superadmin_id  UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  -- Byline shown publicly. Defaults to the org attribution the landing
  -- validator already enforces; never leaks a workspace member's name.
  author_display_name   TEXT NOT NULL DEFAULT 'Asystence Editorial Team',

  -- Review trail
  submitted_at          TIMESTAMPTZ,
  submitted_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  review_note           TEXT,

  published_at          TIMESTAMPTZ,
  unpublished_at        TIMESTAMPTZ,
  revision              INTEGER NOT NULL DEFAULT 1,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT blog_posts_status_check
    CHECK (status IN ('draft', 'in_review', 'changes_requested', 'published', 'archived')),
  CONSTRAINT blog_posts_category_check
    CHECK (category IN ('decision', 'execution', 'governance')),
  CONSTRAINT blog_posts_slug_format_check
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- A post must have exactly one origin: a workspace or the platform itself.
  CONSTRAINT blog_posts_author_origin_check
    CHECK (
      (author_workspace_id IS NOT NULL AND author_superadmin_id IS NULL)
      OR (author_workspace_id IS NULL AND author_superadmin_id IS NOT NULL)
    ),
  -- Published rows must carry the timestamp the public feed sorts on.
  CONSTRAINT blog_posts_published_at_check
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);

-- The public read path: published posts, newest first.
CREATE INDEX IF NOT EXISTS idx_blog_posts_published
  ON blog_posts (published_at DESC)
  WHERE status = 'published';

-- The Super Admin review queue.
CREATE INDEX IF NOT EXISTS idx_blog_posts_status
  ON blog_posts (status, submitted_at DESC);

-- A workspace admin's own list.
CREATE INDEX IF NOT EXISTS idx_blog_posts_workspace
  ON blog_posts (author_workspace_id, updated_at DESC)
  WHERE author_workspace_id IS NOT NULL;


-- Append-only audit of every lifecycle transition, so "who published this and
-- when" survives later edits to the post itself.
CREATE TABLE IF NOT EXISTS blog_post_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id               UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  action                TEXT NOT NULL,
  from_status           TEXT,
  to_status             TEXT,
  actor_type            TEXT NOT NULL,
  actor_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_superadmin_id   UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  note                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT blog_post_events_action_check
    CHECK (action IN ('created', 'updated', 'submitted', 'withdrawn', 'published',
                      'changes_requested', 'unpublished', 'archived', 'deleted')),
  CONSTRAINT blog_post_events_actor_check
    CHECK (actor_type IN ('workspace_admin', 'superadmin', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_blog_post_events_post
  ON blog_post_events (post_id, created_at DESC);


-- Supabase exposes every public table over its REST API, so without RLS an anon
-- key could read unpublished drafts and reviewer notes directly, bypassing the
-- Super Admin gate entirely. The backend uses the service_role key, which
-- bypasses RLS, so no policies are needed for it to keep working.
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_post_events ENABLE ROW LEVEL SECURITY;


-- updated_at maintenance
CREATE OR REPLACE FUNCTION blog_posts_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blog_posts_touch ON blog_posts;
CREATE TRIGGER trg_blog_posts_touch
  BEFORE UPDATE ON blog_posts
  FOR EACH ROW EXECUTE FUNCTION blog_posts_touch_updated_at();
