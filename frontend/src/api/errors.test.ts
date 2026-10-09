import { describe, expect, it } from 'vitest'
import {
  ApiError,
  BODY_TOO_LARGE_MESSAGE,
  CANCELED_MESSAGE,
  FALLBACK_ERROR_MESSAGE,
  FORBIDDEN_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  QUERY_MAX_RETRIES,
  SERVER_ERROR_MESSAGE,
  TIMEOUT_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  actionErrorMessage,
  describeQueryError,
  errorMessage,
  errorStatus,
  isRetryableError,
  messageForError,
  shouldRetryQuery,
} from './errors'

/** 后端 HttpExceptionFilter 的错误响应体 */
const body = (message: unknown) => ({ success: false, statusCode: 0, message })

describe('messageForError（拦截器给出的中文提示）', () => {
  describe('403', () => {
    it.each([
      ['AccessGuard 的通用文案「权限不足」', body('权限不足')],
      ['带首尾空白的通用文案', body(' 权限不足 ')],
      ['Nest 默认英文 Forbidden resource', body('Forbidden resource')],
      ['英文 Forbidden', { statusCode: 403, message: 'Forbidden' }],
      ['其他英文', body('Access denied')],
      ['没有响应体', undefined],
      ['空 message', body('')],
      ['nginx 的 HTML 错误页', '<html><body><h1>403 Forbidden</h1></body></html>'],
    ])('%s → 「当前账号无权限执行此操作」', (_name, data) => {
      expect(messageForError({ status: 403, data })).toBe(FORBIDDEN_MESSAGE)
    })

    it.each([
      '只有作者或管理员可以编辑内容',
      '评论功能已关闭',
      '暂未开放注册',
      '只有上传者或管理员可以删除文件',
    ])('业务上的中文 403 原样展示：%s', (msg) => {
      expect(messageForError({ status: 403, data: body(msg) })).toBe(msg)
    })
  })

  describe('5xx', () => {
    it.each([
      [500, { statusCode: 500, message: 'Internal server error' }],
      [502, '<html><head><title>502 Bad Gateway</title></head></html>'],
      [503, undefined],
      [504, '<html>504 Gateway Time-out</html>'],
    ])('%i 的英文 / HTML / 空响应 → 统一的中文提示', (status, data) => {
      expect(messageForError({ status, data, message: `Request failed with status code ${status}` })).toBe(
        SERVER_ERROR_MESSAGE,
      )
    })

    it('后端给了中文原因就展示原因', () => {
      expect(messageForError({ status: 500, data: body('采集源响应解析失败') })).toBe('采集源响应解析失败')
    })
  })

  describe('413', () => {
    it('文件上传撞上传上限', () => {
      expect(messageForError({ status: 413, data: '<html>413</html>', isUpload: true })).toBe(UPLOAD_TOO_LARGE_MESSAGE)
    })
    it('普通 JSON 提交撞请求体上限，不提 10MB', () => {
      expect(messageForError({ status: 413, data: body('request entity too large') })).toBe(BODY_TOO_LARGE_MESSAGE)
    })
  })

  describe('其他 4xx：后端的原因原样展示', () => {
    it.each([
      [400, '昵称长度不能少于2个字符'],
      [401, '邮箱或密码错误'],
      [404, '内容不存在'],
      [409, '该昵称已被其他用户使用'],
      [429, '请求过于频繁，请稍后再试'],
    ])('%i：%s', (status, msg) => {
      expect(messageForError({ status, data: body(msg) })).toBe(msg)
    })

    it('message 是数组时取第一条', () => {
      expect(messageForError({ status: 400, data: body(['第一条原因', '第二条原因']) })).toBe('第一条原因')
    })

    it('没有 message 时退到 error 字段，再退到 axios 的 message', () => {
      expect(messageForError({ status: 404, data: { error: 'Not Found' } })).toBe('Not Found')
      expect(messageForError({ status: 404, data: {}, message: 'Request failed with status code 404' })).toBe(
        'Request failed with status code 404',
      )
      expect(messageForError({ status: 404 })).toBe(FALLBACK_ERROR_MESSAGE)
    })

    it('message 不是字符串（对象、数字）不直接展示', () => {
      expect(messageForError({ status: 400, data: body({ nested: true }), message: 'axios' })).toBe('axios')
      expect(messageForError({ status: 400, data: body(42) })).toBe(FALLBACK_ERROR_MESSAGE)
    })
  })

  describe('没拿到响应', () => {
    it.each([
      ['ERR_NETWORK', 'Network Error', NETWORK_ERROR_MESSAGE],
      ['ECONNABORTED', 'timeout of 15000ms exceeded', TIMEOUT_MESSAGE],
      ['ETIMEDOUT', 'timeout', TIMEOUT_MESSAGE],
      ['ERR_CANCELED', 'canceled', CANCELED_MESSAGE],
    ])('%s → 中文提示', (code, message, expected) => {
      expect(messageForError({ code, message })).toBe(expected)
    })

    it('未知的错误码保留原 message，没有就用兜底文案', () => {
      expect(messageForError({ code: 'ERR_SOMETHING', message: '自定义错误' })).toBe('自定义错误')
      expect(messageForError({})).toBe(FALLBACK_ERROR_MESSAGE)
    })
  })
})

