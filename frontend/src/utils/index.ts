import dayjs from 'dayjs'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatDate(date: string | Date, format = 'YYYY-MM-DD HH:mm'): string {
  return dayjs(date).format(format)
}

export function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf') return 'file-pdf'
  if (mimeType.startsWith('text/')) return 'file-text'
  return 'file'
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + '...'
}

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u4e00-\u9fa5]+/g, (match) =>
      Array.from(match)
        .map((char) => char.charCodeAt(0).toString(16))
        .join('-')
    )
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
