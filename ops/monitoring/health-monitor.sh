#!/usr/bin/env bash
# Asystence production health monitor.
#
# Runs on the host (outside the containers) every minute via a systemd timer.
# Checks container/app/database/disk/memory health and emails on failure.
#
# Purely observational — it never restarts or modifies the application.
#
# De-duplicates: a sustained outage emails once, not every minute, and sends an
# explicit RECOVERED message when things come back. Complements the external
# GitHub Actions uptime check, which covers the case where this host is gone.
set -uo pipefail

STATE_DIR="/var/lib/asystence-monitor"
STATE_FILE="$STATE_DIR/state"
COMPOSE_FILE="/home/ubuntu/app/docker-compose.prod.yml"
DISK_WARN_PCT=85
MEM_WARN_PCT=90

sudo mkdir -p "$STATE_DIR" 2>/dev/null || mkdir -p "$STATE_DIR" 2>/dev/null
touch "$STATE_FILE" 2>/dev/null

FAILURES=()

# ── 1. Containers running ─────────────────────────────────────────────────────
for c in app-app-1 app-caddy-1 ai-task; do
  status="$(sudo docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "missing")"
  [ "$status" != "running" ] && FAILURES+=("container $c is '$status' (expected running)")
done

# ── 2. App responding locally ─────────────────────────────────────────────────
if sudo docker inspect -f '{{.State.Status}}' app-app-1 2>/dev/null | grep -q running; then
  live="$(sudo docker exec app-app-1 node -e "fetch('http://127.0.0.1:3000/livez').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('000');process.exit(0)})" 2>/dev/null | tail -1)"
  [ "$live" != "200" ] && FAILURES+=("app /livez returned '$live' (expected 200)")
fi

# ── 3. Public endpoint reachable (covers DNS / Cloudflare / Caddy / TLS) ──────
pub="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' https://api.asystence.com/livez 2>/dev/null || echo 000)"
[ "$pub" != "200" ] && FAILURES+=("public https://api.asystence.com/livez returned '$pub' (expected 200)")

# ── 4. Database reachable ─────────────────────────────────────────────────────
if sudo docker inspect -f '{{.State.Status}}' app-app-1 2>/dev/null | grep -q running; then
  db="$(sudo docker exec app-app-1 node -e "
    import('./db.js').then(async ({default: pool}) => {
      try { await pool.query('select 1'); console.log('OK'); }
      catch (e) { console.log('FAIL:' + e.message); }
      process.exit(0);
    }).catch(e => { console.log('FAIL:' + e.message); process.exit(0); });
  " 2>/dev/null | grep -oE '^(OK|FAIL:.*)$' | head -1)"
  [ "$db" != "OK" ] && FAILURES+=("database unreachable: ${db:-no response}")
fi

# ── 5. Last backup succeeded within 48h ───────────────────────────────────────
if sudo docker inspect -f '{{.State.Status}}' app-app-1 2>/dev/null | grep -q running; then
  bk="$(sudo docker exec app-app-1 node -e "
    import('./db.js').then(async ({default: pool}) => {
      try {
        const r = await pool.query(\"SELECT status, started_at FROM backup_logs WHERE status='success' ORDER BY started_at DESC LIMIT 1\");
        if (!r.rows[0]) { console.log('NONE'); }
        else {
          const ageH = (Date.now() - new Date(r.rows[0].started_at)) / 3600000;
          console.log(ageH > 48 ? 'STALE:' + Math.round(ageH) : 'OK');
        }
      } catch { console.log('UNKNOWN'); }
      process.exit(0);
    }).catch(() => { console.log('UNKNOWN'); process.exit(0); });
  " 2>/dev/null | grep -oE '^(OK|NONE|STALE:[0-9]+|UNKNOWN)$' | head -1)"
  case "$bk" in
    NONE)   FAILURES+=("no successful database backup has ever been recorded") ;;
    STALE:*) FAILURES+=("last successful backup was ${bk#STALE:}h ago (expected within 48h)") ;;
  esac
fi

# ── 6. Disk / memory ──────────────────────────────────────────────────────────
disk_pct="$(df / | awk 'NR==2 {gsub("%","",$5); print $5}')"
[ "${disk_pct:-0}" -ge "$DISK_WARN_PCT" ] && FAILURES+=("disk usage at ${disk_pct}% (threshold ${DISK_WARN_PCT}%)")

mem_pct="$(free | awk '/^Mem:/ {printf "%d", $3/$2*100}')"
[ "${mem_pct:-0}" -ge "$MEM_WARN_PCT" ] && FAILURES+=("memory usage at ${mem_pct}% (threshold ${MEM_WARN_PCT}%)")

# ── Email helper (uses the app container's nodemailer + SMTP env) ─────────────
send_email() {
  local subject="$1" body="$2"
  sudo docker exec -e ALERT_SUBJECT="$subject" -e ALERT_BODY="$body" app-app-1 node -e "
    import('nodemailer').then(async (nm) => {
      if (!process.env.SMTP_HOST) { process.exit(0); }
      const t = nm.default.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      try {
        await t.sendMail({
          from: (process.env.EMAIL_FROM_NAME || 'Asystence') + ' <' + process.env.EMAIL_FROM + '>',
          to: process.env.ALERT_EMAIL_TO || process.env.EMAIL_FROM,
          subject: process.env.ALERT_SUBJECT,
          text: process.env.ALERT_BODY,
        });
      } catch (e) { console.error('alert email failed:', e.message); }
      process.exit(0);
    }).catch(() => process.exit(0));
  " >/dev/null 2>&1 || true
}

PREV_STATE="$(cat "$STATE_FILE" 2>/dev/null || echo "ok")"
HOST_NAME="$(hostname)"
NOW="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

if [ ${#FAILURES[@]} -gt 0 ]; then
  CURRENT="$(printf '%s\n' "${FAILURES[@]}")"
  if [ "$PREV_STATE" != "$CURRENT" ]; then
    send_email "[ALERT] Asystence production - $((${#FAILURES[@]})) check(s) failing" \
"Production health checks are FAILING on ${HOST_NAME}.

$(printf ' - %s\n' "${FAILURES[@]}")

Time: ${NOW}

You will not be emailed again for this same condition; a RECOVERED email
follows once all checks pass."
    printf '%s' "$CURRENT" > "$STATE_FILE"
  fi
  exit 1
else
  if [ "$PREV_STATE" != "ok" ]; then
    send_email "[RECOVERED] Asystence production is healthy" \
"All production health checks are passing again on ${HOST_NAME}.

Time: ${NOW}"
    printf 'ok' > "$STATE_FILE"
  fi
  exit 0
fi
