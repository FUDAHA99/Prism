export const dynamic = 'force-dynamic'

import type { Metadata } from 'next'
import { getNovels } from '@/lib/api'
import PosterCard from '@/components/PosterCard'
import Pagination from '@/components/Pagination'

export const metadata: Metadata = { title: '灏忚' }

export default async function NovelsPage({
  searchParams,
}: { searchParams: { page?: string; q?: string } }) {
  const page = Math.max(1, parseInt(searchParams.page || '1', 10))
  const list = await getNovels({ page, limit: 24, search: searchParams.q }).catch(() => null)
  const items = list?.data ?? []
  const meta = list?.meta

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-5">灏忚</h1>

      {!list ? (
        <div className="text-gray-500 text-sm py-12 text-center">鍔犺浇澶辫触</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500 text-sm py-12 text-center">鏆傛棤灏忚</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
          {items.map((n) => (
            <PosterCard
              key={n.id}
              href={`/novels/${n.slug}`}
              title={n.title}
              posterUrl={n.coverUrl}
              score={n.score}
              badge={n.serialStatus === 'finished' ? '瀹岀粨' : null}
              remark={n.author ? `浣滆€咃細${n.author}` : null}
              subtitle={n.chapterCount ? `${n.chapterCount} 绔燻 : null}
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

