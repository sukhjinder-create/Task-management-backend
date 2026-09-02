// services/email.service.js
// Centralised email notification system using nodemailer
import nodemailer from "nodemailer";
import { getFrontendBaseUrl } from "../config/environment.js";

const FROM_NAME    = process.env.EMAIL_FROM_NAME  || "TaskManagement";
const FROM_ADDRESS = process.env.EMAIL_FROM       || "noreply@taskmanagement.app";
const APP_URL      = getFrontendBaseUrl();

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (process.env.SMTP_HOST) {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  } else if (process.env.NODE_ENV !== "production") {
    // Dev fallback: log to console instead of sending
    _transporter = {
      sendMail: async (opts) => {
        console.log("[email:dev]", opts.to, "|", opts.subject);
        return { messageId: "dev-" + Date.now() };
      },
    };
  } else {
    throw new Error("SMTP is not configured");
  }
  return _transporter;
}

async function send({ to, subject, html, text }) {
  try {
    if (!to) return false;
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ""),
    });
    return true;
  } catch (err) {
    console.warn("[email] Failed to send email:", err.message);
    return false;
  }
}

export function isEmailDeliveryConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

// ─── HTML template wrapper ─────────────────────────────────────────────────────
function wrap(title, body, meta = `You're receiving this email because you're a member of a ${FROM_NAME} workspace.`) {
  return `
<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f5f7;margin:0;padding:0}
  .container{max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .header{background:#6366f1;color:#ffffff;padding:24px 32px}
  .header h1{margin:0;font-size:22px;font-weight:600}
  .body{padding:32px}
  .body p{color:#374151;line-height:1.6;margin:0 0 16px}
  .btn{display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin:8px 0}
  .meta{color:#9ca3af;font-size:13px;margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb}
  .footer{background:#f9fafb;padding:16px 32px;color:#9ca3af;font-size:12px}
</style></head><body>
<div class="container">
  <div class="header"><h1>${FROM_NAME}</h1></div>
  <div class="body">
    <h2 style="margin:0 0 16px;color:#111827">${title}</h2>
    ${body}
    <div class="meta">${meta}</div>
  </div>
  <div class="footer">&copy; ${new Date().getFullYear()} ${FROM_NAME}. All rights reserved.</div>
</div></body></html>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// ─── Email templates ───────────────────────────────────────────────────────────

export async function sendWelcomeEmail({ to, username, workspaceName, loginUrl }) {
  await send({
    to,
    subject: `Welcome to ${workspaceName} on ${FROM_NAME}`,
    html: wrap("Welcome aboard! 👋", `
      <p>Hi ${username},</p>
      <p>You've been added to <strong>${workspaceName}</strong> on ${FROM_NAME}. Get started by logging in:</p>
      <a class="btn" href="${loginUrl || APP_URL + "/login"}">Log In Now</a>
      <p>If you have any questions, just reply to this email — we're always happy to help.</p>
    `),
  });
}

export async function sendTaskAssignedEmail({ to, username, taskTitle, taskUrl, assignedBy, projectName }) {
  await send({
    to,
    subject: `Task assigned to you: ${taskTitle}`,
    html: wrap("New Task Assigned", `
      <p>Hi ${username},</p>
      <p><strong>${assignedBy}</strong> assigned you a task in <strong>${projectName || "a project"}</strong>:</p>
      <p style="background:#f3f4f6;padding:16px;border-radius:6px;border-left:4px solid #6366f1">
        <strong>${taskTitle}</strong>
      </p>
      <a class="btn" href="${taskUrl || APP_URL}">View Task</a>
    `),
  });
}

export async function sendMentionEmail({ to, username, mentionedBy, context, entityUrl, entityType = "task" }) {
  await send({
    to,
    subject: `${mentionedBy} mentioned you`,
    html: wrap(`You were mentioned in a ${entityType}`, `
      <p>Hi ${username},</p>
      <p><strong>${mentionedBy}</strong> mentioned you:</p>
      <p style="background:#f3f4f6;padding:16px;border-radius:6px;font-style:italic">"${context}"</p>
      <a class="btn" href="${entityUrl || APP_URL}">View ${entityType}</a>
    `),
  });
}

export async function sendLeaveRequestEmail({ to, username, requester, leaveType, startDate, endDate, days, reviewUrl }) {
  await send({
    to,
    subject: `Leave request from ${requester} — action required`,
    html: wrap("Leave Request Pending Approval", `
      <p>Hi ${username},</p>
      <p><strong>${requester}</strong> has submitted a leave request:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;color:#6b7280">Type</td><td style="padding:8px;font-weight:600">${leaveType}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">From</td><td style="padding:8px;font-weight:600">${startDate}</td></tr>
        <tr><td style="padding:8px;color:#6b7280">To</td><td style="padding:8px;font-weight:600">${endDate}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">Days</td><td style="padding:8px;font-weight:600">${days}</td></tr>
      </table>
      <a class="btn" href="${reviewUrl || APP_URL}">Review Request</a>
    `),
  });
}

export async function sendLeaveStatusEmail({ to, username, status, leaveType, startDate, endDate, reviewNote }) {
  const statusColor = status === "approved" ? "#10b981" : "#ef4444";
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

  await send({
    to,
    subject: `Your leave request has been ${status}`,
    html: wrap(`Leave Request ${statusLabel}`, `
      <p>Hi ${username},</p>
      <p>Your leave request has been <strong style="color:${statusColor}">${status}</strong>.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;color:#6b7280">Type</td><td style="padding:8px;font-weight:600">${leaveType}</td></tr>
        <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">Dates</td><td style="padding:8px;font-weight:600">${startDate} → ${endDate}</td></tr>
        ${reviewNote ? `<tr><td style="padding:8px;color:#6b7280">Note</td><td style="padding:8px">${reviewNote}</td></tr>` : ""}
      </table>
      <a class="btn" href="${APP_URL}">View Details</a>
    `),
  });
}

export async function sendPerformanceReviewEmail({
  to, username, reviewerName, cycleName, dueDate, reviewUrl,
  isReminder = false, daysLeft, reviewCount, pendingCount,
}) {
  const subject = isReminder
    ? `⏰ Reminder: ${cycleName} closes in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`
    : `Performance review request: ${cycleName}`;

  const body = isReminder
    ? `
      <p>Hi ${username},</p>
      <p>This is a reminder that <strong>${cycleName}</strong> closes in <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>.</p>
      ${pendingCount ? `<p>You still have <strong>${pendingCount} review${pendingCount !== 1 ? "s" : ""}</strong> to submit.</p>` : ""}
      ${dueDate ? `<p>Deadline: <strong>${dueDate}</strong></p>` : ""}
      <a class="btn" href="${reviewUrl || APP_URL}">Complete Reviews</a>
    `
    : `
      <p>Hi ${username},</p>
      <p>You have ${reviewCount ? `<strong>${reviewCount} review${reviewCount !== 1 ? "s" : ""}</strong>` : "a review"} to complete as part of <strong>${cycleName}</strong>.</p>
      ${reviewerName ? `<p>You are reviewing: <strong>${reviewerName}</strong></p>` : ""}
      ${dueDate ? `<p>Due by: <strong>${dueDate}</strong></p>` : ""}
      <a class="btn" href="${reviewUrl || APP_URL}">Start Reviews</a>
    `;

  await send({
    to,
    subject,
    html: wrap(isReminder ? "Review Reminder" : "Performance Reviews Open", body),
  });
}

export async function sendMfaBackupCodesEmail({ to, username, backupCodes }) {
  const codesHtml = backupCodes.map(c => `<code style="background:#f3f4f6;padding:4px 8px;border-radius:4px;margin:4px;display:inline-block">${c}</code>`).join(" ");
  await send({
    to,
    subject: "Your MFA backup codes",
    html: wrap("MFA Backup Codes", `
      <p>Hi ${username},</p>
      <p>You've enabled two-factor authentication. Here are your backup codes — save them somewhere safe. Each can only be used once.</p>
      <div style="background:#f3f4f6;padding:16px;border-radius:6px;margin:16px 0">${codesHtml}</div>
      <p style="color:#ef4444;font-size:14px">⚠️ Do not share these codes with anyone.</p>
    `),
  });
}

export async function sendPasswordResetEmail({ to, username, resetUrl }) {
  await send({
    to,
    subject: "Reset your password",
    html: wrap("Password Reset Request", `
      <p>Hi ${username},</p>
      <p>We received a request to reset your password. Click the button below — this link expires in 1 hour.</p>
      <a class="btn" href="${resetUrl}">Reset Password</a>
      <p style="color:#6b7280;font-size:14px">If you didn't request this, you can safely ignore this email.</p>
    `),
  });
}

export async function sendEmailVerificationEmail({ to, username, workspaceName, verificationUrl }) {
  return send({
    to,
    subject: `Verify your email for ${FROM_NAME}`,
    html: wrap("Verify your email", `
      <p>Hi ${escapeHtml(username)},</p>
      <p>Confirm this email address to activate <strong>${escapeHtml(workspaceName || "your workspace")}</strong>.</p>
      <a class="btn" href="${escapeHtml(verificationUrl)}">Verify email and continue</a>
      <p style="color:#6b7280;font-size:14px">This secure link expires in 30 minutes and can be used once. If you did not request it, ignore this email.</p>
    `),
  });
}

export async function sendClientPortalAccessEmail({
  to,
  contactName,
  clientName,
  workspaceName,
  accessUrl,
  outcomeTitle = null,
}) {
  const safeWorkspace = escapeHtml(workspaceName || "the workspace");
  const reviewCopy = outcomeTitle
    ? `<p><strong>${safeWorkspace}</strong> has shared an outcome for your review: <strong>${escapeHtml(outcomeTitle)}</strong>.</p>`
    : `<p>Use the secure link below to open every outcome that <strong>${safeWorkspace}</strong> has shared with <strong>${escapeHtml(clientName)}</strong>.</p>`;
  return send({
    to,
    subject: outcomeTitle
      ? `${workspaceName}: outcome ready for your review`
      : `Your ${workspaceName} client portal access link`,
    html: wrap("Secure client portal access", `
      <p>Hi ${escapeHtml(contactName)},</p>
      ${reviewCopy}
      <a class="btn" href="${escapeHtml(accessUrl)}">Open secure client portal</a>
      <p style="color:#6b7280;font-size:14px">This passwordless link expires in 20 minutes and can be used once. Do not forward it. You can request a new link from the portal at any time.</p>
    `, `You are receiving this because ${safeWorkspace} granted ${escapeHtml(clientName)} access to its client assurance portal.`),
  });
}

export async function sendSuperadminPasswordResetEmail({ to, resetUrl }) {
  return send({
    to,
    subject: `Reset your ${FROM_NAME} Super Admin password`,
    html: wrap("Super Admin Password Reset", `
      <p>A password reset was requested for the ${FROM_NAME} platform console.</p>
      <p>This link expires in <strong>1 hour</strong> and can be used only once.</p>
      <a class="btn" href="${resetUrl}">Reset Super Admin Password</a>
      <p style="color:#6b7280;font-size:14px">If you did not request this, ignore this email. Your password and active sessions remain unchanged.</p>
    `),
  });
}

export async function sendWeeklyDigestEmail({ to, username, workspaceName, stats }) {
  const { tasksCompleted = 0, tasksDue = 0, overdue = 0, topProjects = [] } = stats;
  const projectRows = topProjects.map(p =>
    `<tr><td style="padding:8px">${p.name}</td><td style="padding:8px;text-align:right">${p.completed}/${p.total}</td></tr>`
  ).join("");

  await send({
    to,
    subject: `Your weekly digest — ${workspaceName}`,
    html: wrap(`Weekly Digest: ${workspaceName}`, `
      <p>Hi ${username}, here's what happened this week:</p>
      <div style="display:flex;gap:16px;margin:16px 0">
        <div style="flex:1;background:#ecfdf5;padding:16px;border-radius:8px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:#10b981">${tasksCompleted}</div>
          <div style="color:#6b7280;font-size:14px">Tasks completed</div>
        </div>
        <div style="flex:1;background:#eff6ff;padding:16px;border-radius:8px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:#3b82f6">${tasksDue}</div>
          <div style="color:#6b7280;font-size:14px">Due this week</div>
        </div>
        <div style="flex:1;background:#fef2f2;padding:16px;border-radius:8px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:#ef4444">${overdue}</div>
          <div style="color:#6b7280;font-size:14px">Overdue</div>
        </div>
      </div>
      ${topProjects.length ? `
      <h3 style="color:#374151;margin:24px 0 8px">Projects</h3>
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#f9fafb"><th style="padding:8px;text-align:left;color:#6b7280">Project</th><th style="padding:8px;text-align:right;color:#6b7280">Progress</th></tr>
        ${projectRows}
      </table>` : ""}
      <a class="btn" href="${APP_URL}">Open Workspace</a>
    `),
  });
}
