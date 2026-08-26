'use client'

import { useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import HlsPlayer from '@/components/HlsPlayer'
import { friendlySourceName } from '@/lib/movie-utils'
import type { Movie, MovieSource, MovieEpisode } from '@/lib/types'

interface Props {
  movie: Movie
  srcIdx: number
  epIdx: number
  source: MovieSource
  episode: MovieEpisode
}

/** 获取或生成游客 ID */
function getGuestId(): string {
  const key = 'cms_guest_id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

/** 格式化秒数为 mm:ss */
function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function PlayClient({ movie, srcIdx, epIdx, source, episode }: Props) {
  const sources = movie.sources ?? []
  const lastReportedRef = useRef<number>(0)
  const reportTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentTimeRef = useRef<number>(0)
  const durationRef = useRef<number>(0)

  // 读取续播时间（从 localStorage，由 ResumeButton 写入）
  const resumeKey = `resume_${movie.id}_${srcIdx}_${epIdx}`
  const initialTime = (() => {
    if (typeof window === 'undefined') return 0
    return parseInt(localStorage.getItem(resumeKey) ?? '0', 10) || 0
  })()

  /** 上报进度到后端 */
  const reportProgress = useCallback(
    async (progressSec: number, durationSec: number) => {
      if (progressSec < 5) return // 刚开始不上报

      const token = localStorage.getItem('access_token')
      const guestId = getGuestId()

      try {
        await fetch('/api/v1/watch-history/report', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            contentType: 'movie',
            contentId: movie.id,
            episodeId: episode.id,
            srcIdx,
            epIdx,
            progressSec: Math.round(progressSec),
            durationSec: Math.round(durationSec),
            guestId,
          }),
        })

        // 同时写入 localStorage 供 ResumeButton 读取（离线也能用）
        localStorage.setItem(resumeKey, String(Math.round(progressSec)))
        lastReportedRef.current = progressSec
      } catch {
        // 网络失败静默处理
      }
    },
    [movie.id, episode.id, srcIdx, epIdx, resumeKey],
  )

  /** HlsPlayer timeupdate 回调（高频触发，节流处理） */
  const handleTimeUpdate = useCallback(
    (currentTime: number, duration: number) => {
      currentTimeRef.current = currentTime
      durationRef.current = duration
    },
    [],
  )

  /** 定时每 15 秒上报一次 */
  useEffect(() => {
    reportTimerRef.current = setInterval(() => {
      const t = currentTimeRef.current
      const d = durationRef.current
      if (d > 0 && t > 0 && Math.abs(t - lastReportedRef.current) > 5) {
        reportProgress(t, d)
      }
    }, 15_000)

    return () => {
      if (reportTimerRef.current) clearInterval(reportTimerRef.current)
      // 页面卸载时立即上报最后进度
      const t = currentTimeRef.current
      const d = durationRef.current
      if (d > 0 && t > 0) reportProgress(t, d)
    }
  }, [reportProgress])

  return (
    <div className="bg-gray-900 min-h-screen">
      <div className="max-w-6xl mx-auto px-3 py-4">
        {/* 面包屑 */}
        <div className="text-sm text-gray-400 mb-2">
          <Link href="/" className="hover:text-white">首页</Link>
          <span className="mx-1">/</span>
          <Link href="/movies" className="hover:text-white">影视</Link>
          <span className="mx-1">/</span>
          <Link href={`/movies/${movie.slug}`} className="hover:text-white">{movie.title}</Link>
          <span className="mx-1">/</span>
          <span className="text-gray-200">{episode.title}</span>
        </div>

        {/* 播放器 */}
        <HlsPlayer
          src={episode.url}
          poster={movie.posterUrl}
          initialTime={initialTime}
          onTimeUpdate={handleTimeUpdate}
        />

        {/* 续播提示 */}
        {initialTime > 30 && (
          <div className="mt-2 text-xs text-gray-400 text-center">
            已从 {fmtTime(initialTime)} 继续播放
          </div>
        )}

        {/* 标题/状态 */}
        <div className="mt-3 text-white">
          <h1 className="text-lg font-semibold">
            {movie.title}
            <span className="ml-2 text-sm text-gray-400">{episode.title}</span>
          </h1>
          <div className="text-xs text-gray-400 mt-1">
            当前线路：{friendlySourceName(source.name, srcIdx)} · 共 {source.episodes?.length ?? 0} 集
          </div>
        </div>

        {/* 上一集 / 下一集 */}
        <div className="mt-3 flex items-center gap-2 text-sm">
          {epIdx > 0 ? (
            <Link
              href={`/movies/${movie.slug}/play/${srcIdx}/${epIdx - 1}`}
              className="px-3 py-1.5 rounded bg-gray-800 text-gray-200 hover:bg-gray-700"
            >
              ← 上一集
            </Link>
          ) : (
            <span className="px-3 py-1.5 rounded bg-gray-800 text-gray-500">← 上一集</span>
          )}
          {source.episodes && epIdx < source.episodes.length - 1 ? (
            <Link
              href={`/movies/${movie.slug}/play/${srcIdx}/${epIdx + 1}`}
              className="px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700"
            >
              下一集 →
            </Link>
          ) : (
            <span className="px-3 py-1.5 rounded bg-gray-800 text-gray-500">下一集 →</span>
          )}
          <Link
            href={`/movies/${movie.slug}`}
            className="px-3 py-1.5 rounded bg-gray-800 text-gray-200 hover:bg-gray-700 ml-auto"
          >
            返回详情
          </Link>
        </div>

        {/* 线路切换 */}
        {sources.length > 1 && (
          <div className="mt-5">
            <div className="text-sm text-gray-300 mb-2">切换线路：</div>
            <div className="flex flex-wrap gap-2">
              {sources.map((s, i) => (
                <Link
                  key={s.id}
                  href={`/movies/${movie.slug}/play/${i}/0`}
                  className={`px-3 py-1.5 text-sm rounded ${
                    i === srcIdx
                      ? 'bg-brand-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {friendlySourceName(s.name, i)}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* 剧集列表 */}
        <div className="mt-5">
          <div className="text-sm text-gray-300 mb-2">
            {friendlySourceName(source.name, srcIdx)} · 共 {source.episodes?.length ?? 0} 集
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-10 gap-2">
            {(source.episodes ?? []).map((ep, i) => (
              <Link
                key={ep.id}
                href={`/movies/${movie.slug}/play/${srcIdx}/${i}`}
                className={`px-2 py-1.5 text-sm text-center rounded truncate ${
                  i === epIdx
                    ? 'bg-brand-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
                title={ep.title}
              >
                {ep.title}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
