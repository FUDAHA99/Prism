# ─────────────────────────────────────────────────
# Stage 1: build
# ─────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# 安装依赖（含 devDependencies，编译需要）
COPY package*.json ./
RUN npm ci

# 复制源码并编译
COPY . .
RUN npm run build

# 裁剪 devDependencies
RUN npm prune --production

# ─────────────────────────────────────────────────
# Stage 2: runner
# ─────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nestjs

# 只复制生产必要文件
COPY --from=builder --chown=nestjs:nodejs /app/dist        ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
# seed 脚本（首次部署初始化管理员用）
COPY --from=builder --chown=nestjs:nodejs /app/scripts     ./scripts

# 上传目录（需持久化卷挂载）
RUN mkdir -p uploads && chown nestjs:nodejs uploads

USER nestjs
EXPOSE 3001

CMD ["node", "dist/main"]
