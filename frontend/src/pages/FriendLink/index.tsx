import React, { useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getFriendLinks,
  createFriendLink,
  updateFriendLink,
  deleteFriendLink,
} from '../../api/friendLink'
import type { CreateFriendLinkData } from '../../api/friendLink'
import PageHeader from '../../components/common/PageHeader'
import type { FriendLink } from '../../types'

const { Text, Link } = Typography

type ModalMode = 'create' | 'edit'

type FriendLinkFormValues = CreateFriendLinkData

export default function FriendLinkPage() {
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingLink, setEditingLink] = useState<FriendLink | null>(null)
  const [form] = Form.useForm<FriendLinkFormValues>()

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['friend-links'],
    queryFn: getFriendLinks,
  })

  const createMutation = useMutation({
    mutationFn: (values: FriendLinkFormValues) => createFriendLink(values),
    onSuccess: () => {
      message.success('友情链接创建成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['friend-links'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '创建失败，请重试')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: FriendLinkFormValues }) =>
      updateFriendLink(id, values),
    onSuccess: () => {
      message.success('友情链接更新成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['friend-links'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '更新失败，请重试')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFriendLink(id),
    onSuccess: () => {
      message.success('友情链接已删除')
      queryClient.invalidateQueries({ queryKey: ['friend-links'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '删除失败，请重试')
    },
  })

  const closeModal = () => {
    setModalVisible(false)
    setEditingLink(null)
    form.resetFields()
  }

  const handleCreate = () => {
    setModalMode('create')
    setEditingLink(null)
    form.resetFields()
    form.setFieldsValue({ sortOrder: 0, isVisible: true })
    setModalVisible(true)
  }

  const handleEdit = (link: FriendLink) => {
    setModalMode('edit')
    setEditingLink(link)
    form.setFieldsValue({
      name: link.name,
      url: link.url,
      logo: link.logo,
      description: link.description,
      sortOrder: link.sortOrder,
      isVisible: link.isVisible,
    })
    setModalVisible(true)
  }

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      if (modalMode === 'create') {
        createMutation.mutate(values)
      } else if (editingLink) {
        updateMutation.mutate({ id: editingLink.id, values })
      }
    })
  }

  const links: FriendLink[] = data ?? []

  const columns: TableColumnsType<FriendLink> = [
    {
      title: '网站名称',
      dataIndex: 'name',
      key: 'name',
      width: 140,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'URL',
      dataIndex: 'url',
      key: 'url',
      ellipsis: true,
      render: (url: string) => (
        <Link href={url} target="_blank" rel="noopener noreferrer">
          <LinkOutlined style={{ marginRight: 4 }} />
          {url}
        </Link>
      ),
    },
    {
      title: '显示',
      dataIndex: 'isVisible',
      key: 'isVisible',
      width: 80,
      align: 'center',
      render: (visible: boolean) => (
        <Tag color={visible ? 'success' : 'default'}>{visible ? '显示' : '隐藏'}</Tag>
      ),
    },
    {
      title: '排序',
      dataIndex: 'sortOrder',
      key: 'sortOrder',
      width: 80,
      align: 'center',
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
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
            description={`确认删除友情链接「${record.name}」？`}
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
        title="友情链接"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建链接
          </Button>
        }
      />

      <Table
        rowKey="id"
        columns={columns}
        dataSource={links}
        loading={isLoading}
        scroll={{ x: 800 }}
        pagination={{
          pageSize: 20,
          showTotal: (total) => `共 ${total} 个友情链接`,
          showSizeChanger: false,
        }}
        size="middle"
      />

      <Modal
        title={
          modalMode === 'create'
            ? '新建友情链接'
            : `编辑链接：${editingLink?.name ?? ''}`
        }
        open={modalVisible}
        onCancel={closeModal}
        onOk={handleSubmit}
        okText={modalMode === 'create' ? '创建' : '保存'}
        cancelText="取消"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={500}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="网站名称"
            rules={[{ required: true, message: '请输入网站名称' }]}
          >
            <Input placeholder="请输入网站名称" maxLength={100} />
          </Form.Item>

          <Form.Item
            name="url"
            label="网站URL"
            rules={[
              { required: true, message: '请输入网站URL' },
              { type: 'url', message: '请输入有效的URL地址（需包含 http:// 或 https://）' },
            ]}
          >
            <Input placeholder="https://example.com" maxLength={500} />
          </Form.Item>

          <Form.Item name="logo" label="Logo图片URL">
            <Input placeholder="https://example.com/logo.png（可选）" maxLength={500} />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <Input.TextArea placeholder="网站描述（可选）" rows={2} maxLength={200} showCount />
          </Form.Item>

          <Form.Item name="sortOrder" label="排序值" initialValue={0}>
            <InputNumber min={0} max={9999} style={{ width: '100%' }} placeholder="数值越小越靠前" />
          </Form.Item>

          <Form.Item name="isVisible" label="是否显示" valuePropName="checked" initialValue={true}>
            <Switch checkedChildren="显示" unCheckedChildren="隐藏" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
