'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Props {
  movieId: string
  movieSlug: string
  /** 第一集的默认跳转路径（无记录时用） */
  defaultHref: string
}

interface Progress {
  srcIdx: number
  epIdx: number
  episodeId: string | null
  progressSec: number
  durationSec: number | null
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getGuestId(): string {
  const key = 'cms_guest_id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

export default function ResumeButton({ movieId, movieSlug, defaultHref }: Props) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const fetchProgress = async () => {
      try {
        const token = localStorage.getItem('access_token')
        const guestId = getGuestId()

        const params = new URLSearchParams({
          contentType: 'movie',
          contentId: movieId,
          guestId,
        })

        const res = await fetch(`/api/v1/watch-history?${params}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        if (res.ok) {
          const data = await res.json()
          // 后端返回带 success/data 信封，axios 客户端自动剥离，但这里是原生 fetch
          const record = data?.data ?? data
          if (record && record.progressSec > 30) {
            setProgress(record)
            // 同步写入 localStorage，供播放页 PlayClient 读取（离线续播）
            const resumeKey = `resume_${movieId}_${record.srcIdx}_${record.epIdx}`
            localStorage.setItem(resumeKey, String(record.progressSec))
          }
        }
      } catch {
        // 网络失败，静默降级为"立即观看"
      } finally {
        setLoaded(true)
      }
    }

    fetchProgress()
  }, [movieId])

  // 未加载完成时显示默认按钮（防止 CLS 跳动）
  if (!loaded) {
    return (
      <Link
        href={defaultHref}
        className="inline-block px-6 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold shadow"
      >
        ▶ 立即观看
      </Link>
    )
  }

  if (progress && progress.progressSec > 30) {
    const resumeHref = `/movies/${movieSlug}/play/${progress.srcIdx}/${progress.epIdx}`
    const progressPct = progress.durationSec
      ? Math.round((progress.progressSec / progress.durationSec) * 100)
      : null

    return (
      <div className="flex flex-col gap-2">
        <Link
          href={resumeHref}
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold shadow"
        >
          <span>▶ 继续看</span>
          <span className="text-sm font-normal opacity-90">
            第 {progress.epIdx + 1} 集 {fmtTime(progress.progressSec)}
            {progressPct !== null && ` (${progressPct}%)`}
          </span>
        </Link>
        <Link
          href={defaultHref}
          className="text-xs text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
        >
          从头开始
        </Link>
      </div>
    )
  }

  return (
    <Link
      href={defaultHref}
      className="inline-block px-6 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold shadow"
    >
      ▶ 立即观看
    </Link>
  )
}
