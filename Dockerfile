FROM node:20-slim

WORKDIR /app

# ── Optional heavy features — OFF by default so the image stays small enough for
#    free/small hosts (e.g. Koyeb 512MB). Flip a flag at build time to restore one:
#      --build-arg INCLUDE_PG_CLIENT=true  → built-in DB backup + workspace recovery (pg_dump/psql)
#      --build-arg INCLUDE_BROWSER=true    → Testing Agent (Playwright Chromium)
#    No application code changes are needed to re-enable — only these build flags.
ARG INCLUDE_PG_CLIENT=false
ARG INCLUDE_BROWSER=false

# pg_dump/psql for Super Admin database backup + workspace recovery (only when INCLUDE_PG_CLIENT=true).
# Uses the official PostgreSQL repository so the client is new enough for prod.
ARG POSTGRES_CLIENT_MAJOR=17
RUN if [ "$INCLUDE_PG_CLIENT" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
      && install -d /usr/share/postgresql-common/pgdg \
      && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
      && . /etc/os-release \
      && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends "postgresql-client-${POSTGRES_CLIENT_MAJOR}" \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Copy package files first (better layer caching)
COPY package*.json ./

# Install production dependencies only (clean cache first to avoid Cloud Build stale cache issues)
RUN npm cache clean --force && npm ci --omit=dev

# Playwright's Chromium + system deps for the Testing Agent (only when INCLUDE_BROWSER=true).
# The playwright npm package is always installed (it's a normal dependency), so the app
# boots fine without the browser; only the Testing Agent feature stays dormant until enabled.
RUN if [ "$INCLUDE_BROWSER" = "true" ]; then npx playwright install chromium --with-deps; fi

# Copy application source
COPY . .

# Cloud Run writes to /tmp (ephemeral) — uploads go to S3 in production
RUN mkdir -p /tmp/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
