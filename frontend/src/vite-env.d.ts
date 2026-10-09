/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发环境顶栏「访问前台」打开的门户地址，默认 http://localhost:3002；生产环境固定打开同源的 /（见 utils/portal-url.ts） */
  readonly VITE_PORTAL_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
