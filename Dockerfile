FROM node:20-slim

WORKDIR /app

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
