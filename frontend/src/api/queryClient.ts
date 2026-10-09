import { MutationCache, QueryClient } from '@tanstack/react-query'
import { errorMessage, shouldRetryQuery } from './errors'

/** 写操作失败、页面又没有自己处理时的兜底提示 */
export const UNHANDLED_MUTATION_ERROR_FALLBACK = '操作失败，请稍后重试'

export interface QueryClientOptions {
  /**
   * 写操作（useMutation）失败、且这个 mutation 没有自己的 onError 时调用，参数是给人看的中文原因
   * （403 时是「当前账号无权限执行此操作」或后端的具体原因，见 errors.ts）。
   * 此前这类 mutation（如漫画 / 章节 / 采集源的删除）失败时界面上什么都不显示。
   */
  onUnhandledMutationError: (message: string, error: unknown) => void
  /** 只给测试用：把重试间隔改成 0 */
  retryDelay?: (attemptIndex: number) => number
}

const defaultRetryDelay = (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000)

export function createQueryClient({
  onUnhandledMutationError,
  retryDelay = defaultRetryDelay,
}: QueryClientOptions): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _onMutateResult, mutation) => {
        // 自己写了 onError 的 mutation 已经给过提示（多数带着具体原因），这里不再重复
        if (mutation.options.onError) return
        onUnhandledMutationError(errorMessage(error, UNHANDLED_MUTATION_ERROR_FALLBACK), error)
      },
    }),
    defaultOptions: {
      queries: {
        // 只对网络错误 / 5xx 重试（最多 3 次）；4xx（403 没权限、404、400）重试结果不会变。
        // 此前一律重试 3 次：403 要等七八秒才显示出错，还白白消耗后端的限流额度
        retry: shouldRetryQuery,
        retryDelay,
        staleTime: 5 * 60 * 1000, // 5分钟
        gcTime: 10 * 60 * 1000, // 10分钟
        refetchOnWindowFocus: false,
      },
      mutations: {
        // 写操作不自动重试：4xx 重试没有意义；超时 / 5xx 时后端可能已经写入，自动重发会重复新建
        // （新建内容、添加章节、启动采集都不是幂等的）。失败时把原因提示给用户，由用户决定是否再点一次
        retry: false,
      },
    },
  })
}
