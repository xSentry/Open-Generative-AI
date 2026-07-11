FROM node:20-alpine AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies
COPY package.json package-lock.json ./
COPY packages/Vibe-Workflow/packages/workflow-builder/package*.json ./packages/Vibe-Workflow/packages/workflow-builder/
COPY packages/Open-Poe-AI/packages/agents/package*.json ./packages/Open-Poe-AI/packages/agents/
COPY packages/Open-AI-Design-Agent/packages/design-agent/package*.json ./packages/Open-AI-Design-Agent/packages/design-agent/
COPY packages/studio/package*.json ./packages/studio/
RUN npm ci

# Build sub-packages
FROM deps AS builder
COPY . .
RUN npm run build:packages \
  && npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

# Production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0

# ffmpeg is required by some workflow nodes at runtime.
RUN apk add --no-cache ffmpeg \
  && addgroup -S nodejs \
  && adduser -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/modules ./modules
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/packages/studio/package.json ./packages/studio/package.json
COPY --from=builder --chown=nextjs:nodejs /app/packages/studio/src ./packages/studio/src
COPY --from=builder --chown=nextjs:nodejs /app/packages/studio/dist ./packages/studio/dist
COPY --from=builder --chown=nextjs:nodejs /app/packages/Vibe-Workflow/packages/workflow-builder/package.json ./packages/Vibe-Workflow/packages/workflow-builder/package.json
COPY --from=builder --chown=nextjs:nodejs /app/packages/Vibe-Workflow/packages/workflow-builder/dist ./packages/Vibe-Workflow/packages/workflow-builder/dist
COPY --from=builder --chown=nextjs:nodejs /app/packages/Open-Poe-AI/packages/agents/package.json ./packages/Open-Poe-AI/packages/agents/package.json
COPY --from=builder --chown=nextjs:nodejs /app/packages/Open-Poe-AI/packages/agents/dist ./packages/Open-Poe-AI/packages/agents/dist
COPY --from=builder --chown=nextjs:nodejs /app/packages/Open-AI-Design-Agent/packages/design-agent/package.json ./packages/Open-AI-Design-Agent/packages/design-agent/package.json
COPY --from=builder --chown=nextjs:nodejs /app/packages/Open-AI-Design-Agent/packages/design-agent/dist ./packages/Open-AI-Design-Agent/packages/design-agent/dist

USER nextjs

EXPOSE 3000
CMD ["npm", "start"]
