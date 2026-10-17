import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkMovieSource, type MovieEpisode, type MovieSource, type MovieSourceCheckResult } from '../../api/movie'
import { checkSourceSnapshot, sourceCheckSnapshot } from './source-http-check'

vi.mock('../../api/movie', () => ({ checkMovieSource: vi.fn() }))
const check = vi.mocked(checkMovieSource)
const episode = (id: string, episodeNumber: number): MovieEpisode => ({
  id, sourceId: 'source-1', title: `集 ${id}`, episodeNumber, sortOrder: 0, url: `https://media.example/${id}.mp4`,
})
const source = (episodes = [episode('b', 1), episode('a', 1), episode('c', 2)]): MovieSource => ({
  id: 'source-1', movieId: 'movie-1', name: '线路', kind: 'play', sortOrder: 0, episodes,
})
const result = (patch: Partial<MovieSourceCheckResult> = {}): MovieSourceCheckResult => ({
  sourceId: 'source-1', checkedAt: '2026-10-17T00:00:00.000Z', status: 'responded',
  message: '样本地址已响应', httpStatus: 200, sample: { id: 'a', title: '集 a', episodeNumber: 1 }, ...patch,
})
const deferred = () => {
  let resolve!: (value: MovieSourceCheckResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<MovieSourceCheckResult>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => { check.mockReset() })

describe('movie source check snapshot', () => {
  it('selects episodeNumber then id without mutating the existing episode order', () => {
    const value = source([episode('c', 2), episode('b', 1), episode('a', 1)])
    expect(sourceCheckSnapshot('movie-1', value).sampleId).toBe('a')
    expect(value.episodes?.map(item => item.id)).toEqual(['c', 'b', 'a'])
    expect(sourceCheckSnapshot('movie-1', source([])).sampleId).toBeNull()
  })

  it('changes the component key for another movie, source, kind, order, or first sample', () => {
    const value = source([episode('a', 1)])
    const original = sourceCheckSnapshot('movie-1', value).key
    expect(sourceCheckSnapshot('movie-2', value).key).not.toBe(original)
    for (const patch of [{ id: 'source-2' }, { kind: 'download' as const }, { sortOrder: 2 }]) {
      expect(sourceCheckSnapshot('movie-1', { ...value, ...patch }).key).not.toBe(original)
    }
    for (const patch of [{ id: 'replacement' }, { url: 'https://media.example/new.mp4' }, { episodeNumber: 2 }, { sortOrder: 2 }, { title: '改名' }]) {
      expect(sourceCheckSnapshot('movie-1', source([{ ...episode('a', 1), ...patch }])).key).not.toBe(original)
    }
    expect(sourceCheckSnapshot('movie-1', source([])).key).not.toBe(original)
    expect(sourceCheckSnapshot('movie-1', source([episode('a', 1), episode('new', 0)])).key).not.toBe(original)
  })

  it('keeps the key for an unrelated data refresh with the same first sample', () => {
    const value = source()
    expect(sourceCheckSnapshot('movie-1', { ...value, episodes: [...value.episodes!].reverse() }).key)
      .toBe(sourceCheckSnapshot('movie-1', value).key)
  })
})

describe('movie source check request lifecycle', () => {
  it('passes the card signal and returns the matching sample response', async () => {
    const response = result()
    check.mockResolvedValue(response)
    const controller = new AbortController()
    expect(await checkSourceSnapshot('source-1', 'a', controller.signal)).toEqual(response)
    expect(check).toHaveBeenCalledExactlyOnceWith('source-1', controller.signal)
  })

  it('does not start a check for an already cancelled card', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await checkSourceSnapshot('source-1', 'a', controller.signal)).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('discards a late %s after the old card is cancelled', async (settle) => {
    const pending = deferred()
    check.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const request = checkSourceSnapshot('source-1', 'a', controller.signal)
    controller.abort()
    if (settle === 'resolve') pending.resolve(result())
    else pending.reject(new Error('旧请求失败'))
    expect(await request).toBeNull()
  })

  it.each([
    { sourceId: 'other-source' },
    { sample: { id: 'other-episode', title: '其他集', episodeNumber: 2 } },
    { sample: null },
    { status: 'stale' as const },
  ])('discards HTTP and sample details for a stale or mismatched response %j', async (patch) => {
    check.mockResolvedValue(result(patch))
    expect(await checkSourceSnapshot('source-1', 'a', new AbortController().signal)).toEqual(result({
      status: 'stale', sample: null, httpStatus: null, message: '线路或首个剧集已变更，请刷新后重新检测',
    }))
  })

  it.each([null, { id: 'a', title: '首集', episodeNumber: 1 }])('preserves not-applicable only when its sample matches %j', async (sample) => {
    const response = result({ status: 'not_applicable', sample, httpStatus: null, message: '没有可检查的 HTTP 样本' })
    check.mockResolvedValue(response)
    expect(await checkSourceSnapshot('source-1', sample?.id ?? null, new AbortController().signal)).toEqual(response)
  })

  it('retains an active request failure for the current card to display', async () => {
    const error = new Error('该线路正在检测，请稍后重试')
    check.mockRejectedValue(error)
    await expect(checkSourceSnapshot('source-1', 'a', new AbortController().signal)).rejects.toBe(error)
  })
})
