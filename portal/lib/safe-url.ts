/**
 * 门户把后端数据里的地址渲染成 href / src 之前统一过这里。
 *
 * 这些地址（海报、封面、页面图、剧集地址、站点 Logo 等）有的来自第三方资源站的采集，有的是后台录入；
 * 后端写入与公开视图已经各自过滤过一遍，这里是门户侧的最后一道：规则上线前已经入库的旧数据、
 * 以及后端将来漏掉的地址，都不能变成可点击的 javascript: 链接或别的协议。门户与后台同源，
 * localStorage 里存着后台的 access_token。React 18 对 javascript: 的 href 只在控制台告警，不会拦截。
 */

/** 新窗口打开的外部链接：只认 http(s) 绝对地址，其余（javascript: / data: / 站内相对路径 / 磁力链等）不给链接 */
const EXTERNAL_HREF = /^https?:\/\//i

export function safeExternalHref(url: unknown): string | undefined {
  return typeof url === 'string' && EXTERNAL_HREF.test(url) ? url : undefined
}

/**
 * 图片 / 视频的 src：http(s) 绝对地址，或以 / 开头（站内路径 /uploads/…、协议相对 //cdn/…），
 * 与后端公开视图对剧集地址的过滤一致（movie.service.ts isPublicEpisodeUrl）。去首尾空白后判断；
 * 不合格的返回 undefined，调用方按「没有图」处理（显示占位）。
 */
const MEDIA_SRC = /^(?:https?:\/\/|\/)/i

export function safeMediaSrc(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const value = url.trim()
  return MEDIA_SRC.test(value) ? value : undefined
}
