import Link from 'next/link'
import type { Category, SiteConfig } from '@/lib/types'

interface Props {
  config: SiteConfig
  categories: Category[]
}

export default function Header({ config, categories }: Props) {
  // 仅展示前 6 个顶级分类，避免菜单溢出
  const topCats = categories.filter((c) => !c.parentId).slice(0, 6)

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          {config.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={config.logo} alt="logo" className="h-8 w-8 rounded" />
          ) : (
            <span className="h-8 w-8 rounded bg-brand-600 text-white flex items-center justify-center font-bold">
              {config.siteName.charAt(0)}
            </span>
          )}
          <span className="font-semibold text-lg text-gray-800">
            {config.siteName}
          </span>
        </Link>

        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="/"
            className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
          >
            首页
          </Link>
          <Link
            href="/movies"
            className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
          >
            影视
          </Link>
          <Link
            href="/novels"
            className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
          >
            小说
          </Link>
          <Link
            href="/comics"
            className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
          >
            漫画
          </Link>
          <Link
            href="/articles"
            className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
          >
            文章
          </Link>
          {topCats.map((cat) => (
            <Link
              key={cat.id}
              href={`/category/${cat.slug}`}
              className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
            >
              {cat.name}
            </Link>
          ))}
          <Link
            href="/about"
            className="px-3 py-2 rounded hover:bg-gray-100 text-gray-700"
          >
            关于
          </Link>
        </nav>
      </div>
    </header>
  )
}
