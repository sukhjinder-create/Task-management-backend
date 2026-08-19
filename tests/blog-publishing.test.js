// tests/blog-publishing.test.js
//
// The Asystence Insights editorial rules: normalization, publication
// readiness, and the public projection boundary. Hermetic (pure logic; no DB,
// no network) — the transition guards themselves are enforced in SQL and in
// services/blog.service.js, which are covered by the route contract below.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOG_CATEGORIES,
  PUBLIC_AUTHOR_NAME,
  countWords,
  normalizePayload,
  normalizeSections,
  normalizeSources,
  slugify,
  toPublicPost,
  validateForPublication,
} from "../services/blogContent.js";

// ── Slugs ─────────────────────────────────────────────────────────────────────
test("slugify produces URL-safe, collision-resistant slugs", () => {
  assert.equal(slugify("What is decision-to-outcome intelligence?"), "what-is-decision-to-outcome-intelligence");
  assert.equal(slugify("  Tasks Are Not Outcomes  "), "tasks-are-not-outcomes");
  assert.equal(slugify("AI & Governance: what's next"), "ai-governance-whats-next");
  assert.equal(slugify("---leading and trailing---"), "leading-and-trailing");
  assert.equal(slugify(""), "");
  assert.equal(slugify(null), "");

  // Must never emit a trailing hyphen, including after the length clamp.
  const long = slugify(`${"a".repeat(78)} bbbb`);
  assert.ok(long.length <= 80);
  assert.ok(!long.endsWith("-"), "clamped slug must not end in a hyphen");

  // The slug must satisfy the database CHECK constraint.
  const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const input of ["Hello World!", "a  b", "Ünicode 123", "trailing---"]) {
    const slug = slugify(input);
    if (slug) assert.match(slug, pattern, `"${input}" produced an invalid slug: "${slug}"`);
  }
});

// ── Section and source normalization ─────────────────────────────────────────
test("normalizeSections drops empty sections and keeps anchor ids unique", () => {
  const sections = normalizeSections([
    { title: "Overview", paragraphs: ["One.", "Two."] },
    { title: "Overview", paragraphs: ["Duplicate heading."] },
    { title: "Empty", paragraphs: [] },
    { title: "", paragraphs: ["No title."] },
    { title: "With bullets", paragraphs: ["Body."], bullets: ["a", "", "  b  "] },
  ]);

  assert.equal(sections.length, 3);
  assert.equal(sections[0].id, "overview");
  assert.notEqual(sections[1].id, sections[0].id, "duplicate headings must not share an anchor");
  assert.deepEqual(sections[2].bullets, ["a", "b"]);
  // A section with no bullets omits the key rather than storing an empty array.
  assert.equal("bullets" in sections[0], false);
});

test("normalizeSources requires HTTPS and full attribution", () => {
  const sources = normalizeSources([
    { title: "Good", publisher: "NIST", url: "https://example.org/a" },
    { title: "Insecure", publisher: "NIST", url: "http://example.org/b" },
    { title: "No publisher", publisher: "", url: "https://example.org/c" },
    { title: "", publisher: "NIST", url: "https://example.org/d" },
    { title: "Scheme-less", publisher: "NIST", url: "example.org/e" },
  ]);

  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "https://example.org/a");
});

// ── Payload normalization ────────────────────────────────────────────────────
test("normalizePayload derives reading time and never trusts the client's", () => {
  const sections = [{ title: "Body", paragraphs: [Array(360).fill("word").join(" ")] }];

  const payload = normalizePayload({ title: "A title", sections, reading_minutes: 99 });
  assert.equal(countWords(payload.sections), 360);
  assert.equal(payload.reading_minutes, 2, "360 words at 180wpm is 2 minutes");

  // Even a single word is at least a one-minute read.
  const tiny = normalizePayload({ title: "T", sections: [{ title: "S", paragraphs: ["word"] }] });
  assert.equal(tiny.reading_minutes, 1);
});

