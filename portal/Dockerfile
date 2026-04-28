# ─────────────────────────────────────────────────
# Stage 1: deps
# ─────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ─────────────────────────────────────────────────
# Stage 2: build
# ─────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建时注入公网 URL（客户端用），运行时内网 URL 通过 env 注入（服务端用）
ARG NEXT_PUBLIC_API_BASE=http://localhost:3001
ARG NEXT_PUBLIC_SITE_NAME=Prism
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME

RUN npm run build

# ─────────────────────────────────────────────────
# Stage 3: runner（使用 standalone 输出）
# ─────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static

USER nextjs
EXPOSE 3002

CMD ["node", "server.js"]
