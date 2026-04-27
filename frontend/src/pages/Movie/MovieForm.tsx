import React, { useEffect, useState } from 'react'
import {
  App,
  Form,
  Input,
  Button,
  Select,
  Spin,
  Space,
  Row,
  Col,
  InputNumber,
  Switch,
  Card,
  Divider,
  Tabs,
  Table,
  Modal,
  Popconfirm,
  Tag,
  Typography,
} from 'antd'
import {
  SaveOutlined,
  SendOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getMovie,
  createMovie,
  updateMovie,
  addMovieSource,
  deleteMovieSource,
  addMovieEpisode,
  updateMovieEpisode,
  deleteMovieEpisode,
  type CreateMovieData,
  type Movie,
  type MovieEpisode,
  type MovieSource,
} from '../../api/movie'
import PageHeader from '../../components/common/PageHeader'
import MediaPicker from '../../components/media/MediaPicker'
import { generateSlug } from '../../utils'

interface FormValues extends Omit<CreateMovieData, 'sources'> {}

export default function MovieForm() {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const isEditing = Boolean(id)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form] = Form.useForm<FormValues>()

  const { data: movie, isLoading } = useQuery({
    queryKey: ['movie', id],
    queryFn: () => getMovie(id!),
    enabled: isEditing,
  })

  useEffect(() => {
    if (movie) {
      form.setFieldsValue({
        title: movie.title,
        originalTitle: movie.originalTitle,
        slug: movie.slug,
        movieType: movie.movieType,
        subType: movie.subType,
        year: movie.year,
        region: movie.region,
        language: movie.language,
        director: movie.director,
        actors: movie.actors,
        intro: movie.intro,
        posterUrl: movie.posterUrl,
        trailerUrl: movie.trailerUrl,
        duration: movie.duration,
        totalEpisodes: movie.totalEpisodes,
        currentEpisode: movie.currentEpisode,
        isFinished: movie.isFinished,
        score: movie.score,
        isFeatured: movie.isFeatured,
        isVip: movie.isVip,
        metaTitle: movie.metaTitle,
        metaKeywords: movie.metaKeywords,
        metaDescription: movie.metaDescription,
      })
    }
  }, [movie, form])

  const createMutation = useMutation({
    mutationFn: (data: CreateMovieData) => createMovie(data),
    onSuccess: (m) => {
      message.success('创建成功')
      queryClient.invalidateQueries({ queryKey: ['movies'] })
      navigate(`/movies/${m.id}/edit`)
    },
    onError: () => message.error('创建失败'),
  })

  const updateMutation = useMutation({
    mutationFn: (data: Partial<CreateMovieData>) => updateMovie(id!, data),
    onSuccess: () => {
      message.success('更新成功')
      queryClient.invalidateQueries({ queryKey: ['movies'] })
      queryClient.invalidateQueries({ queryKey: ['movie', id] })
    },
    onError: () => message.error('更新失败'),
  })

  const handleSubmit = (publish = false) => {
    form.validateFields().then((values) => {
      const payload: CreateMovieData = {
        ...values,
        ...(publish ? { status: 'published' } : {}),
      }
      if (isEditing) updateMutation.mutate(payload)
      else createMutation.mutate(payload)
    })
  }

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isEditing) {
      form.setFieldValue('slug', generateSlug(e.target.value))
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  if (isEditing && isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={isEditing ? '编辑影视' : '新建影视'}
        extra={<Button onClick={() => navigate('/movies')}>返回列表</Button>}
      />

      <Tabs
        defaultActiveKey="basic"
        items={[
          {
            key: 'basic',
            label: '基本信息',
            children: (
              <Form<FormValues>
                form={form}
                layout="vertical"
                initialValues={{
                  movieType: 'movie',
                  isFinished: false,
                  isFeatured: false,
                  isVip: false,
                  score: 0,
                }}
                style={{ maxWidth: 1100 }}
              >
                <Row gutter={24}>
                  <Col span={16}>
                    <Card size="small" title="基础信息" style={{ marginBottom: 16 }}>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item
                            label="标题"
                            name="title"
                            rules={[{ required: true, message: '请输入标题' }]}
                          >
                            <Input
                              placeholder="例：流浪地球 2"
                              onChange={handleTitleChange}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="原名/外文名" name="originalTitle">
                            <Input placeholder="例：The Wandering Earth II" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item
                            label="Slug"
                            name="slug"
                            rules={[
                              { required: true, message: '请输入 Slug' },
                              {
                                pattern: /^[a-z0-9-]+$/,
                                message: '只能小写字母/数字/连字符',
                              },
                            ]}
                          >
                            <Input placeholder="wandering-earth-2" />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item
                            label="类型"
                            name="movieType"
                            rules={[{ required: true }]}
                          >
                            <Select>
                              <Select.Option value="movie">电影</Select.Option>
                              <Select.Option value="tv">电视剧</Select.Option>
                              <Select.Option value="variety">综艺</Select.Option>
                              <Select.Option value="anime">动漫</Select.Option>
                              <Select.Option value="short">短剧</Select.Option>
                            </Select>
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item label="子分类" name="subType">
                            <Input placeholder="科幻 / 动作" />
                          </Form.Item>
                        </Col>
                      </Row>

                      <Row gutter={12}>
                        <Col span={6}>
                          <Form.Item label="年份" name="year">
                            <InputNumber
                              min={1900}
                              max={2100}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item label="地区" name="region">
                            <Input placeholder="中国大陆 / 美国" />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item label="语言" name="language">
                            <Input placeholder="国语 / 英语" />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item label="评分" name="score">
                            <InputNumber
                              min={0}
                              max={10}
                              step={0.1}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>

                      <Form.Item label="导演" name="director">
                        <Input placeholder="多个用逗号分隔" />
                      </Form.Item>
                      <Form.Item label="主演" name="actors">
                        <Input.TextArea rows={2} placeholder="多个用逗号分隔" />
                      </Form.Item>
                      <Form.Item label="剧情简介" name="intro">
                        <Input.TextArea rows={4} showCount maxLength={2000} />
                      </Form.Item>
                    </Card>

                    <Card size="small" title="集数信息（剧集类填写）">
                      <Row gutter={12}>
                        <Col span={6}>
                          <Form.Item label="时长(分钟)" name="duration">
                            <InputNumber style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item label="总集数" name="totalEpisodes">
                            <InputNumber style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item label="已更新到" name="currentEpisode">
                            <InputNumber style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col span={6}>
                          <Form.Item
                            label="是否完结"
                            name="isFinished"
                            valuePropName="checked"
                          >
                            <Switch />
                          </Form.Item>
                        </Col>
                      </Row>
                    </Card>
                  </Col>

                  <Col span={8}>
                    <Card size="small" title="海报与媒体" style={{ marginBottom: 16 }}>
                      <Form.Item label="海报" name="posterUrl">
                        <MediaPicker />
                      </Form.Item>
                      <Form.Item label="预告片URL" name="trailerUrl">
                        <Input placeholder="https://..." />
                      </Form.Item>
                    </Card>

                    <Card size="small" title="状态" style={{ marginBottom: 16 }}>
                      <Form.Item
                        label="是否推荐"
                        name="isFeatured"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        label="VIP内容"
                        name="isVip"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Card>

                    <Card size="small" title="SEO">
                      <Form.Item label="SEO 标题" name="metaTitle">
                        <Input />
                      </Form.Item>
                      <Form.Item label="SEO 关键字" name="metaKeywords">
                        <Input placeholder="逗号分隔" />
                      </Form.Item>
                      <Form.Item label="SEO 描述" name="metaDescription">
                        <Input.TextArea rows={3} maxLength={500} showCount />
                      </Form.Item>
                    </Card>
                  </Col>
                </Row>

                <Divider />
                <Space>
                  <Button
                    icon={<SaveOutlined />}
                    loading={isPending}
                    onClick={() => handleSubmit(false)}
                  >
                    保存草稿
                  </Button>
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    loading={isPending}
                    onClick={() => handleSubmit(true)}
                  >
                    {isEditing ? '保存并发布' : '立即发布'}
                  </Button>
                  <Button onClick={() => navigate('/movies')}>取消</Button>
                </Space>
              </Form>
            ),
          },
          ...(isEditing
            ? [
                {
                  key: 'sources',
                  label: '播放线路与剧集',
                  children: <SourcesPanel movie={movie!} />,
                },
              ]
            : []),
        ]}
      />
    </div>
  )
}

