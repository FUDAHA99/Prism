import React, { useState } from 'react'
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PushpinOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import {
  getNotices,
  createNotice,
  updateNotice,
  toggleNoticePublish,
  deleteNotice,
} from '../../api/notice'
import type { CreateNoticeData } from '../../api/notice'
import PageHeader from '../../components/common/PageHeader'
import type { Notice, NoticeLevel } from '../../types'

const { Text } = Typography
const { TextArea } = Input
const { RangePicker } = DatePicker

type ModalMode = 'create' | 'edit'

interface NoticeFormValues {
  title: string
  content: string
  level: NoticeLevel
  isPinned: boolean
  dateRange?: [dayjs.Dayjs, dayjs.Dayjs]
}

const LEVEL_CONFIG: Record<NoticeLevel, { label: string; color: string; alertType: 'info' | 'success' | 'warning' | 'error' }> = {
  info: { label: '普通', color: 'blue', alertType: 'info' },
  success: { label: '成功', color: 'green', alertType: 'success' },
  warning: { label: '警告', color: 'orange', alertType: 'warning' },
  error: { label: '紧急', color: 'red', alertType: 'error' },
}

export default function NoticePage() {
  const [page, setPage] = useState(1)
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingNotice, setEditingNotice] = useState<Notice | null>(null)
  const [form] = Form.useForm<NoticeFormValues>()

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['notices', page],
    queryFn: () => getNotices({ page, limit: 20 }),
  })

  const notices: Notice[] = data?.data ?? []
  const total = data?.meta?.total ?? 0

  const createMutation = useMutation({
    mutationFn: (dto: CreateNoticeData) => createNotice(dto),
    onSuccess: () => {
      message.success('公告创建成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['notices'] })
    },
    onError: (err: Error) => message.error(err.message || '创建失败'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: CreateNoticeData }) =>
      updateNotice(id, dto),
    onSuccess: () => {
      message.success('公告更新成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['notices'] })
    },
    onError: (err: Error) => message.error(err.message || '更新失败'),
  })

  const toggleMutation = useMutation({
    mutationFn: (id: string) => toggleNoticePublish(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notices'] }),
    onError: () => message.error('操作失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNotice(id),
    onSuccess: () => {
      message.success('公告已删除')
      queryClient.invalidateQueries({ queryKey: ['notices'] })
    },
    onError: (err: Error) => message.error(err.message || '删除失败'),
  })

  const closeModal = () => {
    setModalVisible(false)
    setEditingNotice(null)
    form.resetFields()
  }

  const handleCreate = () => {
    setModalMode('create')
    setEditingNotice(null)
    form.resetFields()
    form.setFieldsValue({ level: 'info', isPinned: false })
    setModalVisible(true)
  }

  const handleEdit = (notice: Notice) => {
    setModalMode('edit')
    setEditingNotice(notice)
    form.setFieldsValue({
      title: notice.title,
      content: notice.content,
      level: notice.level,
      isPinned: notice.isPinned,
      dateRange:
        notice.startDate && notice.endDate
          ? [dayjs(notice.startDate), dayjs(notice.endDate)]
          : undefined,
    })
    setModalVisible(true)
  }

  const buildPayload = (values: NoticeFormValues): CreateNoticeData => ({
    title: values.title,
    content: values.content,
    level: values.level,
    isPinned: values.isPinned,
    startDate: values.dateRange?.[0]?.toISOString(),
    endDate: values.dateRange?.[1]?.toISOString(),
  })

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      const payload = buildPayload(values)
      if (modalMode === 'create') {
        createMutation.mutate(payload)
      } else if (editingNotice) {
        updateMutation.mutate({ id: editingNotice.id, dto: payload })
      }
    })
  }

  const columns: TableColumnsType<Notice> = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record) => (
        <Space>
          {record.isPinned && <PushpinOutlined style={{ color: '#faad14' }} />}
          <Text strong>{title}</Text>
        </Space>
      ),
    },
    {
      title: '级别',
      dataIndex: 'level',
      key: 'level',
      width: 90,
      render: (level: NoticeLevel) => (
        <Tag color={LEVEL_CONFIG[level].color}>{LEVEL_CONFIG[level].label}</Tag>
      ),
    },
    {
      title: '发布状态',
      dataIndex: 'isPublished',
      key: 'isPublished',
      width: 100,
      align: 'center',
      render: (published: boolean, record) => (
        <Switch
          size="small"
          checked={published}
          loading={toggleMutation.isPending}
          onChange={() => toggleMutation.mutate(record.id)}
        />
      ),
    },
    {
      title: '有效期',
      key: 'dates',
      width: 200,
      render: (_, record) => {
        if (!record.startDate && !record.endDate)
          return <Text type="secondary">长期</Text>
        const fmt = (d?: string) => (d ? dayjs(d).format('YYYY-MM-DD') : '—')
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {fmt(record.startDate)} ~ {fmt(record.endDate)}
          </Text>
        )
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (val: string) => new Date(val).toLocaleDateString('zh-CN'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除"
            description={`确认删除公告「${record.title}」？`}
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title="公告管理"
        subtitle="发布和管理站点公告通知"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            发布公告
          </Button>
        }
      />

      <Table
        rowKey="id"
        columns={columns}
        dataSource={notices}
        loading={isLoading}
        scroll={{ x: 800 }}
        pagination={{
          current: page,
          pageSize: 20,
          total,
          onChange: (p) => setPage(p),
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条公告`,
        }}
        size="middle"
      />

      <Modal
        title={modalMode === 'create' ? '发布公告' : `编辑公告：${editingNotice?.title ?? ''}`}
        open={modalVisible}
        onCancel={closeModal}
        onOk={handleSubmit}
        okText={modalMode === 'create' ? '发布' : '保存'}
        cancelText="取消"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={580}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="title"
            label="公告标题"
            rules={[{ required: true, message: '请输入公告标题' }]}
          >
            <Input placeholder="请输入公告标题" maxLength={200} />
          </Form.Item>

          <Form.Item
            name="content"
            label="公告内容"
            rules={[{ required: true, message: '请输入公告内容' }]}
          >
            <TextArea rows={5} placeholder="请输入公告内容" maxLength={2000} showCount />
          </Form.Item>

          <Form.Item name="level" label="公告级别" initialValue="info">
            <Select
              options={Object.entries(LEVEL_CONFIG).map(([value, cfg]) => ({
                label: (
                  <Alert
                    message={cfg.label}
                    type={cfg.alertType}
                    banner
                    style={{ padding: '2px 8px' }}
                  />
                ),
                value,
              }))}
            />
          </Form.Item>

          <Form.Item name="isPinned" label="置顶" valuePropName="checked" initialValue={false}>
            <Switch checkedChildren="置顶" unCheckedChildren="不置顶" />
          </Form.Item>

          <Form.Item name="dateRange" label="有效期（不填则长期有效）">
            <RangePicker style={{ width: '100%' }} placeholder={['开始日期', '结束日期']} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
