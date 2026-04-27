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
  Image,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  StopOutlined,
  PictureOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getComics,
  deleteComic,
  publishComic,
  unpublishComic,
  type Comic,
  type ComicStatus,
  type ComicSerialStatus,
} from '../../api/comic'
import PageHeader from '../../components/common/PageHeader'
import { formatDate } from '../../utils'

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
const SERIAL_LABEL: Record<ComicSerialStatus, string> = {
  ongoing: '连载中',
  finished: '已完结',
  paused: '暂停',
}
const SERIAL_COLOR: Record<ComicSerialStatus, string> = {
  ongoing: 'blue',
  finished: 'green',
  paused: 'orange',
}

interface Filters {
  search: string
  status: ComicStatus | ''
  serialStatus: ComicSerialStatus | ''
  page: number
}

export default function ComicList() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [filters, setFilters] = useState<Filters>({
    search: '',
    status: '',
    serialStatus: '',
    page: 1,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['comics', filters],
    queryFn: () =>
      getComics({
        search: filters.search || undefined,
        status: filters.status || undefined,
        serialStatus: filters.serialStatus || undefined,
        page: filters.page,
        limit: 20,
      }),
  })

  const delMut = useMutation({
    mutationFn: deleteComic,
    onSuccess: () => {
      message.success('删除成功')
      qc.invalidateQueries({ queryKey: ['comics'] })
    },
  })

  const pubMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ComicStatus }) =>
      status === 'published' ? unpublishComic(id) : publishComic(id),
    onSuccess: (_d, v) => {
      message.success(v.status === 'published' ? '已取消发布' : '发布成功')
      qc.invalidateQueries({ queryKey: ['comics'] })
    },
  })

  const columns: TableColumnsType<Comic> = [
    {
      title: '封面',
      dataIndex: 'coverUrl',
      key: 'coverUrl',
      width: 70,
      render: (u?: string) =>
        u ? (
          <Image
            src={u}
            width={48}
            height={64}
            style={{ objectFit: 'cover', borderRadius: 4 }}
          />
        ) : (
          <div
            style={{
              width: 48,
              height: 64,
              background: '#F1F5F9',
              borderRadius: 4,
            }}
          />
        ),
    },
    {
      title: '书名',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (t: string, r: Comic) => (
        <div>
          <Typography.Text strong>{t}</Typography.Text>
          {r.author && (
            <div style={{ fontSize: 12, color: '#94A3B8' }}>作者：{r.author}</div>
          )}
        </div>
      ),
    },
    {
      title: '分类',
      dataIndex: 'subType',
      key: 'subType',
      width: 100,
      render: (v?: string) => v || '-',
    },
    {
      title: '章节',
      dataIndex: 'chapterCount',
      key: 'chapterCount',
      width: 80,
      align: 'right',
      render: (v: number) => `${v} 话`,
    },
    {
      title: '连载状态',
      dataIndex: 'serialStatus',
      key: 'serialStatus',
      width: 90,
      render: (s: ComicSerialStatus) => (
        <Tag color={SERIAL_COLOR[s]}>{SERIAL_LABEL[s]}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: string) => (
        <Badge
          status={STATUS_COLOR[s] as 'default' | 'success' | 'warning'}
          text={STATUS_LABEL[s]}
        />
      ),
    },
    {
      title: '阅读量',
      dataIndex: 'viewCount',
      key: 'viewCount',
      width: 80,
      align: 'right',
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      render: (v: string) => formatDate(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      render: (_: unknown, r: Comic) => (
        <Space size="small">
          <Button
            size="small"
            icon={<PictureOutlined />}
            onClick={() => navigate(`/comics/${r.id}/chapters`)}
          >
            章节
          </Button>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/comics/${r.id}/edit`)}
          >
            编辑
          </Button>
          <Button
            size="small"
            icon={
              r.status === 'published' ? <StopOutlined /> : <CheckCircleOutlined />
            }
            onClick={() => pubMut.mutate({ id: r.id, status: r.status })}
          >
            {r.status === 'published' ? '撤' : '发'}
          </Button>
          <Popconfirm
            title="删除此漫画？"
            okButtonProps={{ danger: true }}
            onConfirm={() => delMut.mutate(r.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="漫画管理"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/comics/create')}
          >
            新建漫画
          </Button>
        }
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col flex="1">
          <Input
            placeholder="搜索书名 / 作者..."
            prefix={<SearchOutlined />}
            value={filters.search}
            onChange={(e) =>
              setFilters((p) => ({ ...p, search: e.target.value, page: 1 }))
            }
            allowClear
          />
        </Col>
        <Col>
          <Select
            placeholder="连载状态"
            value={filters.serialStatus || undefined}
            onChange={(v) =>
              setFilters((p) => ({
                ...p,
                serialStatus: (v as ComicSerialStatus) || '',
                page: 1,
              }))
            }
            allowClear
            style={{ width: 130 }}
          >
            <Select.Option value="ongoing">连载中</Select.Option>
            <Select.Option value="finished">已完结</Select.Option>
            <Select.Option value="paused">暂停</Select.Option>
          </Select>
        </Col>
        <Col>
          <Select
            placeholder="发布状态"
            value={filters.status || undefined}
            onChange={(v) =>
              setFilters((p) => ({ ...p, status: (v as ComicStatus) || '', page: 1 }))
            }
            allowClear
            style={{ width: 130 }}
          >
            <Select.Option value="draft">草稿</Select.Option>
            <Select.Option value="published">已发布</Select.Option>
            <Select.Option value="archived">已归档</Select.Option>
          </Select>
        </Col>
      </Row>

      <Table<Comic>
        rowKey="id"
        dataSource={data?.data ?? []}
        columns={columns}
        loading={isLoading}
        pagination={{
          current: filters.page,
          total: data?.meta?.total ?? 0,
          pageSize: 20,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page) => setFilters((p) => ({ ...p, page })),
        }}
        scroll={{ x: 1100 }}
      />
    </div>
  )
}
