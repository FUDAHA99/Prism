import { App, Form, type FormInstance } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MovieForm from './Movie/MovieForm'

const state = vi.hoisted(() => ({
  id: 'movie-a' as string | undefined,
  movie: undefined as { id: string; title: string; intro: string; sources: unknown[] } | undefined,
  initialized: { current: undefined as string | undefined },
  effect: undefined as (() => void) | undefined,
  values: {} as Record<string, unknown>,
}))

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: () => state.initialized,
  useEffect: (effect: () => void) => { state.effect = effect },
}))
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: state.id }), useNavigate: () => vi.fn() }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.movie, isLoading: Boolean(state.id && !state.movie), isError: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

const form = {
  setFieldsValue: vi.fn((values: Record<string, unknown>) => Object.assign(state.values, values)),
  resetFields: vi.fn(() => { state.values = {} }),
}

beforeEach(() => {
  state.id = 'movie-a'
  state.movie = { id: 'movie-a', title: '影视 A', intro: '服务器简介 A', sources: [] }
  state.initialized.current = undefined
  state.effect = undefined
  state.values = {}
  form.setFieldsValue.mockClear()
  form.resetFields.mockClear()
  vi.spyOn(Form, 'useForm').mockReturnValue([form as unknown as FormInstance])
  vi.spyOn(App, 'useApp').mockReturnValue({} as ReturnType<typeof App.useApp>)
})

afterEach(() => vi.restoreAllMocks())

// 执行真实根组件的初始化 effect；子组件不挂载，不需要新增 DOM 测试依赖。
function initialize() {
  MovieForm()
  expect(state.effect).toBeTypeOf('function')
  state.effect!()
}

describe('MovieForm 初始化与线路刷新', () => {
  it('首次回填后，同记录的线路/剧集刷新保留尚未保存的基本信息', () => {
    initialize()
    expect(state.values).toMatchObject({ title: '影视 A', intro: '服务器简介 A' })
    state.values.intro = '尚未保存的新简介'
    state.values.title = '尚未保存的新标题'
    state.movie = { ...state.movie!, sources: [{ id: 'new-source', episodes: [{ id: 'new-episode' }] }] }
    initialize()
    expect(state.values).toMatchObject({ title: '尚未保存的新标题', intro: '尚未保存的新简介' })
    expect(form.setFieldsValue).toHaveBeenCalledTimes(1)
  })

  it('切换记录后等待新数据，并用新记录初始化表单', () => {
    initialize()
    state.values.intro = '未保存 A'
    state.id = 'movie-b'
    state.movie = undefined
    initialize()
    expect(form.setFieldsValue).toHaveBeenCalledTimes(1)
    state.movie = { id: 'movie-b', title: '影视 B', intro: '服务器简介 B', sources: [] }
    initialize()
    expect(state.values).toMatchObject({ title: '影视 B', intro: '服务器简介 B' })
    expect(form.setFieldsValue).toHaveBeenCalledTimes(2)
  })

  it('路由已切换时不使用旧记录的迟到查询结果初始化', () => {
    initialize()
    state.id = 'movie-b'
    state.movie = { ...state.movie!, intro: '迟到的 A' }
    initialize()
    expect(form.setFieldsValue).toHaveBeenCalledTimes(1)
  })

  it('返回新建页清空旧记录，再次打开同一记录会重新初始化', () => {
    initialize()
    const movie = state.movie
    state.values.intro = '未保存 A'
    state.id = undefined
    state.movie = undefined
    initialize()
    expect(state.values).toEqual({})
    state.id = 'movie-a'
    state.movie = movie
    initialize()
    expect(state.values.intro).toBe('服务器简介 A')
    expect(form.setFieldsValue).toHaveBeenCalledTimes(2)
  })
})
