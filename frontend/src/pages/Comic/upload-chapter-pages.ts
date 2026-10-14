import { uploadFile, UPLOAD_MAX_SIZE } from '../../api/media'

/** 一次选图最多同时上传三张；成功项按选择顺序返回，取消后不再启动排队文件。 */
export async function uploadChapterPages(
  files: File[],
  signal: AbortSignal,
  onError: (text: string) => void,
): Promise<string[]> {
  const urls: Array<string | undefined> = new Array(files.length)
  let next = 0

  const worker = async () => {
    while (!signal.aborted && next < files.length) {
      const index = next++
      const file = files[index]
      if (file.size > UPLOAD_MAX_SIZE) {
        onError(`${file.name} 超过 10MB，已忽略`)
        continue
      }
      try {
        const media = await uploadFile(file, signal)
        if (signal.aborted) return
        const url = media.data?.url ?? (media as unknown as { url?: string }).url
        if (typeof url !== 'string' || !url.trim()) throw new Error('未返回图片地址')
        urls[index] = url
      } catch (error) {
        if (!signal.aborted) {
          onError(`${file.name} 上传失败${error instanceof Error && error.message ? '：' + error.message : ''}`)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker))
  return signal.aborted ? [] : urls.filter((url): url is string => url !== undefined)
}
