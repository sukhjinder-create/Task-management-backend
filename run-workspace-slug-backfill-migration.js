/**
 * Backfill workspace slugs.
 *
 * `workspaces.slug` is nullable and was never populated, so no workspace is
 * reachable at `<slug>.asystence.com` -- the edge router 404s anything it
 * cannot resolve. This assigns every workspace a unique, routable slug derived
 * from its name.
 *
 * Idempotent: workspaces that already have a slug are left untouched, because
 * a slug is a published hostname and rewriting one breaks every existing link.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node run-workspace-slug-backfill-migration.js
 *   node run-workspace-slug-backfill-migration.js --apply
 */

import pool from "./db.js";
import { generateUniqueSlug, validateSlug } from "./services/workspaceSlug.service.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "Applying workspace slug backfill...\n" : "DRY RUN - no changes will be written.\n");

  const client = await pool.connect();
  try {
    // Audit existing slugs first. One that is reserved or malformed is already
    // unreachable at the edge, and the operator needs to know rather than have
    // it quietly renamed underneath a link someone shared.
    const { rows: existing } = await client.query(
      `SELECT id, name, slug FROM workspaces
        WHERE slug IS NOT NULL AND btrim(slug) <> ''
        ORDER BY created_at`
    );

    const invalid = existing.filter((w) => validateSlug(w.slug));
    if (invalid.length) {
      console.log(`WARNING - ${invalid.length} existing slug(s) are not routable and were left alone:`);
      for (const w of invalid) {
        console.log(`  ${w.slug}  (${w.name})  -> ${validateSlug(w.slug)}`);
      }
      console.log("");
    }

    const { rows: missing } = await client.query(
      `SELECT id, name FROM workspaces
        WHERE (slug IS NULL OR btrim(slug) = '')
          AND COALESCE(status, 'active') <> 'deleted'
        ORDER BY created_at`
    );

    console.log(`${existing.length} workspace(s) already have a slug.`);
    console.log(`${missing.length} workspace(s) need one.\n`);

    if (!missing.length) {
      console.log("Nothing to do.");
      return;
    }

    if (APPLY) await client.query("BEGIN");

    // Slugs issued in this run. A dry run writes nothing, so without this the
    // preview hands the same slug to two workspaces with matching names and
    // shows the operator something the real run would never do.
    const claimed = new Set(existing.map((w) => String(w.slug).toLowerCase()));

    for (const workspace of missing) {
      // Generated inside the transaction so the uniqueness check and the write
      // are not separated by a concurrent insert claiming the same slug.
      const slug = await generateUniqueSlug(workspace.name, { client, claimed });

      if (APPLY) {
        await client.query(
          `UPDATE workspaces SET slug = $2, updated_at = now() WHERE id = $1`,
          [workspace.id, slug]
        );
      }
      console.log(`  ${APPLY ? "set" : "would set"}  ${slug.padEnd(28)} <- ${workspace.name}`);
    }

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\nCommitted ${missing.length} slug(s).`);
    } else {
      console.log(`\nDry run complete. Re-run with --apply to write.`);
    }
  } catch (err) {
    if (APPLY) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be gone */ }
    }
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("\nFAILED:", err?.message || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
