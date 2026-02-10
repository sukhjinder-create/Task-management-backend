import nodemailer from "nodemailer";

export async function sendExecutiveSummaryEmail({
  to,
  period,
  summaryText,
  pdfPath,
}) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: `"AI Performance System" <${process.env.SMTP_USER}>`,
    to,
    subject: `Executive Performance Summary – ${period}`,
    text: summaryText,
    attachments: [
      {
        filename: `Executive-Summary-${period}.pdf`,
        path: pdfPath,
      },
    ],
  });
}
