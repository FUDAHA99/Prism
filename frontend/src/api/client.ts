import axios from 'axios'

export const apiClient = axios.create({
  baseURL: '/api/v1',
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
    const status = error.response?.status
    if (status === 401) {
      // 完整清理：localStorage 的 token + zustand persist 里的 isAuthenticated
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
      localStorage.removeItem('cms-auth') // zustand persist key
      // 生产部署在 /admin/（vite base），登录页是 /admin/login；写死根路径的 login 会落到门户 404。
      // BASE_URL 与 main.tsx 里 BrowserRouter 的 basename 同源：dev 为 '/'，build 为 '/admin/'。
      const loginPath = `${import.meta.env.BASE_URL}login`
      // 已经在登录页就不再跳，避免对登录请求 401 时多余 reload（输错密码时要留在原页显示错误）
      if (!window.location.pathname.startsWith(loginPath)) {
        window.location.href = loginPath
      }
    }

    // 413 的 body 不可用（nginx 是 HTML、后端是英文），统一给中文提示，但要分来源：
    // - 文件上传（FormData）：撞的是 nginx/multer 的上传上限 → 提示 10MB
    // - 普通 JSON 提交：撞的是后端 body-parser 默认 100kb（如很长的小说章节），
    //   与上传上限无关，提示 10MB 会误导
    // axios 的 transformRequest 对 FormData 原样透传，error.config.data 仍是 FormData 实例
    const isUpload = error.config?.data instanceof FormData
    const message =
      status === 413
        ? isUpload
          ? '文件过大，超过服务器允许的上传上限（10MB）'
          : '提交内容过大，请缩减后重试'
        : error.response?.data?.message ??
          error.response?.data?.error ??
          error.message ??
          '请求失败，请稍后重试'

    return Promise.reject(new Error(message))
  }
)
