# Production monitoring

Two independent layers, deliberately kept separate:

| Layer | Runs on | Catches | Alerts via |
|---|---|---|---|
| `health-monitor.sh` + systemd timer | the production host, every minute | container down, app not responding, database unreachable, stale/missing backups, disk, memory | email (SMTP from the app env) |
| `.github/workflows/uptime-check.yml` | GitHub, every 10 minutes | the public endpoint being unreachable — **including the whole host being gone** | GitHub's build-failure email |

The second layer exists because a monitor hosted on the machine it watches
cannot report that the machine died. Neither layer depends on the other.

## Install / update on the server

```bash
scp ops/monitoring/health-monitor.sh ubuntu@<host>:/tmp/
ssh ubuntu@<host> '
  sudo mv /tmp/health-monitor.sh /usr/local/bin/asystence-health-monitor
  sudo chmod +x /usr/local/bin/asystence-health-monitor
  sudo mkdir -p /var/lib/asystence-monitor
'

# systemd units (only needed once)
scp ops/monitoring/asystence-monitor.{service,timer} ubuntu@<host>:/tmp/
ssh ubuntu@<host> '
  sudo mv /tmp/asystence-monitor.service /tmp/asystence-monitor.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now asystence-monitor.timer
'
```

## Behaviour

- **De-duplicated:** a sustained outage emails once, not once per minute. A
  `[RECOVERED]` email follows when all checks pass again. State lives in
  `/var/lib/asystence-monitor/state`.
- **Read-only:** the monitor never restarts or modifies the application. It
  observes and reports; remediation is a human decision.
- **Exit codes:** `0` healthy, `1` one or more checks failing. The systemd unit
  treats `1` as success so a failing check doesn't also spam systemd — the
  script owns alerting.

## Operating it

```bash
# Run once, right now
sudo /usr/local/bin/asystence-health-monitor; echo "exit: $?"

# Recent runs
sudo journalctl -u asystence-monitor.service --since '30 min ago'

# Schedule
systemctl list-timers asystence-monitor.timer

# Pause / resume alerting (e.g. during planned maintenance)
sudo systemctl stop asystence-monitor.timer
sudo systemctl start asystence-monitor.timer
```

## Configuration

Alert delivery reuses the application's SMTP settings from `~/app/.env`
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`EMAIL_FROM`, `EMAIL_FROM_NAME`) and sends to `ALERT_EMAIL_TO`. If `SMTP_HOST`
is unset the monitor still runs and still reports via its exit code — it just
cannot email.

Thresholds are constants at the top of the script: `DISK_WARN_PCT` (85),
`MEM_WARN_PCT` (90), and the backup staleness window (48h).
