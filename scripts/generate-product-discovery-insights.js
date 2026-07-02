import pool from "../db.js";
import { getProductDiscoveryReport, persistProductDiscoveryInsights } from "../growth/productDiscovery.service.js";

function parseArgs(argv = process.argv.slice(2)) {
  const query = {};
  let persist = false;
  for (const arg of argv) {
    if (arg === "--persist") persist = true;
    else if (arg.startsWith("--from=")) query.from = arg.slice("--from=".length);
    else if (arg.startsWith("--to=")) query.to = arg.slice("--to=".length);
  }
  return { query, persist };
}

const { query, persist } = parseArgs();

try {
  const report = await getProductDiscoveryReport(query);
  if (persist) report.persistence = await persistProductDiscoveryInsights(report);
  console.log(JSON.stringify({
    status: "ok",
    range: report.range,
    generated_at: report.generated_at,
    overview: report.overview,
    insight_count: report.insights.length,
    insights: report.insights,
    persistence: report.persistence || null,
  }, null, 2));
} catch (error) {
  console.error("Product Discovery insight generation failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