// ============================================================
// 线路 + 剧集 子面板
// ============================================================

function SourcesPanel({ movie }: { movie: Movie }) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const [sourceModal, setSourceModal] = useState(false)
  const [episodeModal, setEpisodeModal] = useState<MovieSource | null>(null)
  const [editingEpisode, setEditingEpisode] = useState<MovieEpisode | null>(null)

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['movie', movie.id] })

  const sources = movie.sources ?? []

  const addSourceMutation = useMutation({
    mutationFn: (data: { name: string; player?: string; sortOrder?: number }) =>
      addMovieSource(movie.id, { ...data, kind: 'play' }),
    onSuccess: () => {
      message.success('线路已添加')
      setSourceModal(false)
      refresh()
    },
  })

  const deleteSourceMutation = useMutation({
    mutationFn: (sourceId: string) => deleteMovieSource(sourceId),
    onSuccess: () => {
      message.success('线路已删除')
      refresh()
    },
  })

  const addEpMutation = useMutation({
    mutationFn: ({
      sourceId,
      data,
    }: {
      sourceId: string
      data: { title: string; episodeNumber: number; url: string }
    }) => addMovieEpisode(sourceId, data),
    onSuccess: () => {
      message.success('剧集已添加')
      setEpisodeModal(null)
      setEditingEpisode(null)
      refresh()
    },
  })

  const updateEpMutation = useMutation({
    mutationFn: ({
      episodeId,
      data,
    }: {
      episodeId: string
      data: Partial<{ title: string; episodeNumber: number; url: string }>
    }) => updateMovieEpisode(episodeId, data),
    onSuccess: () => {
      message.success('剧集已更新')
      setEpisodeModal(null)
      setEditingEpisode(null)
      refresh()
    },
  })

  const deleteEpMutation = useMutation({
    mutationFn: (episodeId: string) => deleteMovieEpisode(episodeId),
    onSuccess: () => {
      message.success('剧集已删除')
      refresh()
    },
  })

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setSourceModal(true)}
        >
          新增播放线路
        </Button>
        <span style={{ marginLeft: 12, color: '#94A3B8', fontSize: 12 }}>
          共 {sources.length} 条线路
        </span>
      </div>

      {sources.map((src) => (
        <Card
          key={src.id}
          size="small"
          style={{ marginBottom: 12 }}
          title={
            <Space>
              <Tag color="blue">{src.name}</Tag>
              {src.player && <Tag>{src.player}</Tag>}
              <span style={{ fontSize: 12, color: '#94A3B8' }}>
                {src.episodes?.length ?? 0} 集
              </span>
            </Space>
          }
          extra={
            <Space>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => {
                  setEditingEpisode(null)
                  setEpisodeModal(src)
                }}
              >
                添加剧集
              </Button>
              <Popconfirm
                title="删除该线路（含全部剧集）？"
                onConfirm={() => deleteSourceMutation.mutate(src.id)}
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger icon={<DeleteOutlined />}>
                  删除线路
                </Button>
              </Popconfirm>
            </Space>
          }
        >
          <Table<MovieEpisode>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={src.episodes ?? []}
            columns={[
              {
                title: '集数',
                dataIndex: 'episodeNumber',
                width: 70,
              },
              {
                title: '标题',
                dataIndex: 'title',
                width: 160,
              },
              {
                title: '播放URL',
                dataIndex: 'url',
                ellipsis: true,
                render: (u: string) => (
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {u}
                  </Typography.Text>
                ),
              },
              {
                title: '操作',
                key: 'actions',
                width: 140,
                render: (_: unknown, ep: MovieEpisode) => (
                  <Space size="small">
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingEpisode(ep)
                        setEpisodeModal(src)
                      }}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除剧集？"
                      onConfirm={() => deleteEpMutation.mutate(ep.id)}
                      okButtonProps={{ danger: true }}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      ))}

      <SourceModal
        open={sourceModal}
        onClose={() => setSourceModal(false)}
        onSubmit={(v) => addSourceMutation.mutate(v)}
        loading={addSourceMutation.isPending}
      />

      <EpisodeModal
        open={!!episodeModal}
        editing={editingEpisode}
        onClose={() => {
          setEpisodeModal(null)
          setEditingEpisode(null)
        }}
        onSubmit={(v) => {
          if (editingEpisode) {
            updateEpMutation.mutate({ episodeId: editingEpisode.id, data: v })
          } else if (episodeModal) {
            addEpMutation.mutate({ sourceId: episodeModal.id, data: v })
          }
        }}
        loading={addEpMutation.isPending || updateEpMutation.isPending}
      />
    </div>
  )
}

