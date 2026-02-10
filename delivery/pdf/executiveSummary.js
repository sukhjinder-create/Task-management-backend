import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function generateExecutiveSummaryPDF({
  workspaceId,
  period,
  summaryText,
}) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const { width, height } = page.getSize();
  let y = height - 80;

  page.drawText(`Executive Performance Summary`, {
    x: 50,
    y,
    size: 18,
    font,
  });

  y -= 30;

  page.drawText(`Workspace: ${workspaceId}`, {
    x: 50,
    y,
    size: 10,
    font,
  });

  y -= 15;

  page.drawText(`Period: ${period}`, {
    x: 50,
    y,
    size: 10,
    font,
  });

  y -= 30;

  const wrappedText = summaryText.match(/.{1,90}/g) || [];
  for (const line of wrappedText) {
    page.drawText(line, {
      x: 50,
      y,
      size: 11,
      font,
    });
    y -= 16;
  }

  const pdfBytes = await pdfDoc.save();

  const outputDir = path.join("uploads", "executive-summaries");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filePath = path.join(
    outputDir,
    `exec-summary-${workspaceId}-${period}.pdf`
  );

  fs.writeFileSync(filePath, pdfBytes);

  return filePath;
}
