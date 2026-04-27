import { apiClient } from './client'

export type MovieType = 'movie' | 'tv' | 'variety' | 'anime' | 'short'
export type MovieStatus = 'draft' | 'published' | 'archived'
export type MovieSourceKind = 'play' | 'download'

export interface MovieEpisode {
  id: string
  sourceId: string
  title: string
  episodeNumber: number
  url: string
  durationSec?: number
  sortOrder: number
}

export interface MovieSource {
  id: string
  movieId: string
  name: string
  kind: MovieSourceKind
  player?: string
  sortOrder: number
  episodes?: MovieEpisode[]
}

export interface Movie {
  id: string
  title: string
  originalTitle?: string
  slug: string
  movieType: MovieType
  categoryId?: string
  subType?: string
  year?: number
  region?: string
  language?: string
  director?: string
  actors?: string
  intro?: string
  posterUrl?: string
  trailerUrl?: string
  duration?: number
  totalEpisodes?: number
  currentEpisode?: number
  isFinished: boolean
  score: number
  status: MovieStatus
  isFeatured: boolean
  isVip: boolean
  metaTitle?: string
  metaKeywords?: string
  metaDescription?: string
  viewCount: number
  likeCount: number
  collectSource?: string
  collectExternalId?: string
  publishedAt?: string
  createdAt: string
  updatedAt: string
  sources?: MovieSource[]
}

export interface MovieParams {
  search?: string
  status?: MovieStatus
  movieType?: MovieType
  categoryId?: string
  subType?: string
  region?: string
  year?: number
  isFeatured?: boolean
  isVip?: boolean
  page?: number
  limit?: number
}

export interface MoviePaginated {
  data: Movie[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export interface CreateMovieEpisodeData {
  title: string
  episodeNumber?: number
  url: string
  durationSec?: number
  sortOrder?: number
}

export interface CreateMovieSourceData {
  name: string
  kind?: MovieSourceKind
  player?: string
  sortOrder?: number
  episodes?: CreateMovieEpisodeData[]
}

export interface CreateMovieData {
  title: string
  originalTitle?: string
  slug: string
  movieType?: MovieType
  categoryId?: string
  subType?: string
  year?: number
  region?: string
  language?: string
  director?: string
  actors?: string
  intro?: string
  posterUrl?: string
  trailerUrl?: string
  duration?: number
  totalEpisodes?: number
  currentEpisode?: number
  isFinished?: boolean
  score?: number
  status?: MovieStatus
  isFeatured?: boolean
  isVip?: boolean
  metaTitle?: string
  metaKeywords?: string
  metaDescription?: string
  collectSource?: string
  collectExternalId?: string
  publishedAt?: string
  sources?: CreateMovieSourceData[]
}

export async function getMovies(params?: MovieParams): Promise<MoviePaginated> {
  const res = await apiClient.get<MoviePaginated>('/movies', { params })
  return res.data
}

export async function getMovie(id: string): Promise<Movie> {
  const res = await apiClient.get<Movie>(`/movies/${id}`)
  return res.data
}

export async function createMovie(data: CreateMovieData): Promise<Movie> {
  const res = await apiClient.post<Movie>('/movies', data)
  return res.data
}

export async function updateMovie(
  id: string,
  data: Partial<CreateMovieData>,
): Promise<Movie> {
  const res = await apiClient.patch<Movie>(`/movies/${id}`, data)
  return res.data
}

export async function publishMovie(id: string): Promise<Movie> {
  const res = await apiClient.post<Movie>(`/movies/${id}/publish`)
  return res.data
}

export async function unpublishMovie(id: string): Promise<Movie> {
  const res = await apiClient.post<Movie>(`/movies/${id}/unpublish`)
  return res.data
}

export async function deleteMovie(id: string): Promise<void> {
  await apiClient.delete(`/movies/${id}`)
}

// Sources / Episodes
export async function addMovieSource(
  movieId: string,
  data: CreateMovieSourceData,
): Promise<MovieSource> {
  const res = await apiClient.post<MovieSource>(`/movies/${movieId}/sources`, data)
  return res.data
}

export async function deleteMovieSource(sourceId: string): Promise<void> {
  await apiClient.delete(`/movies/sources/${sourceId}`)
}

export async function addMovieEpisode(
  sourceId: string,
  data: CreateMovieEpisodeData,
): Promise<MovieEpisode> {
  const res = await apiClient.post<MovieEpisode>(
    `/movies/sources/${sourceId}/episodes`,
    data,
  )
  return res.data
}

export async function updateMovieEpisode(
  episodeId: string,
  data: Partial<CreateMovieEpisodeData>,
): Promise<MovieEpisode> {
  const res = await apiClient.patch<MovieEpisode>(
    `/movies/episodes/${episodeId}`,
    data,
  )
  return res.data
}

export async function deleteMovieEpisode(episodeId: string): Promise<void> {
  await apiClient.delete(`/movies/episodes/${episodeId}`)
}
