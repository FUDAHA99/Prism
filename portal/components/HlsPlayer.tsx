'use client'

import { useEffect, useRef, useState } from 'react'
import { safeExternalHref, safeMediaSrc } from '@/lib/safe-url'

/** MediaError.code → 提示文字 */
const NATIVE_ERROR_TEXT: Record<number, string> = {
  1: '已中止',
  2: '网络错误',
  3: '解码失败',
  4: '格式不支持或地址无法访问',
}

interface Props {
  src: string
  poster?: string | null
  autoPlay?: boolean
  /** 从第几秒开始播放（续播用） */
  initialTime?: number
  /** 播放进度回调，每次 timeupdate 触发 */
  onTimeUpdate?: (currentTime: number, duration: number) => void
}

/**
 * 自适应播放器：
 *  - .m3u8 用 hls.js 播放（不支持原生 HLS 的浏览器，主要是非 Safari）
 *  - Safari / iOS 直接 <video src=…m3u8>，原生支持
 *  - 其他扩展名走原生 video
 *  - 地址只认 http(s) 与以 / 开头的（safeMediaSrc），其他协议直接显示「无法播放」、不交给 video / hls.js；
 *    播放失败时的「用外部播放器打开」链接只在 http(s) 绝对地址时渲染（safeExternalHref）
 */
export default function HlsPlayer({
  src,
  poster,
  autoPlay = true,
  initialTime = 0,
  onTimeUpdate,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 用 ref 存 callback，避免 effect 重跑
  const onTimeUpdateRef = useRef(onTimeUpdate)
  onTimeUpdateRef.current = onTimeUpdate
  const playSrc = safeMediaSrc(src)
  const externalHref = safeExternalHref(playSrc)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!playSrc) {
      setError('播放地址无效')
      setLoading(false)
      return
    }
    const url = playSrc

    setError(null)
    setLoading(true)

    const isHls = /\.m3u8(\?|$)/i.test(url)
    let hls: any = null
    let cancelled = false

    const onCanPlay = () => {
      setLoading(false)
      // 续播跳转
      if (initialTime > 5) {
        video.currentTime = initialTime
      }
    }

    const handleTimeUpdate = () => {
      if (onTimeUpdateRef.current && video.duration > 0) {
        onTimeUpdateRef.current(video.currentTime, video.duration)
      }
    }

    // 原生播放（Safari，以及 canPlayType 报支持 HLS 的新版 Chromium）失败时 <video> 只触发 error 事件：
    // 不监听的话会一直停在「加载中…」，外部播放器链接也出不来。hls.js 路径只认它上报的致命错误（见下方 Hls.Events.ERROR），不挂这个监听
    const onNativeError = () => {
      if (cancelled) return
      const code = video.error?.code ?? 0
      setError(`播放失败: ${NATIVE_ERROR_TEXT[code] ?? '未知错误'}`)
      setLoading(false)
    }

    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('timeupdate', handleTimeUpdate)

    const cleanup = () => {
      cancelled = true
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('error', onNativeError)
      if (hls) { try { hls.destroy() } catch {} }
    }

    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      // 非原生 HLS → 用 hls.js
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: true, lowLatencyMode: false })
          hls.loadSource(url)
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
      video.addEventListener('error', onNativeError)
      video.src = url
      if (autoPlay) video.play().catch(() => {})
    }

    return cleanup
  }, [playSrc, autoPlay, initialTime])

  return (
    <div className="relative w-full bg-black aspect-video rounded overflow-hidden">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={safeMediaSrc(poster)}
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
          {externalHref && (
            <a href={externalHref} target="_blank" rel="noopener noreferrer"
               className="mt-3 px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 text-xs">
              尝试用外部播放器打开
            </a>
          )}
        </div>
      )}
    </div>
  )
}
