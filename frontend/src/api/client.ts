import axios from 'axios'
import { ApiError, messageForError } from './errors'

export const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 15000,
})

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  // 调用方显式带了 Authorization（如退出后在后台补发的注销请求）就以它为准，不用本地当前的 token 覆盖
  if (token && !config.headers.has('Authorization')) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

/**
 * 请求带的 token 已经不是本地当前的登录态：例如退出后在后台补发的注销请求，回来之前用户已经重新登录。
 * 这种请求被 401 只说明那个旧 token 失效了，不能因此清掉新的登录状态、把人踢回登录页。
 */
export function handleUnauthorized(sent: unknown): void {
  const current = localStorage.getItem('access_token')
  if (typeof sent === 'string' && current !== null && sent !== `Bearer ${current}`) return

  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  localStorage.removeItem('cms-auth')
  const loginPath = `${import.meta.env.BASE_URL}login`
  if (!window.location.pathname.startsWith(loginPath)) window.location.href = loginPath
}

apiClient.interceptors.response.use(
  (response) => {
    // Unwrap TransformInterceptor envelope: { success, data, timestamp }
    const body = response.data
    if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
      return { ...response, data: body.data }
    }
    return response
  },
  (error) => {
    const status: number | undefined = error.response?.status
    if (status === 401) {
      handleUnauthorized(error.config?.headers?.get?.('Authorization'))
    }

    // 带上状态码抛出 ApiError：react-query 据此只对网络错误 / 5xx 重试，页面据此区分 403 与空数据。
    // 文案（403、5xx、413、超时等的中文提示）统一在 messageForError 里决定，见 errors.ts。
    // axios 的 transformRequest 对 FormData 原样透传，error.config.data 仍是 FormData 实例
    const isUpload = typeof FormData !== 'undefined' && error.config?.data instanceof FormData
    const message = messageForError({
      status,
      data: error.response?.data,
      code: error.code,
      message: error.message,
      isUpload,
    })

    return Promise.reject(new ApiError(message, { status, code: error.code }))
  }
)