describe('isRetryableError / shouldRetryQuery（react-query 的重试策略）', () => {
  it.each([400, 401, 403, 404, 409, 413, 422, 429])('%i 不重试', (status) => {
    expect(isRetryableError(new ApiError('x', { status }))).toBe(false)
    expect(shouldRetryQuery(0, new ApiError('x', { status }))).toBe(false)
  })

  it.each([500, 502, 503, 504])('%i 重试', (status) => {
    expect(isRetryableError(new ApiError('x', { status }))).toBe(true)
  })

  it('网络错误、超时重试；被取消的不重试', () => {
    expect(isRetryableError(new ApiError('x', { code: 'ERR_NETWORK' }))).toBe(true)
    expect(isRetryableError(new ApiError('x', { code: 'ECONNABORTED' }))).toBe(true)
    expect(isRetryableError(new ApiError('x'))).toBe(true)
    expect(isRetryableError(new ApiError('x', { code: 'ERR_CANCELED' }))).toBe(false)
  })

  it('不是 ApiError 的错误（queryFn 里的代码错误）不重试', () => {
    expect(isRetryableError(new TypeError('x is undefined'))).toBe(false)
    expect(isRetryableError(new Error('plain'))).toBe(false)
    expect(isRetryableError('string')).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })

  it('5xx 最多重试 QUERY_MAX_RETRIES 次（failureCount 从 0 起算）', () => {
    const err = new ApiError('x', { status: 503 })
    expect(QUERY_MAX_RETRIES).toBe(3)
    expect([0, 1, 2, 3, 4].map((n) => shouldRetryQuery(n, err))).toEqual([true, true, true, false, false])
  })
})

describe('ApiError', () => {
  it('是 Error，带 status / code / name', () => {
    const err = new ApiError('当前账号无权限执行此操作', { status: 403, code: 'ERR_BAD_REQUEST' })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('当前账号无权限执行此操作')
    expect(err.status).toBe(403)
    expect(err.code).toBe('ERR_BAD_REQUEST')
    expect(err.name).toBe('ApiError')
    expect(errorStatus(err)).toBe(403)
  })

  it('errorStatus 对非 ApiError 返回 undefined', () => {
    expect(errorStatus(new Error('x'))).toBeUndefined()
    expect(errorStatus({ status: 403 })).toBeUndefined()
  })
})

describe('errorMessage / actionErrorMessage', () => {
  it('有原因时带上原因', () => {
    const err = new ApiError(FORBIDDEN_MESSAGE, { status: 403 })
    expect(errorMessage(err, '删除失败')).toBe(FORBIDDEN_MESSAGE)
    expect(actionErrorMessage('删除失败', err)).toBe(`删除失败：${FORBIDDEN_MESSAGE}`)
  })

  it('没有原因时只显示动作', () => {
    expect(errorMessage(new Error(''), '删除失败')).toBe('删除失败')
    expect(errorMessage(new Error('   '), '删除失败')).toBe('删除失败')
    expect(errorMessage('not an error', '删除失败')).toBe('删除失败')
    expect(actionErrorMessage('删除失败', new Error(''))).toBe('删除失败')
    expect(actionErrorMessage('删除失败', null)).toBe('删除失败')
  })
})

describe('describeQueryError（列表加载失败时的错误状态）', () => {
  it('403：无权限，不给重试', () => {
    expect(describeQueryError(new ApiError(FORBIDDEN_MESSAGE, { status: 403 }))).toEqual({
      status: '403',
      title: '无权限访问',
      subTitle: FORBIDDEN_MESSAGE,
      retryable: false,
    })
  })

  it('5xx：服务器出错，可重试', () => {
    expect(describeQueryError(new ApiError(SERVER_ERROR_MESSAGE, { status: 502 }))).toMatchObject({
      status: '500',
      title: '服务器出错',
      subTitle: SERVER_ERROR_MESSAGE,
      retryable: true,
    })
  })

  it('没拿到响应：无法连接服务器，可重试', () => {
    expect(describeQueryError(new ApiError(NETWORK_ERROR_MESSAGE, { code: 'ERR_NETWORK' }))).toMatchObject({
      status: 'warning',
      title: '无法连接服务器',
      retryable: true,
    })
  })

  it('其他错误：加载失败，展示原因', () => {
    expect(describeQueryError(new ApiError('内容不存在', { status: 404 }))).toMatchObject({
      status: 'error',
      title: '加载失败',
      subTitle: '内容不存在',
      retryable: true,
    })
    expect(describeQueryError(new TypeError('boom'))).toMatchObject({ status: 'error', subTitle: 'boom' })
    expect(describeQueryError(undefined)).toMatchObject({ status: 'error', subTitle: FALLBACK_ERROR_MESSAGE })
  })
})
