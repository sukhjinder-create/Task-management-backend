FROM node:20-slim

WORKDIR /app

# pg_dump/psql are required by Super Admin database backup and workspace recovery.
# Use the official PostgreSQL repository so the client is new enough for prod.
ARG POSTGRES_CLIENT_MAJOR=17
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
  && . /etc/os-release \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${POSTGRES_CLIENT_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

# Copy package files first (better layer caching)
COPY package*.json ./

# Install production dependencies only (clean cache first to avoid Cloud Build stale cache issues)
RUN npm cache clean --force && npm ci --omit=dev

# Install Playwright's Chromium + all its system dependencies
# (used by the Testing Agent feature)
RUN npx playwright install chromium --with-deps

# Copy application source
COPY . .

# Cloud Run writes to /tmp (ephemeral) — uploads go to S3 in production
RUN mkdir -p /tmp/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
