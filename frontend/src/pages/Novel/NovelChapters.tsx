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
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getNovel,
  listNovelChapters,
  getNovelChapter,
  addNovelChapter,
  updateNovelChapter,
  deleteNovelChapter,
  type NovelChapter,
  type CreateNovelChapterData,
} from '../../api/novel'
import PageHeader from '../../components/common/PageHeader'
import { formatDate } from '../../utils'

export default function NovelChaptersPage() {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<NovelChapter | null>(null)
  const [open, setOpen] = useState(false)

  const { data: novel } = useQuery({
    queryKey: ['novel', id],
    queryFn: () => getNovel(id!),
    enabled: !!id,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['novel-chapters', id, page],
    queryFn: () => listNovelChapters(id!, { page, limit: 20 }),
    enabled: !!id,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['novel-chapters', id] })
    qc.invalidateQueries({ queryKey: ['novel', id] })
  }

  const addMut = useMutation({
    mutationFn: (d: CreateNovelChapterData) => addNovelChapter(id!, d),
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
      data: Partial<CreateNovelChapterData>
    }) => updateNovelChapter(chapterId, data),
    onSuccess: () => {
      message.success('已更新')
      setOpen(false)
      setEditing(null)
      refresh()
    },
  })

  const delMut = useMutation({
    mutationFn: (chapterId: string) => deleteNovelChapter(chapterId),
    onSuccess: () => {
      message.success('已删除')
      refresh()
    },
  })

  const columns: TableColumnsType<NovelChapter> = [
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
      title: '字数',
      dataIndex: 'wordCount',
      key: 'wordCount',
      width: 90,
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '状态',
      key: 'status',
      width: 130,
      render: (_: unknown, r: NovelChapter) => (
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
      render: (_: unknown, r: NovelChapter) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={async () => {
              const full = await getNovelChapter(r.id)
              setEditing(full)
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
        title={`章节管理${novel ? ` - ${novel.title}` : ''}`}
        extra={
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/novels')}
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

      {novel && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">
            共 {novel.chapterCount} 章 / {novel.wordCount.toLocaleString()} 字
          </Typography.Text>
        </div>
      )}

      <Table<NovelChapter>
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

      <ChapterModal
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

function ChapterModal({
  open,
  editing,
  onClose,
  onSubmit,
  loading,
}: {
  open: boolean
  editing: NovelChapter | null
  onClose: () => void
  onSubmit: (v: CreateNovelChapterData) => void
  loading: boolean
}) {
  const [form] = Form.useForm<CreateNovelChapterData>()

  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue({
          chapterNumber: editing.chapterNumber,
          title: editing.title,
          content: editing.content ?? '',
          isVip: editing.isVip,
          isPublished: editing.isPublished,
        })
      } else {
        form.resetFields()
      }
    }
  }, [open, editing, form])

  return (
    <Modal
      title={editing ? '编辑章节' : '新建章节'}
      open={open}
      onCancel={onClose}
      onOk={() => form.validateFields().then(onSubmit)}
      confirmLoading={loading}
      destroyOnClose
      width={900}
    >
      <Form<CreateNovelChapterData>
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
              <Input placeholder="第一章 ……" />
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
        <Form.Item
          label="正文"
          name="content"
          rules={[{ required: true, message: '请输入正文' }]}
        >
          <Input.TextArea rows={20} showCount />
        </Form.Item>
      </Form>
    </Modal>
  )
}
