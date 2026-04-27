import ArticleCard from '@/components/ArticleCard'
import Pagination from '@/components/Pagination'
import { getContents, getSiteConfig } from '@/lib/api'

export const revalidate = 30

interface Props {
  searchParams: { page?: string }
}

export const metadata = { title: '全部文章' }

export default async function ArticlesPage({ searchParams }: Props) {
  const page = Math.max(1, Number(searchParams.page) || 1)
  const config = await getSiteConfig().catch(() => ({ postsPerPage: 10 } as any))
  const limit = config.postsPerPage || 10

  const list = await getContents({ page, limit })
  const articles = list.data
  const totalPages = list.meta.totalPages || 1
  const total = list.meta.total

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">全部文章</h1>
        <p className="text-sm text-gray-500 mt-1">共 {total} 篇</p>
      </div>

      {articles.length === 0 ? (
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