function SourceModal({
  open,
  onClose,
  onSubmit,
  loading,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (v: { name: string; player?: string; sortOrder?: number }) => void
  loading: boolean
}) {
  const [form] = Form.useForm()
  useEffect(() => {
    if (!open) form.resetFields()
  }, [open, form])

  return (
    <Modal
      title="新增播放线路"
      open={open}
      onCancel={onClose}
      onOk={() => form.validateFields().then(onSubmit)}
      confirmLoading={loading}
      destroyOnClose
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          label="线路名称"
          name="name"
          rules={[{ required: true, message: '请输入线路名' }]}
        >
          <Input placeholder="如：线路1 / 西瓜源 / M3U8源" />
        </Form.Item>
        <Form.Item label="播放器类型" name="player">
          <Select allowClear placeholder="选择（可选）">
            <Select.Option value="m3u8">m3u8</Select.Option>
            <Select.Option value="mp4">mp4</Select.Option>
            <Select.Option value="iframe">iframe</Select.Option>
          </Select>
        </Form.Item>
        <Form.Item label="排序" name="sortOrder" initialValue={0}>
          <InputNumber style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function EpisodeModal({
  open,
  editing,
  onClose,
  onSubmit,
  loading,
}: {
  open: boolean
  editing: MovieEpisode | null
  onClose: () => void
  onSubmit: (v: { title: string; episodeNumber: number; url: string }) => void
  loading: boolean
}) {
  const [form] = Form.useForm()
  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue({
          title: editing.title,
          episodeNumber: editing.episodeNumber,
          url: editing.url,
        })
      } else {
        form.resetFields()
      }
    }
  }, [open, editing, form])

  return (
    <Modal
      title={editing ? '编辑剧集' : '添加剧集'}
      open={open}
      onCancel={onClose}
      onOk={() => form.validateFields().then(onSubmit)}
      confirmLoading={loading}
      destroyOnClose
      width={600}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Row gutter={12}>
          <Col span={6}>
            <Form.Item
              label="集数"
              name="episodeNumber"
              rules={[{ required: true }]}
              initialValue={1}
            >
              <InputNumber style={{ width: '100%' }} min={1} />
            </Form.Item>
          </Col>
          <Col span={18}>
            <Form.Item
              label="标题"
              name="title"
              rules={[{ required: true, message: '请输入标题' }]}
            >
              <Input placeholder="第01集" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          label="播放URL"
          name="url"
          rules={[{ required: true, message: '请输入URL' }]}
        >
          <Input.TextArea rows={3} placeholder="https://...m3u8 / .mp4" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
