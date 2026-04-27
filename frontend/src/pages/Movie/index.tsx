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
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getMovies,
  deleteMovie,
  publishMovie,
  unpublishMovie,
  type Movie,
  type MovieStatus,
  type MovieType,
} from '../../api/movie'
import PageHeader from '../../components/common/PageHeader'
import { formatDate } from '../../utils'

const TYPE_LABELS: Record<MovieType, string> = {
  movie: '电影',
  tv: '电视剧',
  variety: '综艺',
  anime: '动漫',
  short: '短剧',
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
  status: MovieStatus | ''
  movieType: MovieType | ''
  page: number
}

export default function MovieList() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [filters, setFilters] = useState<Filters>({
    search: '',
    status: '',
    movieType: '',
    page: 1,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['movies', filters],
    queryFn: () =>
      getMovies({
        search: filters.search || undefined,
        status: filters.status || undefined,
        movieType: filters.movieType || undefined,
        page: filters.page,
        limit: 20,
      }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMovie(id),
    onSuccess: () => {
      message.success('删除成功')
      queryClient.invalidateQueries({ queryKey: ['movies'] })
    },
    onError: () => message.error('删除失败'),
  })

  const publishMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: MovieStatus }) =>
      status === 'published' ? unpublishMovie(id) : publishMovie(id),
    onSuccess: (_d, v) => {
      message.success(v.status === 'published' ? '已取消发布' : '发布成功')
      queryClient.invalidateQueries({ queryKey: ['movies'] })
    },
    onError: () => message.error('操作失败'),
  })

  const columns: TableColumnsType<Movie> = [
    {
      title: '海报',
      dataIndex: 'posterUrl',
      key: 'posterUrl',
      width: 70,
      render: (url?: string) =>
        url ? (
          <Image
            src={url}
            width={48}
            height={64}
            style={{ objectFit: 'cover', borderRadius: 4 }}
            preview={{ mask: '预览' }}
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
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (t: string, r: Movie) => (
        <div>
          <Typography.Text strong>{t}</Typography.Text>
          {r.originalTitle && (
            <div style={{ fontSize: 12, color: '#94A3B8' }}>{r.originalTitle}</div>
          )}
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'movieType',
      key: 'movieType',
      width: 90,
      render: (t: MovieType) => <Tag>{TYPE_LABELS[t] ?? t}</Tag>,
    },
    {
      title: '年份/地区',
      key: 'year',
      width: 120,
      render: (_: unknown, r: Movie) =>
        `${r.year ?? '-'} / ${r.region ?? '-'}`,
    },
    {
      title: '集数',
      key: 'episodes',
      width: 100,
      render: (_: unknown, r: Movie) =>
        r.totalEpisodes
          ? `${r.currentEpisode ?? 0}/${r.totalEpisodes}`
          : r.duration
            ? `${r.duration}分钟`
            : '-',
    },
    {
      title: '评分',
      dataIndex: 'score',
      key: 'score',
      width: 70,
      align: 'right',
      render: (v: number) => (v ? Number(v).toFixed(1) : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: string) => (
        <Badge
          status={STATUS_COLOR[s] as 'default' | 'success' | 'warning' | 'error'}
          text={STATUS_LABEL[s] ?? s}
        />
      ),
    },
    {
      title: '播放量',
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
      width: 200,
      render: (_: unknown, r: Movie) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/movies/${r.id}/edit`)}
          >
            编辑
          </Button>
          <Button
            size="small"
            icon={
              r.status === 'published' ? <StopOutlined /> : <CheckCircleOutlined />
            }
            onClick={() =>
              publishMutation.mutate({ id: r.id, status: r.status })
            }
          >
            {r.status === 'published' ? '取消发布' : '发布'}
          </Button>
          <Popconfirm
            title="确认删除此影视？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteMutation.mutate(r.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="影视管理"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/movies/create')}
          >
            新建影视
          </Button>
        }
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col flex="1">
          <Input
            placeholder="搜索标题 / 导演 / 演员..."
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
            placeholder="全部类型"
            value={filters.movieType || undefined}
            onChange={(v) =>
              setFilters((p) => ({ ...p, movieType: (v as MovieType) || '', page: 1 }))
            }
            allowClear
            style={{ width: 130 }}
          >
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <Select.Option key={k} value={k}>
                {v}
              </Select.Option>
            ))}
          </Select>
        </Col>
        <Col>
          <Select
            placeholder="全部状态"
            value={filters.status || undefined}
            onChange={(v) =>
              setFilters((p) => ({ ...p, status: (v as MovieStatus) || '', page: 1 }))
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

      <Table<Movie>
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
        scroll={{ x: 1200 }}
      />
    </div>
  )
}
