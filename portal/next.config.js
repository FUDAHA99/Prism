/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 允许加载后端上传的远程图片
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
  // 后端 API 代理（开发环境）
  async rewrites() {
    return [
      {
        source: '/proxy-api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3001'}/api/v1/:path*`,
      },
    ]
  },
}
module.exports = nextConfig
