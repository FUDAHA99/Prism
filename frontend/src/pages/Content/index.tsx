import React, { useState } from 'react'
import {
  Table,
  Button,
  Input,
  Select,
  Space,
  Tag,
  Badge,
  Popconfirm,
  message,
  Row,
  Col,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getContents,
  deleteContent,
  publishContent,
  unpublishContent,
} from '../../api/content'
import type { Content } from '../../types'
import PageHeader from '../../components/common/PageHeader'
import { formatDate } from '../../utils'

const CONTENT_TYPE_LABELS: Record<string, string> = {
  article: '文章',
  page: '页面',
  announcement: '公告',
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  published: 'success',
  archived: 'warning',
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
}

interface Filters {
  search: string
  status: string
  contentType: string
  page: number
}

export default function ContentList() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [filters, setFilters] = useState<Filters>({
    search: '',
    status: '',
    contentType: '',
    page: 1,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['contents', filters],
    queryFn: () =>
      getContents({
        search: filters.search || undefined,
        status: filters.status || undefined,
        contentType: filters.contentType || undefined,
        page: filters.page,
        limit: 20,
      }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteContent(id),
    onSuccess: () => {
      message.success('删除成功')
      queryClient.invalidateQueries({ queryKey: ['contents'] })
    },
    onError: () => {
      message.error('删除失败')
    },
  })

  const publishMutation = useMutation({
    mutationFn: ({ id, isPublished }: { id: string; isPublished: boolean }) =>
      isPublished ? unpublishContent(id) : publishContent(id),
    onSuccess: (_data, variables) => {
      message.success(variables.isPublished ? '已取消发布' : '发布成功')
      queryClient.invalidateQueries({ queryKey: ['contents'] })
    },
    onError: () => {
      message.error('操作失败')
    },
  })

  const columns: TableColumnsType<Content> = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (title: string) => (
        <Typography.Text strong>{title}</Typography.Text>
      ),
    },
    {
      title: '类型',
      dataIndex: 'contentType',
      key: 'contentType',
      width: 90,
      render: (type: string) => (
        <Tag>{CONTENT_TYPE_LABELS[type] ?? type}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Badge
          status={STATUS_COLOR[status] as 'default' | 'success' | 'warning' | 'error'}
          text={STATUS_LABEL[status] ?? status}
        />
      ),
    },
    {
      title: '作者',
      key: 'author',
      width: 120,
      render: (_: unknown, record: Content) =>
        record.author?.username ?? record.authorId,
    },
    {
      title: '浏览量',
      dataIndex: 'viewCount',
      key: 'viewCount',
      width: 90,
      align: 'right',
    },
    {
      title: '发布时间',
      dataIndex: 'publishedAt',
      key: 'publishedAt',
      width: 160,
      render: (val: string | undefined) => (val ? formatDate(val) : '-'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: unknown, record: Content) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/contents/${record.id}/edit`)}
          >
            编辑
          </Button>

          <Button
            size="small"
            icon={record.isPublished ? <StopOutlined /> : <CheckCircleOutlined />}
            onClick={() =>
              publishMutation.mutate({ id: record.id, isPublished: record.isPublished })
            }
            loading={
              publishMutation.isPending &&
              (publishMutation.variables as { id: string } | undefined)?.id === record.id
            }
          >
            {record.isPublished ? '取消发布' : '发布'}
          </Button>

          <Popconfirm
            title="确认删除此内容？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteMutation.mutate(record.id)}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              loading={
                deleteMutation.isPending &&
                (deleteMutation.variables as string | undefined) === record.id
              }
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters((prev) => ({ ...prev, search: e.target.value, page: 1 }))
  }

  const handleStatusChange = (value: string) => {
    setFilters((prev) => ({ ...prev, status: value, page: 1 }))
  }

  const handleTypeChange = (value: string) => {
    setFilters((prev) => ({ ...prev, contentType: value, page: 1 }))
  }

  const total = data?.meta?.total ?? 0
  const contents = data?.data ?? []

  return (
    <div>
      <PageHeader
        title="内容管理"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/contents/create')}
          >
            新建内容
          </Button>
        }
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col flex="1">
          <Input
            placeholder="搜索标题..."
            prefix={<SearchOutlined />}
            value={filters.search}
            onChange={handleSearchChange}
            allowClear
          />
        </Col>
        <Col>
          <Select
            placeholder="全部状态"
            value={filters.status || undefined}
            onChange={handleStatusChange}
            allowClear
            style={{ width: 140 }}
          >
            <Select.Option value="draft">草稿</Select.Option>
            <Select.Option value="published">已发布</Select.Option>
            <Select.Option value="archived">已归档</Select.Option>
          </Select>
        </Col>
        <Col>
          <Select
            placeholder="全部类型"
            value={filters.contentType || undefined}
            onChange={handleTypeChange}
            allowClear
            style={{ width: 140 }}
          >
            <Select.Option value="article">文章</Select.Option>
            <Select.Option value="page">页面</Select.Option>
            <Select.Option value="announcement">公告</Select.Option>
          </Select>
        </Col>
      </Row>

      <Table<Content>
        rowKey="id"
        dataSource={contents}
        columns={columns}
        loading={isLoading}
        pagination={{
          current: filters.page,
          total,
          pageSize: 20,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page) => setFilters((prev) => ({ ...prev, page })),
        }}
      />
    </div>
  )
}
