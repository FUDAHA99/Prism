import type { SiteConfig } from '@/lib/types'

export default function Footer({ config }: { config: SiteConfig }) {
  const year = new Date().getFullYear()
  return (
    <footer className="bg-white border-t border-gray-200 mt-16">
      <div className="max-w-6xl mx-auto px-4 py-8 text-center text-sm text-gray-500 space-y-2">
        <div>
          © {year} {config.siteName} · {config.description}
        </div>
        {config.icp && (
          <div>
            <a
              href="https://beian.miit.gov.cn"
              target="_blank"
              rel="noreferrer"
              className="hover:text-brand-600"
            >
              {config.icp}
            </a>
          </div>
        )}
        <div className="text-xs text-gray-400">
          Powered by Next.js 14 + NestJS · 基于 CMS 后端 API
        </div>
      </div>
    </footer>
  )
}
