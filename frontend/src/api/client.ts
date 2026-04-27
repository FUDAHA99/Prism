import axios from 'axios'

export const apiClient = axios.create({
  baseURL: '/api',
  timeout: 15000,
})

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

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
    if (error.response?.status === 401) {
      // 完整清理：localStorage 的 token + zustand persist 里的 isAuthenticated
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
      localStorage.removeItem('cms-auth') // zustand persist key
      // 已经在登录页就不再跳，避免对登录请求 401 时多余 reload
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }

    // Extract message from backend error response
    const message =
      error.response?.data?.message ??
      error.response?.data?.error ??
      error.message ??
      '请求失败，请稍后重试'

    return Promise.reject(new Error(message))
  }
)
