import Link from 'next/link'

interface Props {
  href: string
  title: string
  posterUrl?: string | null
  badge?: string | null    // 右上角小角标(如：HD / 全25集 / 完结)
  remark?: string | null   // 海报底部条(如：第10集 / 已完结)
  score?: number | string | null
  subtitle?: string | null // 副标题（如年份·地区）
  size?: 'sm' | 'md'
}

export default function PosterCard({
  href, title, posterUrl, badge, remark, score, subtitle, size = 'md',
}: Props) {
  const aspect = 'aspect-[3/4]' // 海报比例
  const titleCls = size === 'sm' ? 'text-sm' : 'text-base'

  const hasScore = score != null && Number(score) > 0

  return (
    <Link
      href={href}
      className="group block rounded-lg overflow-hidden bg-gray-100 shadow-sm hover:shadow-lg transition"
    >
      <div className={`relative w-full ${aspect} bg-gray-200 overflow-hidden`}>
        {posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={posterUrl}
            alt={title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">
            无封面
          </div>
        )}

        {badge && (
          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500 text-white shadow">
            {badge}
          </span>
        )}

        {hasScore && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 text-[11px] font-bold rounded bg-black/70 text-amber-300">
            ★ {Number(score).toFixed(1)}
          </span>
        )}

        {remark && (
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent text-white text-xs px-2 py-1.5 truncate">
            {remark}
          </div>
        )}
      </div>

      <div className="p-2">
        <div
          className={`${titleCls} font-medium text-gray-900 truncate group-hover:text-brand-600 transition`}
          title={title}
        >
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</div>
        )}
      </div>
    </Link>
  )
}
