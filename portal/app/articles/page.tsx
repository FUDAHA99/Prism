export const dynamic = 'force-dynamic'

import ArticleCard from '@/components/ArticleCard'
import Pagination from '@/components/Pagination'
import { getContents, getSiteConfig } from '@/lib/api'

export const revalidate = 30

interface Props {
  searchParams: { page?: string }
}

export const metadata = { title: '鍏ㄩ儴鏂囩珷' }

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
        <h1 className="text-2xl font-bold text-gray-900">鍏ㄩ儴鏂囩珷</h1>
        <p className="text-sm text-gray-500 mt-1">鍏?{total} 绡?/p>
      </div>

      {articles.length === 0 ? (
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          娌℃湁鎵惧埌鏂囩珷
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

