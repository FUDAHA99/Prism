import React, { useState } from 'react'
import { Select, Table, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { getAuditLogs } from '../../api/auditLog'
import PageHeader from '../../components/common/PageHeader'
import type { AuditLog } from '../../types'

const { Text } = Typography

const PAGE_SIZE = 20

// 常见操作类型选项
const ACTION_OPTIONS = [
  { label: '全部操作', value: '' },
  { label: 'USER_LOGIN', value: 'USER_LOGIN' },
  { label: 'USER_LOGOUT', value: 'USER_LOGOUT' },
  { label: 'USER_REGISTER', value: 'USER_REGISTER' },
  { label: 'CONTENT_CREATE', value: 'CONTENT_CREATE' },
  { label: 'CONTENT_UPDATE', value: 'CONTENT_UPDATE' },
  { label: 'CONTENT_DELETE', value: 'CONTENT_DELETE' },
  { label: 'CONTENT_PUBLISH', value: 'CONTENT_PUBLISH' },
  { label: 'MEDIA_UPLOAD', value: 'MEDIA_UPLOAD' },
  { label: 'MEDIA_DELETE', value: 'MEDIA_DELETE' },
  { label: 'USER_UPDATE', value: 'USER_UPDATE' },
  { label: 'ROLE_ASSIGN', value: 'ROLE_ASSIGN' },
]

export default function AuditLogPage() {
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', action, page],
    queryFn: () =>
      getAuditLogs({
        action: action || undefined,
        page,
        limit: PAGE_SIZE,
      }),
  })

  const logs: (AuditLog & { username?: string })[] = data?.data ?? []
  const total = data?.meta?.total ?? 0

  const columns: TableColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (val: string) => new Date(val).toLocaleString('zh-CN'),
    },
    {
      title: '操作用户',
      dataIndex: 'username',
      key: 'username',
      width: 160,
      render: (_: string, record: AuditLog & { username?: string }) => {
        if (!record.userId) return <Text type="secondary">-</Text>
        return record.username ? (
          <Tooltip title={`UID: ${record.userId}`}>
            <Text strong>{record.username}</Text>
          </Tooltip>
        ) : (
          <Text code style={{ fontSize: 11 }}>{record.userId.slice(0, 8)}…</Text>
        )
      },
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      width: 180,
      render: (val: string) => <Text strong>{val}</Text>,
    },
    {
      title: '资源类型',
      dataIndex: 'resourceType',
      key: 'resourceType',
      width: 140,
    },
    {
      title: 'IP地址',
      dataIndex: 'ipAddress',
      key: 'ipAddress',
      width: 150,
      render: (ip: string) => <Text type="secondary">{ip}</Text>,
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader title="操作日志" subtitle="记录所有用户的关键操作" />

      {/* 操作类型筛选 */}
      <div style={{ marginBottom: 16 }}>
        <Select
          value={action}
          options={ACTION_OPTIONS}
          style={{ width: 200 }}
          onChange={(val) => {
            setAction(val)
            setPage(1)
          }}
          placeholder="筛选操作类型"
        />
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={logs}
        loading={isLoading}
        scroll={{ x: 900 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          onChange: (p) => setPage(p),
          showTotal: (t) => `共 ${t} 条日志`,
          showSizeChanger: false,
        }}
        size="middle"
      />
    </div>
  )
}
