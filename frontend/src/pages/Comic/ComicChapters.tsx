import React, { useEffect, useState } from 'react'
import {
  App,
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Popconfirm,
  Tag,
  Typography,
  Row,
  Col,
  Upload,
  Image,
} from 'antd'
import type { TableColumnsType } from 'antd'
import type { RcFile } from 'antd/es/upload'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ArrowLeftOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getComic,
  listComicChapters,
  addComicChapter,
  updateComicChapter,
  deleteComicChapter,
  type ComicChapter,
  type CreateComicChapterData,
} from '../../api/comic'
import { uploadFile } from '../../api/media'
import PageHeader from '../../components/common/PageHeader'
import { formatDate } from '../../utils'

export default function ComicChaptersPage() {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<ComicChapter | null>(null)
  const [open, setOpen] = useState(false)

  const { data: comic } = useQuery({
    queryKey: ['comic', id],
    queryFn: () => getComic(id!),
    enabled: !!id,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['comic-chapters', id, page],
    queryFn: () => listComicChapters(id!, { page, limit: 20 }),
    enabled: !!id,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['comic-chapters', id] })
    qc.invalidateQueries({ queryKey: ['comic', id] })
  }

  const addMut = useMutation({
    mutationFn: (d: CreateComicChapterData) => addComicChapter(id!, d),
    onSuccess: () => {
      message.success('已添加')
      setOpen(false)
      setEditing(null)
      refresh()
    },
  })

  const updateMut = useMutation({
    mutationFn: ({
      chapterId,
      data,
    }: {
      chapterId: string
      data: Partial<CreateComicChapterData>
    }) => updateComicChapter(chapterId, data),
    onSuccess: () => {
      message.success('已更新')
      setOpen(false)
      setEditing(null)
      refresh()
    },
  })

  const delMut = useMutation({
    mutationFn: (chapterId: string) => deleteComicChapter(chapterId),
    onSuccess: () => {
      message.success('已删除')
      refresh()
    },
  })

  const columns: TableColumnsType<ComicChapter> = [
    {
      title: '#',
      dataIndex: 'chapterNumber',
      key: 'chapterNumber',
      width: 70,
    },
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
    },
    {
      title: '图片数',
      dataIndex: 'pageCount',
      key: 'pageCount',
      width: 90,
      align: 'right',
      render: (v: number) => `${v} 页`,
    },
    {
      title: '状态',
      key: 'status',
      width: 130,
      render: (_: unknown, r: ComicChapter) => (
        <Space size={4}>
          {r.isPublished ? (
            <Tag color="success">已发布</Tag>
          ) : (
            <Tag>草稿</Tag>
          )}
          {r.isVip && <Tag color="gold">VIP</Tag>}
        </Space>
      ),
    },
    {
      title: '阅读',
      dataIndex: 'viewCount',
      key: 'viewCount',
      width: 70,
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
      width: 160,
      render: (_: unknown, r: ComicChapter) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(r)
              setOpen(true)
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title="删除该章节？"
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
        title={`章节管理${comic ? ` - ${comic.title}` : ''}`}
        extra={
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/comics')}
            >
              返回列表
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null)
                setOpen(true)
              }}
            >
              新建章节
            </Button>
          </Space>
        }
      />

      {comic && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">共 {comic.chapterCount} 话</Typography.Text>
        </div>
      )}

      <Table<ComicChapter>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.data ?? []}
        columns={columns}
        pagination={{
          current: page,
          total: data?.meta?.total ?? 0,
          pageSize: 20,
          showTotal: (t) => `共 ${t} 条`,
          onChange: setPage,
        }}
      />

      <ComicChapterModal
        open={open}
        editing={editing}
        onClose={() => {
          setOpen(false)
          setEditing(null)
        }}
        onSubmit={(v) => {
          if (editing) {
            updateMut.mutate({ chapterId: editing.id, data: v })
          } else {
            addMut.mutate(v)
          }
        }}
        loading={addMut.isPending || updateMut.isPending}
      />
    </div>
  )
}

