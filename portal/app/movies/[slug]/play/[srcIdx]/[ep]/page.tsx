export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getMovieBySlug } from '@/lib/api'
import PlayClient from './PlayClient'

interface Props {
  params: { slug: string; srcIdx: string; ep: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const m = await getMovieBySlug(params.slug)
  if (!m) return { title: '播放页' }
  const sources = m.sources ?? []
  const ep = sources[parseInt(params.srcIdx)]?.episodes?.[parseInt(params.ep)]
  return {
    title: ep ? `${m.title} - ${ep.title} - 在线播放` : `${m.title} - 在线播放`,
  }
}

export default async function PlayPage({ params }: Props) {
  const movie = await getMovieBySlug(params.slug)
  if (!movie) notFound()

  const sources = movie.sources ?? []
  const srcIdx = parseInt(params.srcIdx, 10)
  const epIdx = parseInt(params.ep, 10)
  const source = sources[srcIdx]
  const episode = source?.episodes?.[epIdx]

  if (!source || !episode) notFound()

  return (
    <PlayClient
      movie={movie}
      srcIdx={srcIdx}
      epIdx={epIdx}
      source={source}
      episode={episode}
    />
  )
}
