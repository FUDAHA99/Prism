import { useEffect, useRef, useState } from 'react'
import { Button, Space, Typography } from 'antd'
import type { MovieSource, MovieSourceCheckResult } from '../../api/movie'
import { actionErrorMessage } from '../../api/errors'
import { checkSourceSnapshot, sourceCheckSnapshot } from './source-http-check'

/** 父级以影片、线路和首集快照为 key；目标改变即卸载并清空本次诊断。 */
export default function SourceHttpCheck({ source }: { source: MovieSource }) {
  const request = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<MovieSourceCheckResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => () => { request.current?.abort() }, [])

  const check = async () => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setResult(null)
    setError('')
    try {
      const { sampleId } = sourceCheckSnapshot(source.movieId, source)
      const next = await checkSourceSnapshot(source.id, sampleId, controller.signal)
      if (!controller.signal.aborted) setResult(next)
    } catch (e) {
      if (!controller.signal.aborted) setError(actionErrorMessage('检测失败', e))
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setLoading(false)
      }
    }
  }

  return (
    <div style={{ marginBottom: 12, overflowWrap: 'anywhere' }}>
      <Space wrap>
        <Button size="small" loading={loading} onClick={check}>检测 HTTP 响应</Button>
        <Typography.Text type="secondary">HTTP 响应不代表播放验证</Typography.Text>
      </Space>
      <div role="status" aria-live="polite">
        {result && (
          <div style={{ marginTop: 8 }}>
            <div>{result.message}{result.httpStatus !== null && `（HTTP ${result.httpStatus}）`}</div>
            {result.sample && <div>样本：第 {result.sample.episodeNumber} 集 · {result.sample.title}</div>}
            <Typography.Text type="secondary">检测时间：{new Date(result.checkedAt).toLocaleString('zh-CN')}</Typography.Text>
          </div>
        )}
        {error && <Typography.Text type="danger">{error}</Typography.Text>}
      </div>
    </div>
  )
}
