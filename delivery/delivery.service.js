import pool from "../db.js";
import { generateExecutiveSummaryPDF } from "./pdf/executiveSummary.pdf.js";
import { sendExecutiveSummaryEmail } from "./email/executiveSummary.email.js";

export async function deliverExecutiveSummary({
  workspaceId,
  period,
  recipients,
}) {
  const { rows } = await pool.query(
    `
    SELECT summary
    FROM workspace_executive_summaries
    WHERE workspace_id = $1
      AND period = $2
    `,
    [workspaceId, period]
  );

  if (!rows.length) return;

  const summaryText = rows[0].summary;

  const pdfPath = await generateExecutiveSummaryPDF({
    workspaceId,
    period,
    summaryText,
  });

  for (const email of recipients) {
    await sendExecutiveSummaryEmail({
      to: email,
      period,
      summaryText,
      pdfPath,
    });
  }
}
