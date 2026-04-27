import React, { useState } from 'react'
import {
  Badge,
  Button,
  message,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
  Alert,
} from 'antd'
import type { TableColumnsType } from 'antd'
import type { TableRowSelection } from 'antd/es/table/interface'
import {
  CheckOutlined,
  DeleteOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getComments,
  approveComment,
  spamComment,
  deleteComment,
  batchApproveComments,
  batchSpamComments,
  batchDeleteComments,
} from '../../api/comment'
import PageHeader from '../../components/common/PageHeader'
import type { Comment, CommentStatus } from '../../types'

const { Text } = Typography

const STATUS_BADGE: Record<CommentStatus, { status: 'warning' | 'success' | 'error'; label: string }> = {
  pending: { status: 'warning', label: '待审' },
  approved: { status: 'success', label: '已通过' },
  spam: { status: 'error', label: '垃圾' },
}

const STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '待审', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '垃圾', value: 'spam' },
]

const PAGE_SIZE = 20

export default function CommentPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['comments', statusFilter, page],
    queryFn: () => getComments({ status: statusFilter || undefined, page, limit: PAGE_SIZE }),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['comments'] })

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveComment(id),
    onSuccess: () => { message.success('已通过审核'); invalidate() },
    onError: (err: Error) => message.error(err.message || '操作失败'),
  })

  const spamMutation = useMutation({
    mutationFn: (id: string) => spamComment(id),
    onSuccess: () => { message.success('已标记为垃圾'); invalidate() },
    onError: (err: Error) => message.error(err.message || '操作失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteComment(id),
    onSuccess: () => { message.success('评论已删除'); invalidate() },
    onError: (err: Error) => message.error(err.message || '删除失败'),
  })

  // 批量操作
  const batchApproveMutation = useMutation({
    mutationFn: (ids: string[]) => batchApproveComments(ids),
    onSuccess: () => { message.success(`已批量通过 ${selectedIds.length} 条评论`); setSelectedIds([]); invalidate() },
    onError: () => message.error('批量操作失败'),
  })

  const batchSpamMutation = useMutation({
    mutationFn: (ids: string[]) => batchSpamComments(ids),
    onSuccess: () => { message.success(`已批量标记 ${selectedIds.length} 条为垃圾`); setSelectedIds([]); invalidate() },
    onError: () => message.error('批量操作失败'),
  })

  const batchDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => batchDeleteComments(ids),
    onSuccess: () => { message.success(`已批量删除 ${selectedIds.length} 条评论`); setSelectedIds([]); invalidate() },
    onError: () => message.error('批量删除失败'),
  })

  const comments: Comment[] = data?.data ?? []
  const total = data?.meta?.total ?? 0

  const rowSelection: TableRowSelection<Comment> = {
    selectedRowKeys: selectedIds,
    onChange: (keys: React.Key[]) => setSelectedIds(keys as string[]),
  }

  const columns: TableColumnsType<Comment> = [
    {
      title: '评论内容',
      dataIndex: 'body',
      key: 'body',
      ellipsis: true,
      render: (body: string) => <Text ellipsis={{ tooltip: body }}>{body}</Text>,
    },
    {
      title: '评论者',
      dataIndex: 'authorName',
      key: 'authorName',
      width: 130,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: CommentStatus) => {
        const cfg = STATUS_BADGE[status]
        return cfg ? <Badge status={cfg.status} text={cfg.label} /> : <Text type="secondary">{status}</Text>
      },
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (val: string) => new Date(val).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      fixed: 'right',
      render: (_: unknown, record: Comment) => (
        <Space size={4}>
          {record.status === 'pending' && (
            <>
              <Button type="link" size="small" icon={<CheckOutlined />}
                loading={approveMutation.isPending}
                onClick={() => approveMutation.mutate(record.id)}>通过</Button>
              <Button type="link" size="small" danger icon={<StopOutlined />}
                loading={spamMutation.isPending}
                onClick={() => spamMutation.mutate(record.id)}>垃圾</Button>
            </>
          )}
          <Popconfirm title="确认删除" description="确认永久删除该评论？"
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader title="评论管理" subtitle="审核与管理用户评论" />

      <div style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          value={statusFilter}
          options={STATUS_OPTIONS}
          style={{ width: 140 }}
          onChange={(val) => { setStatusFilter(val); setPage(1) }}
        />
      </div>

      {/* 批量操作栏 */}
      {selectedIds.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          message={
            <Space>
              <Text>已选 <Text strong>{selectedIds.length}</Text> 条</Text>
              <Button size="small" type="primary" icon={<CheckOutlined />}
                loading={batchApproveMutation.isPending}
                onClick={() => batchApproveMutation.mutate(selectedIds)}>
                批量通过
              </Button>
              <Button size="small" danger icon={<StopOutlined />}
                loading={batchSpamMutation.isPending}
                onClick={() => batchSpamMutation.mutate(selectedIds)}>
                批量标为垃圾
              </Button>
              <Popconfirm title={`确认删除选中的 ${selectedIds.length} 条评论？`}
                onConfirm={() => batchDeleteMutation.mutate(selectedIds)}
                okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                <Button size="small" danger icon={<DeleteOutlined />}
                  loading={batchDeleteMutation.isPending}>批量删除</Button>
              </Popconfirm>
              <Button size="small" onClick={() => setSelectedIds([])}>取消选择</Button>
            </Space>
          }
          type="info"
          showIcon
        />
      )}

      <Table
        rowKey="id"
        rowSelection={rowSelection}
        columns={columns}
        dataSource={comments}
        loading={isLoading}
        scroll={{ x: 900 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          onChange: (p) => setPage(p),
          showTotal: (t) => `共 ${t} 条评论`,
          showSizeChanger: false,
        }}
        size="middle"
      />
    </div>
  )
}