test("normalizePayload falls back to a safe category rather than rejecting", () => {
  assert.equal(normalizePayload({ category: "governance" }).category, "governance");
  assert.equal(normalizePayload({ category: "not-a-category" }).category, "execution");
  assert.equal(normalizePayload({}).category, "execution");
  for (const category of BLOG_CATEGORIES) {
    assert.equal(normalizePayload({ category }).category, category);
  }
});

test("partial mode only returns supplied keys, so an edit cannot blank the body", () => {
  const partial = normalizePayload({ title: "Only the title changed" }, { partial: true });

  assert.deepEqual(Object.keys(partial).sort(), ["title"]);
  assert.equal("sections" in partial, false, "an untouched body must not be overwritten");
  assert.equal("takeaways" in partial, false);
  assert.equal("reading_minutes" in partial, false);

  // A full save does populate every field.
  const full = normalizePayload({ title: "Full" });
  assert.equal("sections" in full, true);
  assert.deepEqual(full.sections, []);
});

test("partial mode still normalizes what it is given", () => {
  const partial = normalizePayload(
    { sections: [{ title: "S", paragraphs: ["a b c"] }], slug: "Some Title!" },
    { partial: true }
  );
  assert.equal(partial.slug, "some-title");
  assert.equal(partial.reading_minutes, 1);
});

// ── Publication readiness ────────────────────────────────────────────────────
function publishablePost(overrides = {}) {
  return {
    title: "A sufficiently descriptive article title",
    slug: "a-sufficiently-descriptive-article-title",
    dek: "A short standfirst.",
    category: "execution",
    seo_description: "x".repeat(140),
    takeaways: ["one", "two", "three"],
    sections: [
      { title: "One", paragraphs: [Array(200).fill("word").join(" ")] },
      { title: "Two", paragraphs: [Array(200).fill("word").join(" ")] },
      { title: "Three", paragraphs: [Array(100).fill("word").join(" ")] },
    ],
    sources: [{ title: "S", publisher: "P", url: "https://example.org" }],
    ...overrides,
  };
}

test("a complete post is publishable", () => {
  assert.deepEqual(validateForPublication(publishablePost()), []);
});

test("readiness reports every problem at once, not just the first", () => {
  const problems = validateForPublication({
    title: "Tiny",
    slug: "",
    category: "nope",
    takeaways: [],
    sections: [],
    sources: [],
  });

  assert.ok(problems.length >= 6, `expected several problems, got ${problems.length}`);
  assert.ok(problems.some((p) => p.includes("Title must be at least")));
  assert.ok(problems.some((p) => p.includes("slug is required")));
  assert.ok(problems.some((p) => p.includes("standfirst")));
  assert.ok(problems.some((p) => p.includes("category")));
  assert.ok(problems.some((p) => p.includes("SEO description is required")));
  assert.ok(problems.some((p) => p.includes("three key takeaways")));
  assert.ok(problems.some((p) => p.includes("three sections")));
  assert.ok(problems.some((p) => p.includes("400 are required")));
  assert.ok(problems.some((p) => p.includes("cited source")));
});

test("SEO description length is bounded on both sides", () => {
  const short = validateForPublication(publishablePost({ seo_description: "x".repeat(109) }));
  assert.ok(short.some((p) => p.includes("between 110 and 180")));

  const long = validateForPublication(publishablePost({ seo_description: "x".repeat(181) }));
  assert.ok(long.some((p) => p.includes("between 110 and 180")));

  assert.deepEqual(validateForPublication(publishablePost({ seo_description: "x".repeat(110) })), []);
  assert.deepEqual(validateForPublication(publishablePost({ seo_description: "x".repeat(180) })), []);
});

test("thin articles are rejected with their actual word count", () => {
  const thin = publishablePost({
    sections: [
      { title: "One", paragraphs: ["short"] },
      { title: "Two", paragraphs: ["short"] },
      { title: "Three", paragraphs: ["short"] },
    ],
  });
  const problems = validateForPublication(thin);
  assert.ok(problems.some((p) => p.includes("3 words")), problems.join(" | "));
});

