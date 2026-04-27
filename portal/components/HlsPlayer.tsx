'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  src: string
  poster?: string | null
  autoPlay?: boolean
}

/**
 * 自适应播放器：
 *  - .m3u8 用 hls.js 播放（不支持原生 HLS 的浏览器，主要是非 Safari）
 *  - Safari / iOS 直接 <video src=…m3u8>，原生支持
 *  - 其他扩展名走原生 video
 */
export default function HlsPlayer({ src, poster, autoPlay = true }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    setError(null)
    setLoading(true)

    const isHls = /\.m3u8(\?|$)/i.test(src)
    let hls: any = null
    let cancelled = false

    const onCanPlay = () => setLoading(false)
    video.addEventListener('canplay', onCanPlay)

    const cleanup = () => {
      cancelled = true
      video.removeEventListener('canplay', onCanPlay)
      if (hls) { try { hls.destroy() } catch {} }
    }

    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      // 非原生 HLS → 用 hls.js
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true, lowLatencyMode: false })
          hls.loadSource(src)
          hls.attachMedia(video)
          hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
            if (data.fatal) {
              setError(`播放失败: ${data.type} / ${data.details}`)
              setLoading(false)
            }
          })
          if (autoPlay) hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
        } else {
          setError('当前浏览器不支持 HLS 播放')
          setLoading(false)
        }
      }).catch((e) => {
        setError(`hls.js 加载失败: ${e?.message || e}`)
        setLoading(false)
      })
    } else {
      // 原生支持
      video.src = src
      if (autoPlay) video.play().catch(() => {})
    }

    return cleanup
  }, [src, autoPlay])

  return (
    <div className="relative w-full bg-black aspect-video rounded overflow-hidden">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={poster ?? undefined}
        className="absolute inset-0 w-full h-full"
      />
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm pointer-events-none">
          加载中…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white/90 text-sm bg-black/70 px-6 text-center">
          <div className="text-base font-semibold mb-1">⚠️ 无法播放</div>
          <div className="text-xs opacity-80 break-all">{error}</div>
          <a href={src} target="_blank" rel="noreferrer"
             className="mt-3 px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 text-xs">
            尝试用外部播放器打开
          </a>
        </div>
      )}
    </div>
  )
}
