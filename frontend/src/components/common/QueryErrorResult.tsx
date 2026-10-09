import React from 'react'
import { Button, Result } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { describeQueryError } from '../../api/errors'

interface QueryErrorResultProps {
  /** react-query 的 error（apiClient 抛出的 ApiError 带 status） */
  error: unknown
  /** 重新加载（通常传 query 的 refetch）；403 不显示重试按钮 */
  onRetry?: () => unknown
}

/**
 * 数据加载失败时代替列表 / 表单显示的错误状态：403 显示「无权限访问」，5xx 显示「服务器出错」，
 * 断网 / 超时显示「无法连接服务器」，副标题是拦截器给出的中文原因。
 * 此前查询失败时页面只显示一张「暂无数据」的空表，看不出是没权限、后端出错还是确实没有数据。
 */
export default function QueryErrorResult({ error, onRetry }: QueryErrorResultProps) {
  const view = describeQueryError(error)
  return (
    <Result
      status={view.status}
      title={view.title}
      subTitle={view.subTitle}
      extra={
        view.retryable && onRetry ? (
          <Button icon={<ReloadOutlined />} onClick={() => onRetry()}>
            重新加载
          </Button>
        ) : undefined
      }
    />
  )
}

interface QueryErrorSwitchProps extends QueryErrorResultProps {
  isError: boolean
  children: React.ReactNode
}

/** 查询出错时显示 QueryErrorResult，否则原样渲染 children（列表页包住 Table 用） */
export function QueryErrorSwitch({ isError, error, onRetry, children }: QueryErrorSwitchProps) {
  return isError ? <QueryErrorResult error={error} onRetry={onRetry} /> : <>{children}</>
}
