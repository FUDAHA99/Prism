import { checkMovieSource, type MovieSource, type MovieSourceCheckResult } from '../../api/movie'

/** 与服务端一样按集数、ID 抽取首集；不改变页面原有剧集顺序。 */
export function sourceCheckSnapshot(movieId: string, source: MovieSource) {
  const sample = [...(source.episodes ?? [])].sort((a, b) =>
    a.episodeNumber - b.episodeNumber || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0]
  return {
    sampleId: sample?.id ?? null,
    key: JSON.stringify([
      movieId, source.id, source.kind, source.sortOrder,
      sample?.id, sample?.url, sample?.episodeNumber, sample?.sortOrder, sample?.title,
    ]),
  }
}

/** 卸载时取消请求；即使传输层仍返回，旧卡片也不能接收结果或错误。 */
export async function checkSourceSnapshot(
  sourceId: string,
  sampleId: string | null,
  signal: AbortSignal,
): Promise<MovieSourceCheckResult | null> {
  if (signal.aborted) return null
  let result: MovieSourceCheckResult
  try {
    result = await checkMovieSource(sourceId, signal)
  } catch (error) {
    if (signal.aborted) return null
    throw error
  }
  if (signal.aborted) return null
  if (result.status === 'stale' || result.sourceId !== sourceId || (result.sample?.id ?? null) !== sampleId) {
    return {
      sourceId, checkedAt: result.checkedAt, status: 'stale', httpStatus: null, sample: null,
      message: '线路或首个剧集已变更，请刷新后重新检测',
    }
  }
  return result
}
