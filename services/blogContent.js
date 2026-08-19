// services/blogContent.js
//
// The editorial rules for Asystence Insights: how a request body becomes a
// storable post, when a post is fit to publish, and what the public is allowed
// to see.
//
// Deliberately free of database and network imports so both the service layer
// and the test suite can use it directly.

export const BLOG_CATEGORIES = ["decision", "execution", "governance"];
export const PUBLIC_AUTHOR_NAME = "Asystence Editorial Team";

/** Matches the 180wpm rule the landing validator asserts on the fallback set. */
const WORDS_PER_MINUTE = 180;

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    // A trailing hyphen can reappear after the length clamp.
    .replace(/-+$/, "");
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalizeSections(value) {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set();

  return value
    .map((section, index) => {
      const paragraphs = asStringArray(section?.paragraphs);
      const bullets = asStringArray(section?.bullets);
      const title = String(section?.title || "").trim();
      if (!title || !paragraphs.length) return null;

      // Section ids become in-page anchors, so they must be unique.
      let id = slugify(section?.id || title) || `section-${index + 1}`;
      let suffix = 2;
      while (usedIds.has(id)) id = `${slugify(section?.id || title)}-${suffix++}`;
      usedIds.add(id);

      return { id, title, paragraphs, ...(bullets.length ? { bullets } : {}) };
    })
    .filter(Boolean);
}

export function normalizeSources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((source) => {
      const url = String(source?.url || "").trim();
      const title = String(source?.title || "").trim();
      const publisher = String(source?.publisher || "").trim();
      if (!url || !title || !publisher) return null;
      // Mirrors the landing validator: external references must be HTTPS.
      if (!/^https:\/\//i.test(url)) return null;
      return { title, publisher, url };
    })
    .filter(Boolean);
}

export function countWords(sections) {
  return (sections || []).reduce(
    (total, section) =>
      total +
      (section.paragraphs || []).join(" ").split(/\s+/).filter(Boolean).length +
      (section.bullets || []).join(" ").split(/\s+/).filter(Boolean).length,
    0
  );
}

/**
 * Shapes an inbound body into storable columns.
 *
 * In `partial` mode only the keys the caller actually supplied are returned, so
 * an edit that touches the title cannot silently blank the sections.
 */
export function normalizePayload(body = {}, { partial = false } = {}) {
  const out = {};
  const has = (key) => body[key] !== undefined;
  const want = (key) => !partial || has(key);

  if (want("title")) out.title = String(body.title || "").trim();
  if (want("short_title")) out.short_title = String(body.short_title || body.title || "").trim() || null;
  if (want("dek")) out.dek = String(body.dek || "").trim() || null;
  if (want("category")) out.category = BLOG_CATEGORIES.includes(body.category) ? body.category : "execution";
  if (want("seo_title")) out.seo_title = String(body.seo_title || body.title || "").trim() || null;
  if (want("seo_description")) out.seo_description = String(body.seo_description || "").trim() || null;
  if (want("keywords")) out.keywords = asStringArray(body.keywords);
  if (want("takeaways")) out.takeaways = asStringArray(body.takeaways);
  if (want("sections")) out.sections = normalizeSections(body.sections);
  if (want("sources")) out.sources = normalizeSources(body.sources);
  if (want("related")) out.related = asStringArray(body.related).map(slugify).filter(Boolean);
  if (want("product_links")) out.product_links = asStringArray(body.product_links);
  if (has("featured")) out.featured = Boolean(body.featured);

  if (has("slug")) {
    const slug = slugify(body.slug);
    if (slug) out.slug = slug;
  }

  // Reading time is always derived, never trusted from the client.
  if (out.sections) {
    out.reading_minutes = Math.max(1, Math.ceil(countWords(out.sections) / WORDS_PER_MINUTE));
  }

  return out;
}

/**
 * Publication readiness.
 *
 * Draft saves stay permissive so an author can work incrementally; these rules
 * bite at submit and publish, which is also where the landing renderer starts
 * depending on the shape being complete.
 */
export function validateForPublication(post) {
  const problems = [];

  if (!post.title || post.title.length < 10) problems.push("Title must be at least 10 characters");
  if (post.title && post.title.length > 90) problems.push("Title must be 90 characters or fewer");
  if (!post.slug) problems.push("A URL slug is required");
  if (!post.dek) problems.push("A short standfirst (dek) is required");
  if (!BLOG_CATEGORIES.includes(post.category)) problems.push("A valid category is required");

  if (!post.seo_description) {
    problems.push("An SEO description is required");
  } else if (post.seo_description.length < 110 || post.seo_description.length > 180) {
    problems.push("SEO description must be between 110 and 180 characters");
  }
  if (post.seo_title && post.seo_title.length > 70) {
    problems.push("SEO title must be 70 characters or fewer");
  }

  if ((Array.isArray(post.takeaways) ? post.takeaways : []).length < 3) {
    problems.push("At least three key takeaways are required");
  }

  const sections = Array.isArray(post.sections) ? post.sections : [];
  if (sections.length < 3) problems.push("At least three sections are required");

  const words = countWords(sections);
  if (words < 400) problems.push(`Article body is ${words} words; at least 400 are required`);

  if ((Array.isArray(post.sources) ? post.sources : []).length < 1) {
    problems.push("At least one cited source is required");
  }

  return problems;
}

function toDateOnly(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * What the landing site is allowed to see.
 *
 * Deliberately omits author identity, workspace origin, and every review
 * field: a published post must never reveal which customer wrote it, who
 * reviewed it, or what the reviewer said.
 */
export function toPublicPost(row) {
  return {
    slug: row.slug,
    path: `/blog/${row.slug}`,
    title: row.title,
    shortTitle: row.short_title || row.title,
    dek: row.dek,
    category: row.category,
    featured: Boolean(row.featured),
    readingMinutes: Number(row.reading_minutes) || 1,
    keywords: row.keywords || [],
    takeaways: row.takeaways || [],
    sections: row.sections || [],
    sources: row.sources || [],
    related: row.related || [],
    productLinks: row.product_links || [],
    seo: {
      title: row.seo_title || row.title,
      description: row.seo_description || row.dek || "",
    },
    author: { name: row.author_display_name || PUBLIC_AUTHOR_NAME, url: "/blog" },
    publishedAt: toDateOnly(row.published_at),
    updatedAt: toDateOnly(row.updated_at || row.published_at),
  };
}
