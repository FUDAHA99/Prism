export const dynamic = 'force-dynamic'

import ArticleCard from '@/components/ArticleCard'
import Pagination from '@/components/Pagination'
import { getContents, getSiteConfig } from '@/lib/api'
import { clampListLimit, parsePageParam } from '@/lib/page-param'

export const revalidate = 30

interface Props {
  searchParams: { page?: string }
}

export const metadata = { title: '全部文章' }

export default async function ArticlesPage({ searchParams }: Props) {
  // 地址栏里的 page 先收成后端认的值（1–100000 的整数）：后端对非法 page 返回 400；接口出错时整页降级为「加载失败」
  const page = parsePageParam(searchParams.page)
  const config = await getSiteConfig().catch(() => null)
  const limit = clampListLimit(config?.postsPerPage)

  const list = await getContents({ page, limit }).catch(() => null)
  const articles = list?.data ?? []
  const totalPages = list?.meta.totalPages || 1

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">全部文章</h1>
        {list && <p className="text-sm text-gray-500 mt-1">共 {list.meta.total} 篇</p>}
      </div>

      {!list ? (
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          加载失败，请稍后刷新重试
        </div>
      ) : articles.length === 0 ? (
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          没有找到文章
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {articles.map((a) => (
            <ArticleCard key={a.id} article={a} />
          ))}
        </div>
      )}

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        basePath="/articles"
      />
    </div>
  )
}