function ComicChapterModal({
  open,
  editing,
  onClose,
  onSubmit,
  loading,
}: {
  open: boolean
  editing: ComicChapter | null
  onClose: () => void
  onSubmit: (v: CreateComicChapterData) => void
  loading: boolean
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<CreateComicChapterData>()
  const [pages, setPages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue({
          chapterNumber: editing.chapterNumber,
          title: editing.title,
          isVip: editing.isVip,
          isPublished: editing.isPublished,
        })
        setPages(editing.pageUrls ?? [])
      } else {
        form.resetFields()
        setPages([])
      }
    }
  }, [open, editing, form])

  const handleUpload = async (file: RcFile) => {
    setUploading(true)
    try {
      const media = await uploadFile(file)
      const url = (media as any).data?.url ?? (media as any).url
      setPages((p) => [...p, url])
    } catch {
      message.error(`${file.name} 上传失败`)
    } finally {
      setUploading(false)
    }
    return false
  }

  const removePage = (idx: number) =>
    setPages((p) => p.filter((_, i) => i !== idx))

  const movePage = (idx: number, dir: -1 | 1) => {
    setPages((p) => {
      const next = [...p]
      const target = idx + dir
      if (target < 0 || target >= next.length) return p
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  return (
    <Modal
      title={editing ? '编辑章节' : '新建章节'}
      open={open}
      onCancel={onClose}
      onOk={() =>
        form.validateFields().then((values) =>
          onSubmit({ ...values, pageUrls: pages }),
        )
      }
      confirmLoading={loading}
      destroyOnClose
      width={900}
    >
      <Form<CreateComicChapterData>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ isVip: false, isPublished: true }}
      >
        <Row gutter={12}>
          <Col span={6}>
            <Form.Item label="章节序号" name="chapterNumber">
              <InputNumber style={{ width: '100%' }} placeholder="留空自动顺序" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="章节标题"
              name="title"
              rules={[{ required: true, message: '请输入标题' }]}
            >
              <Input placeholder="第一话 ……" />
            </Form.Item>
          </Col>
          <Col span={3}>
            <Form.Item label="VIP" name="isVip" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col span={3}>
            <Form.Item label="发布" name="isPublished" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label={`漫画页 (${pages.length} 张)`}>
          <Upload
            accept="image/*"
            multiple
            showUploadList={false}
            beforeUpload={handleUpload}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              批量上传图片
            </Button>
          </Upload>

          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 8,
            }}
          >
            {pages.map((url, idx) => (
              <div
                key={`${url}-${idx}`}
                style={{
                  position: 'relative',
                  border: '1px solid #E2E8F0',
                  borderRadius: 4,
                  padding: 4,
                  background: '#fff',
                }}
              >
                <Image
                  src={url}
                  width="100%"
                  height={140}
                  style={{ objectFit: 'cover', borderRadius: 2 }}
                />
                <div
                  style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    background: 'rgba(15,23,42,0.7)',
                    color: '#fff',
                    fontSize: 11,
                    padding: '0 6px',
                    borderRadius: 2,
                  }}
                >
                  {idx + 1}
                </div>
                <Space
                  size={2}
                  style={{
                    position: 'absolute',
                    bottom: 4,
                    right: 4,
                  }}
                >
                  <Button
                    size="small"
                    onClick={() => movePage(idx, -1)}
                    disabled={idx === 0}
                  >
                    ←
                  </Button>
                  <Button
                    size="small"
                    onClick={() => movePage(idx, 1)}
                    disabled={idx === pages.length - 1}
                  >
                    →
                  </Button>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removePage(idx)}
                  />
                </Space>
              </div>
            ))}
          </div>
        </Form.Item>
      </Form>
    </Modal>
  )
}
