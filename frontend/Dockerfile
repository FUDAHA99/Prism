# ─────────────────────────────────────────────────
# Stage 1: build
# ─────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# 生产构建（vite.config.ts 中 NODE_ENV=production 时 base='/admin/'）
RUN NODE_ENV=production npm run build

# ─────────────────────────────────────────────────
# Stage 2: nginx serve
# ─────────────────────────────────────────────────
FROM nginx:alpine AS runner

# 移除默认配置
RUN rm /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist         /usr/share/nginx/html
COPY              nginx.conf          /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
