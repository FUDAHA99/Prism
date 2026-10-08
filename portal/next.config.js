/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 生产部署：启用 standalone 输出以缩小镜像体积
  output: 'standalone',
  poweredByHeader: false, // 去掉 X-Powered-By: Next.js（nginx 侧另有 proxy_hide_header 兜底）
  // 全站只用原生 <img>，不使用 next/image（standalone 镜像也没装 sharp，优化器本就不可用）。
  // unoptimized 让 /_next/image 直接 404：不再是公网可达的出站抓取代理（SSRF/OOM），
  // 也让 14.x 无修复版的图片优化器 advisory（如 GHSA-2xp9-vwfh-vxw4）不可达。
  images: {
    unoptimized: true,
  },
}
module.exports = nextConfig
