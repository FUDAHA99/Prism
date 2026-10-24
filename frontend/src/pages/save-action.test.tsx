import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ContentForm from './Content/ContentForm'
import MovieForm from './Movie/MovieForm'
import NovelForm from './Novel/NovelForm'
import ComicForm from './Comic/ComicForm'

const state = vi.hoisted(() => ({
  id: 'record-1' as string | undefined,
  status: 'draft',
}))

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: state.id }),
  useNavigate: () => vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === 'categories' ? [] : state.id ? { id: state.id, status: state.status, sources: [] } : undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('../components/editor/MarkdownEditor', () => ({ default: () => null }))
vi.mock('../components/media/MediaPicker', () => ({ default: () => null }))

beforeEach(() => {
  state.id = 'record-1'
  state.status = 'draft'
})

describe.each([
  ['内容', ContentForm],
  ['影视', MovieForm],
  ['小说', NovelForm],
  ['漫画', ComicForm],
] as const)('%s 保存动作', (_name, FormComponent) => {
  it.each([
    ['published', '保存修改（立即生效）'],
    ['archived', '保存修改'],
    ['draft', '保存草稿'],
  ])('编辑 %s 时准确说明保存的效果', (status, label) => {
    state.status = status
    const html = renderToStaticMarkup(createElement(FormComponent))
    expect(html).toContain(label)
    if (status !== 'draft') expect(html).not.toContain('保存草稿')
  })

  it('创建时仍允许保存草稿', () => {
    state.id = undefined
    const html = renderToStaticMarkup(createElement(FormComponent))
    expect(html).toContain('保存草稿')
    expect(html).not.toContain('保存修改（立即生效）')
  })
})
