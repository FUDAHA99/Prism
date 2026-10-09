export const dynamic = 'force-dynamic'

import type { Metadata } from 'next'
import { getNovels } from '@/lib/api'
import { parsePageParam } from '@/lib/page-param'
import PosterCard from '@/components/PosterCard'
import Pagination from '@/components/Pagination'

export const metadata: Metadata = { title: '小说' }

export default async function NovelsPage({
  searchParams,
}: { searchParams: { page?: string; q?: string } }) {
  // 地址栏里的 page 先收成后端认的值：后端对非法 page 返回 400，原样透传（NaN）会让整页显示「加载失败」
  const page = parsePageParam(searchParams.page)
  const list = await getNovels({ page, limit: 24, search: searchParams.q }).catch(() => null)
  const items = list?.data ?? []
  const meta = list?.meta

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-5">小说</h1>

      {!list ? (
        <div className="text-gray-500 text-sm py-12 text-center">加载失败</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500 text-sm py-12 text-center">暂无小说</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
          {items.map((n) => (
            <PosterCard
              key={n.id}
              href={`/novels/${n.slug}`}
              title={n.title}
              posterUrl={n.coverUrl}
              score={n.score}
              badge={n.serialStatus === 'finished' ? '完结' : null}
              remark={n.author ? `作者：${n.author}` : null}
              subtitle={n.chapterCount ? `${n.chapterCount} 章` : null}
            />
          ))}
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="mt-8">
          <Pagination
            currentPage={Number(meta.page)}
            totalPages={meta.totalPages}
            basePath="/novels"
          />
        </div>
      )}
    </div>
  )
}
