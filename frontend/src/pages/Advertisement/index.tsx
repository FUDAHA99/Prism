import React, { useState } from 'react'
import {
  Badge,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
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
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import {
  getAdvertisements,
  createAdvertisement,
  updateAdvertisement,
  toggleAdvertisement,
  deleteAdvertisement,
} from '../../api/advertisement'
import type { CreateAdData } from '../../api/advertisement'
import PageHeader from '../../components/common/PageHeader'
import type { Advertisement, AdType } from '../../types'

const { Text } = Typography
const { TextArea } = Input
const { RangePicker } = DatePicker

type ModalMode = 'create' | 'edit'

interface AdFormValues {
  title: string
  code: string
  type: AdType
  content?: string
  linkUrl?: string
  position?: string
  sortOrder?: number
  dateRange?: [dayjs.Dayjs, dayjs.Dayjs]
}

const AD_TYPE_LABELS: Record<AdType, string> = {
  image: '图片广告',
  code: '代码广告',
  text: '文字广告',
}

const AD_TYPE_COLORS: Record<AdType, string> = {
  image: 'blue',
  code: 'purple',
  text: 'green',
}

export default function AdvertisementPage() {
  const [search, setSearch] = useState('')
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingAd, setEditingAd] = useState<Advertisement | null>(null)
  const [form] = Form.useForm<AdFormValues>()

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['advertisements', search],
    queryFn: () => getAdvertisements(search || undefined),
  })

  const createMutation = useMutation({
    mutationFn: (values: CreateAdData) => createAdvertisement(values),
    onSuccess: () => {
      message.success('广告创建成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['advertisements'] })
    },
    onError: (err: Error) => message.error(err.message || '创建失败'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: CreateAdData }) =>
      updateAdvertisement(id, data),
    onSuccess: () => {
      message.success('广告更新成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['advertisements'] })
    },
    onError: (err: Error) => message.error(err.message || '更新失败'),
  })

  const toggleMutation = useMutation({
    mutationFn: (id: string) => toggleAdvertisement(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['advertisements'] }),
    onError: () => message.error('操作失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdvertisement(id),
    onSuccess: () => {
      message.success('广告已删除')
      queryClient.invalidateQueries({ queryKey: ['advertisements'] })
    },
    onError: (err: Error) => message.error(err.message || '删除失败'),
  })

  const closeModal = () => {
    setModalVisible(false)
    setEditingAd(null)
    form.resetFields()
  }

  const handleCreate = () => {
    setModalMode('create')
    setEditingAd(null)
    form.resetFields()
    form.setFieldsValue({ type: 'image', sortOrder: 0 })
    setModalVisible(true)
  }

  const handleEdit = (ad: Advertisement) => {
    setModalMode('edit')
    setEditingAd(ad)
    form.setFieldsValue({
      title: ad.title,
      code: ad.code,
      type: ad.type,
      content: ad.content,
      linkUrl: ad.linkUrl,
      position: ad.position,
      sortOrder: ad.sortOrder,
      dateRange:
        ad.startDate && ad.endDate
          ? [dayjs(ad.startDate), dayjs(ad.endDate)]
          : undefined,
    })
    setModalVisible(true)
  }

  const buildPayload = (values: AdFormValues): CreateAdData => ({
    title: values.title,
    code: values.code,
    type: values.type,
    content: values.content,
    linkUrl: values.linkUrl,
    position: values.position,
    sortOrder: values.sortOrder ?? 0,
    startDate: values.dateRange?.[0]?.toISOString(),
    endDate: values.dateRange?.[1]?.toISOString(),
  })

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      const payload = buildPayload(values)
      if (modalMode === 'create') {
        createMutation.mutate(payload)
      } else if (editingAd) {
        updateMutation.mutate({ id: editingAd.id, data: payload })
      }
    })
  }

  const ads = data ?? []

  const columns: TableColumnsType<Advertisement> = [
    {
      title: '广告标题',
      dataIndex: 'title',
      key: 'title',
      width: 160,
      render: (title: string) => <Text strong>{title}</Text>,
    },
    {
      title: '广告位代码',
      dataIndex: 'code',
      key: 'code',
      width: 140,
      render: (code: string) => <Text code>{code}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (type: AdType) => (
        <Tag color={AD_TYPE_COLORS[type]}>{AD_TYPE_LABELS[type]}</Tag>
      ),
    },
    {
      title: '位置',
      dataIndex: 'position',
      key: 'position',
      render: (pos: string) => <Text type="secondary">{pos || '—'}</Text>,
    },
    {
      title: '排序',
      dataIndex: 'sortOrder',
      key: 'sortOrder',
      width: 70,
      align: 'center',
    },
    {
      title: '状态',
      dataIndex: 'isActive',
      key: 'isActive',
      width: 90,
      align: 'center',
      render: (active: boolean, record) => (
        <Switch
          size="small"
          checked={active}
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
        if (!record.startDate && !record.endDate) return <Text type="secondary">长期</Text>
        const fmt = (d?: string) => d ? dayjs(d).format('YYYY-MM-DD') : '—'
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {fmt(record.startDate)} ~ {fmt(record.endDate)}
          </Text>
        )
      },
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
            description={`确认删除广告「${record.title}」？`}
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
        title="广告管理"
        subtitle="管理站点各位置的广告投放"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建广告
          </Button>
        }
      />

      <div style={{ marginBottom: 16, maxWidth: 320 }}>
        <Input
          placeholder="搜索广告标题或代码"
          prefix={<SearchOutlined />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={ads}
        loading={isLoading}
        scroll={{ x: 900 }}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (t) => `共 ${t} 个广告` }}
        size="middle"
      />

      <Modal
        title={modalMode === 'create' ? '新建广告' : `编辑广告：${editingAd?.title ?? ''}`}
        open={modalVisible}
        onCancel={closeModal}
        onOk={handleSubmit}
        okText={modalMode === 'create' ? '创建' : '保存'}
        cancelText="取消"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="title"
            label="广告标题"
            rules={[{ required: true, message: '请输入广告标题' }]}
          >
            <Input placeholder="如：首页顶部横幅" maxLength={100} />
          </Form.Item>

          <Form.Item
            name="code"
            label="广告位代码"
            rules={[{ required: true, message: '请输入广告位代码' }]}
            tooltip="唯一标识符，用于前端调用，如 banner_top"
          >
            <Input placeholder="banner_top" maxLength={100} />
          </Form.Item>

          <Form.Item name="type" label="广告类型" initialValue="image">
            <Select
              options={[
                { label: '图片广告', value: 'image' },
                { label: '代码广告（HTML）', value: 'code' },
                { label: '文字广告', value: 'text' },
              ]}
            />
          </Form.Item>

          <Form.Item name="content" label="广告内容" tooltip="图片URL / HTML代码 / 文字内容">
            <TextArea rows={3} placeholder="图片URL、HTML代码或文字内容" maxLength={2000} showCount />
          </Form.Item>

          <Form.Item name="linkUrl" label="跳转链接">
            <Input placeholder="https://example.com（可选）" maxLength={500} />
          </Form.Item>

          <Form.Item name="position" label="位置描述">
            <Input placeholder="如：首页顶部、侧边栏等（可选）" maxLength={100} />
          </Form.Item>

          <Form.Item name="sortOrder" label="排序值" initialValue={0}>
            <InputNumber min={0} max={9999} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="dateRange" label="有效期">
            <RangePicker style={{ width: '100%' }} placeholder={['开始日期', '结束日期']} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
