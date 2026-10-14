export const PORTAL_CACHE_TAGS = [
  'portal:contents',
  'portal:movies',
  'portal:novels',
  'portal:comics',
] as const

export type PortalCacheTag = typeof PORTAL_CACHE_TAGS[number]
