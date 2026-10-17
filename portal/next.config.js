/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 生产部署：启用 standalone 输出以缩小镜像体积
  output: 'standalone',
  poweredByHeader: false, // 去掉 X-Powered-By: Next.js（nginx 侧另有 proxy_hide_header 兜底）
  // 全站只用原生 <img>，不使用 next/image；即使 Next 依赖包含 sharp，也显式关闭图片优化器。
  // unoptimized 让 /_next/image 直接 404：不再是公网可达的出站抓取代理（SSRF/OOM），
  // 也让 14.x 无修复版的图片优化器 advisory（如 GHSA-2xp9-vwfh-vxw4）不可达。
  images: {
    unoptimized: true,
  },
  async rewrites() {
    // 开发时没有 nginx，由 Next 转发上传、续播和搜索上报；生产继续由 nginx 提供这些路由。
    if (process.env.NODE_ENV !== 'development') return []
    const backend = (
      process.env.BACKEND_INTERNAL_URL ||
      process.env.NEXT_PUBLIC_API_BASE ||
      'http://localhost:3001'
    ).replace(/\/+$/, '')
    return [
      { source: '/uploads/:path*', destination: `${backend}/uploads/:path*` },
      { source: '/api/v1/watch-history/:path*', destination: `${backend}/api/v1/watch-history/:path*` },
      { source: '/api/v1/stats/search-keywords', destination: `${backend}/api/v1/stats/search-keywords` },
    ]
  },
}
module.exports = nextConfig
