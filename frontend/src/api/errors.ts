/**
 * admin SPA 的请求错误。apiClient 的响应拦截器（client.ts）把每个失败的请求都转换成 ApiError：
 * - status 保留 HTTP 状态码（没拿到响应时为 undefined），react-query 的重试策略与页面的错误状态据此判断；
 * - message 是给人看的中文提示，页面直接展示，不必各自再按状态码拼文案。
 *
 * 此前拦截器抛的是 `new Error(message)`，状态码丢了：react-query 只能对所有错误一视同仁地重试 3 次
 * （403 也要等七八秒才出结果），页面也分不清「没权限」「服务器挂了」和「确实没有数据」。
 */
export class ApiError extends Error {
  /** HTTP 状态码；请求没有拿到响应（断网、超时、被取消）时为 undefined */
  readonly status: number | undefined
  /** axios 的错误码，如 ECONNABORTED（超时）、ERR_NETWORK、ERR_CANCELED；没有时为 undefined */
  readonly code: string | undefined

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status
    this.code = options.code
  }
}

export const FORBIDDEN_MESSAGE = '当前账号无权限执行此操作'
export const SERVER_ERROR_MESSAGE = '服务器出错，请稍后重试'
export const NETWORK_ERROR_MESSAGE = '网络异常，无法连接服务器，请检查网络后重试'
export const TIMEOUT_MESSAGE = '请求超时，请稍后重试'
export const CANCELED_MESSAGE = '请求已取消'
export const FALLBACK_ERROR_MESSAGE = '请求失败，请稍后重试'
export const UPLOAD_TOO_LARGE_MESSAGE = '文件过大，超过服务器允许的上传上限（10MB）'
export const BODY_TOO_LARGE_MESSAGE = '提交内容过大，请缩减后重试'

/**
 * 403 的通用文案：后端 AccessGuard 角色不够时是「权限不足」（backend/src/common/authz/access.guard.ts），
 * Nest 默认是英文。这几种换成更明确的 FORBIDDEN_MESSAGE；业务上的 403（如「只有作者或管理员可以编辑内容」
 * 「评论功能已关闭」）原样展示，它们说清了原因。
 */
const GENERIC_FORBIDDEN_MESSAGES: ReadonlySet<string> = new Set(['权限不足', 'Forbidden', 'Forbidden resource'])

/** 含中日韩文字：后端自己写的提示都是中文；英文的多半是框架或代理的默认文案（Internal server error 等） */
const HAS_CJK = /[㐀-鿿豈-﫿]/

/** 响应体里的提示：HttpExceptionFilter 的 message（字符串），其次是 error；空串、非字符串不算 */
function messageFromBody(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const { message, error } = data as { message?: unknown; error?: unknown }
  for (const candidate of [message, error]) {
    const text = Array.isArray(candidate) ? candidate[0] : candidate
    if (typeof text === 'string' && text.trim() !== '') return text
  }
  return undefined
}

export interface ErrorSource {
  /** HTTP 状态码；没拿到响应时为 undefined */
  status?: number
  /** 响应体（nginx 的错误页是 HTML 字符串） */
  data?: unknown
  /** axios 的错误码 */
  code?: string
  /** axios 自己的 message（如 "Network Error"、"timeout of 15000ms exceeded"） */
  message?: string
  /** 请求体是 FormData（文件上传） */
  isUpload?: boolean
}

/** 把一次失败的请求换成给人看的中文提示（纯函数，拦截器调用，单测覆盖） */
export function messageForError(source: ErrorSource): string {
  const { status } = source

  if (status === undefined) {
    switch (source.code) {
      case 'ECONNABORTED':
      case 'ETIMEDOUT':
        return TIMEOUT_MESSAGE
      case 'ERR_NETWORK':
        return NETWORK_ERROR_MESSAGE
      case 'ERR_CANCELED':
        return CANCELED_MESSAGE
      default:
        return source.message || FALLBACK_ERROR_MESSAGE
    }
  }

  // 413 的 body 不可用（nginx 是 HTML、后端是英文），统一给中文提示，但要分来源：
  // - 文件上传（FormData）：撞的是 nginx/multer 的上传上限 → 提示 10MB
  // - 普通 JSON 提交：撞的是后端 body-parser 默认 100kb（如很长的小说章节），与上传上限无关，提示 10MB 会误导
  if (status === 413) {
    return source.isUpload ? UPLOAD_TOO_LARGE_MESSAGE : BODY_TOO_LARGE_MESSAGE
  }

  const fromBody = messageFromBody(source.data)

  if (status === 403) {
    return fromBody && HAS_CJK.test(fromBody) && !GENERIC_FORBIDDEN_MESSAGES.has(fromBody.trim())
      ? fromBody
      : FORBIDDEN_MESSAGE
  }

  if (status >= 500) {
    // 502/504 是 nginx 的 HTML，500 是 Nest 的 "Internal server error"：都不适合直接给人看
    return fromBody && HAS_CJK.test(fromBody) ? fromBody : SERVER_ERROR_MESSAGE
  }

  return fromBody ?? (source.message || FALLBACK_ERROR_MESSAGE)
}

/** 错误的 HTTP 状态码；不是 ApiError 或没拿到响应时为 undefined */
export function errorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined
}

/**
 * 值得自动重试的错误：没拿到响应（断网、超时）或 5xx。4xx 是请求本身的问题（没权限、参数不对、不存在），
 * 重试只会让用户多等几秒、多打几次后端（限流额度也会被耗掉），结果不会变。
 * 被取消的请求、以及不是 ApiError 的错误（queryFn 里的代码错误）也不重试。
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === undefined) return error.code !== 'ERR_CANCELED'
  return error.status >= 500
}

/** 查询最多自动重试几次（与此前的 retry: 3 相同，只是 4xx 不再重试） */
export const QUERY_MAX_RETRIES = 3

/** react-query 的 queries.retry：`(failureCount, error) => boolean`，failureCount 从 0 起算 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < QUERY_MAX_RETRIES && isRetryableError(error)
}

/** 给人看的错误信息：Error 的 message，没有时用 fallback */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}

/** 操作失败的提示：「删除失败：当前账号无权限执行此操作」；拿不到原因时只显示「删除失败」 */
export function actionErrorMessage(action: string, error: unknown): string {
  const reason = errorMessage(error, '')
  return reason ? `${action}：${reason}` : action
}

export type QueryErrorStatus = '403' | '500' | 'warning' | 'error'

export interface QueryErrorView {
  /** antd Result 的 status */
  status: QueryErrorStatus
  title: string
  subTitle: string
  /** 是否给「重试」按钮：403 重试不会有不同结果 */
  retryable: boolean
}

/** 列表等数据加载失败时显示什么（QueryErrorResult 用）：403 / 5xx / 网络错误各自说清，而不是显示一张空表 */
export function describeQueryError(error: unknown): QueryErrorView {
  const status = errorStatus(error)
  if (status === 403) {
    return { status: '403', title: '无权限访问', subTitle: errorMessage(error, FORBIDDEN_MESSAGE), retryable: false }
  }
  if (status !== undefined && status >= 500) {
    return { status: '500', title: '服务器出错', subTitle: errorMessage(error, SERVER_ERROR_MESSAGE), retryable: true }
  }
  if (status === undefined && error instanceof ApiError) {
    return { status: 'warning', title: '无法连接服务器', subTitle: errorMessage(error, NETWORK_ERROR_MESSAGE), retryable: true }
  }
  return { status: 'error', title: '加载失败', subTitle: errorMessage(error, FALLBACK_ERROR_MESSAGE), retryable: true }
}
