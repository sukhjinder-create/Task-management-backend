// scripts/seed-blog-from-landing.js
//
// Imports the six launch articles that currently live as literals in the
// landing repo's src/blogData.js into blog_posts, so a Super Admin can edit
// them in the console alongside everything published since.
//
// Idempotent on slug: re-running updates content in place and never
// duplicates. Existing published_at values are preserved, because those dates
// are already indexed by search engines.
//
// Usage:
//   node scripts/seed-blog-from-landing.js [--landing <path>] [--dry-run]

import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import pool from "../db.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

// Default assumes the sibling checkout layout used in development.
const landingRoot = path.resolve(
  argValue("--landing", path.resolve(process.cwd(), "../Task-management-landing"))
);
const blogDataPath = path.join(landingRoot, "src", "blogData.js");

if (!fs.existsSync(blogDataPath)) {
  console.error(`Could not find blogData.js at ${blogDataPath}`);
  console.error("Pass the landing checkout explicitly:  --landing /path/to/Task-management-landing");
  process.exit(1);
}

const { BLOG_POSTS } = await import(pathToFileURL(blogDataPath).href);

if (!Array.isArray(BLOG_POSTS) || !BLOG_POSTS.length) {
  console.error("blogData.js exported no posts; refusing to run.");
  process.exit(1);
}

async function seedPost(client, article) {
  const existing = await client.query(
    `SELECT id, status, published_at FROM blog_posts WHERE slug = $1`,
    [article.slug]
  );

  const columns = {
    slug: article.slug,
    title: article.title,
    short_title: article.shortTitle || article.title,
    dek: article.dek,
    category: article.category,
    seo_title: article.seo?.title || article.title,
    seo_description: article.seo?.description || article.dek,
    keywords: article.keywords || [],
    takeaways: JSON.stringify(article.takeaways || []),
    sections: JSON.stringify(article.sections || []),
    sources: JSON.stringify(article.sources || []),
    related: article.related || [],
    product_links: article.productLinks || [],
    reading_minutes: article.readingMinutes || 1,
    featured: Boolean(article.featured),
    author_display_name: article.author?.name || "Asystence Editorial Team",
  };

  if (existing.rowCount) {
    const row = existing.rows[0];
    const assignments = [];
    const values = [];
    for (const [column, value] of Object.entries(columns)) {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(row.id);
    if (!dryRun) {
      await client.query(
        `UPDATE blog_posts SET ${assignments.join(", ")} WHERE id = $${values.length}`,
        values
      );
    }
    return { slug: article.slug, action: "updated", status: row.status };
  }

  // A seeded launch article is published, authored by the platform, and keeps
  // its original publication date.
  const publishedAt = new Date(`${article.publishedAt}T00:00:00Z`);
  const superadmin = await client.query(`SELECT id FROM superadmins ORDER BY created_at ASC LIMIT 1`);
  if (!superadmin.rowCount) {
    throw new Error("No superadmin row exists; create one before seeding (author_superadmin_id is required).");
  }

  const insertColumns = {
    ...columns,
    status: "published",
    author_superadmin_id: superadmin.rows[0].id,
    published_at: publishedAt,
    reviewed_at: publishedAt,
    reviewed_by: superadmin.rows[0].id,
  };

  const names = Object.keys(insertColumns);
  const values = Object.values(insertColumns);
  const placeholders = names.map((_, index) => `$${index + 1}`);

  if (!dryRun) {
    const inserted = await client.query(
      `INSERT INTO blog_posts (${names.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING id`,
      values
    );
    await client.query(
      `INSERT INTO blog_post_events (post_id, action, to_status, actor_type, note)
       VALUES ($1, 'published', 'published', 'system', 'Seeded from landing blogData.js')`,
      [inserted.rows[0].id]
    );
  }
  return { slug: article.slug, action: "inserted", status: "published" };
}

async function run() {
  const client = await pool.connect();
  const results = [];
  try {
    await client.query("BEGIN");
    for (const article of BLOG_POSTS) {
      results.push(await seedPost(client, article));
    }
    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  for (const result of results) {
    console.log(`  ${result.action.padEnd(8)} ${result.slug}  (${result.status})`);
  }
  console.log(
    `${dryRun ? "[dry run] " : ""}Seeded ${results.length} launch articles from ${blogDataPath}`
  );
}

run()
  .catch((error) => {
    console.error("Blog seed failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
