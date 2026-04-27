import { getSiteConfig } from '@/lib/api'

export const revalidate = 60
export const metadata = { title: '关于' }

export default async function AboutPage() {
  const config = await getSiteConfig()
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <div className="bg-white rounded-lg p-8 shadow-sm">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">
          关于 {config.siteName}
        </h1>
        <p className="text-gray-700 leading-relaxed mb-4">
          {config.description ||
            '这是一个基于 NestJS + Next.js 的内容发布平台。'}
        </p>

        <div className="border-t border-gray-100 mt-6 pt-6 grid sm:grid-cols-2 gap-4 text-sm">
          <div>
            <h2 className="font-semibold text-gray-800 mb-2">技术栈</h2>
            <ul className="space-y-1 text-gray-600">
              <li>· 前端：Next.js 14 (App Router)</li>
              <li>· UI：Tailwind CSS</li>
              <li>· 后端：NestJS + TypeORM</li>
              <li>· 数据库：SQLite</li>
            </ul>
          </div>
          <div>
            <h2 className="font-semibold text-gray-800 mb-2">功能</h2>
            <ul className="space-y-1 text-gray-600">
              <li>· Markdown 文章发布</li>
              <li>· 分类 / 标签管理</li>
              <li>· 评论系统（支持审核）</li>
              <li>· SSR + SEO 友好</li>
            </ul>
          </div>
        </div>

        {config.icp && (
          <div className="mt-8 text-xs text-gray-400 text-center">
            备案号：{config.icp}
          </div>
        )}
      </div>
    </div>
  )
}