test("an over-long SEO title or headline is caught", () => {
  assert.ok(
    validateForPublication(publishablePost({ seo_title: "x".repeat(71) }))
      .some((p) => p.includes("70 characters"))
  );
  assert.ok(
    validateForPublication(publishablePost({ title: "x".repeat(91) }))
      .some((p) => p.includes("90 characters"))
  );
});

// ── The public boundary ──────────────────────────────────────────────────────
test("toPublicPost never leaks authorship, workspace origin, or review notes", () => {
  const row = {
    id: "post-uuid",
    slug: "a-post",
    status: "published",
    title: "A post",
    short_title: null,
    dek: "Standfirst.",
    category: "decision",
    seo_title: null,
    seo_description: "A description.",
    keywords: ["k"],
    takeaways: ["t"],
    sections: [{ id: "s", title: "S", paragraphs: ["p"] }],
    sources: [],
    related: [],
    product_links: [],
    reading_minutes: 4,
    featured: true,
    author_workspace_id: "workspace-uuid",
    author_user_id: "user-uuid",
    author_superadmin_id: null,
    author_display_name: PUBLIC_AUTHOR_NAME,
    submitted_by: "user-uuid",
    reviewed_by: "superadmin-uuid",
    review_note: "Internal: tighten the third section.",
    published_at: new Date("2026-08-19T10:30:00Z"),
    updated_at: new Date("2026-08-20T08:00:00Z"),
  };

  const publicPost = toPublicPost(row);
  const serialized = JSON.stringify(publicPost);

  for (const secret of [
    "workspace-uuid",
    "user-uuid",
    "superadmin-uuid",
    "Internal: tighten the third section.",
    "post-uuid",
  ]) {
    assert.equal(serialized.includes(secret), false, `public projection leaked: ${secret}`);
  }

  for (const key of [
    "author_workspace_id",
    "author_user_id",
    "author_superadmin_id",
    "review_note",
    "reviewed_by",
    "submitted_by",
    "status",
    "id",
  ]) {
    assert.equal(key in publicPost, false, `public projection exposed column: ${key}`);
  }

  assert.equal(publicPost.author.name, PUBLIC_AUTHOR_NAME);
});

test("toPublicPost matches the shape the landing renderer consumes", () => {
  const publicPost = toPublicPost({
    slug: "a-post",
    title: "A post",
    short_title: null,
    dek: "Standfirst.",
    category: "execution",
    seo_title: null,
    seo_description: null,
    reading_minutes: null,
    published_at: new Date("2026-08-19T10:30:00Z"),
    updated_at: null,
  });

  assert.equal(publicPost.path, "/blog/a-post");
  assert.equal(publicPost.shortTitle, "A post", "shortTitle falls back to the title");
  assert.equal(publicPost.seo.title, "A post", "seo.title falls back to the title");
  assert.equal(publicPost.seo.description, "Standfirst.", "seo.description falls back to the dek");
  assert.equal(publicPost.readingMinutes, 1, "reading time is never zero");

  // Dates are plain YYYY-MM-DD, which is what the sitemap and JSON-LD emit.
  assert.equal(publicPost.publishedAt, "2026-08-19");
  assert.equal(publicPost.updatedAt, "2026-08-19", "updatedAt falls back to publishedAt");
  assert.match(publicPost.publishedAt, /^\d{4}-\d{2}-\d{2}$/);

  // Every array the renderer iterates must exist even when the row is sparse.
  for (const key of ["keywords", "takeaways", "sections", "sources", "related", "productLinks"]) {
    assert.ok(Array.isArray(publicPost[key]), `${key} must always be an array`);
  }
});

test("an unpublished row projects a null publishedAt rather than throwing", () => {
  const draft = toPublicPost({ slug: "d", title: "D", published_at: null, updated_at: null });
  assert.equal(draft.publishedAt, null);
  assert.equal(draft.updatedAt, null);
});
