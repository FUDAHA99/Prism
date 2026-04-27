import './globals.css'
import type { Metadata } from 'next'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import { getCategories, getSiteConfig } from '@/lib/api'

export async function generateMetadata(): Promise<Metadata> {
  const config = await getSiteConfig().catch(() => null)
  return {
    title: {
      default: config?.siteName || 'METU 内容站',
      template: `%s | ${config?.siteName || 'METU'}`,
    },
    description: config?.description || '一个内容平台',
    icons: config?.favicon ? [{ rel: 'icon', url: config.favicon }] : undefined,
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // 全局 layout 拉一次站点配置和分类列表（用于导航）
  const [config, categories] = await Promise.all([
    getSiteConfig().catch(() => ({
      siteName: 'METU 内容站',
      description: '一个内容平台',
      logo: '',
      favicon: '',
      icp: '',
      enableComment: true,
      commentAudit: true,
      postsPerPage: 10,
    })),
    getCategories().catch(() => []),
  ])

  return (
    <html lang="zh-CN">
      <body className="min-h-screen flex flex-col">
        <Header config={config} categories={categories} />
        <main className="flex-1">{children}</main>
        <Footer config={config} />
      </body>
    </html>
  )
}
