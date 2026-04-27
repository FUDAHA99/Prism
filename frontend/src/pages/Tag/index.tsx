import React, { useState } from 'react'
import {
  Button,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getTags, createTag, updateTag, deleteTag } from '../../api/tag'
import PageHeader from '../../components/common/PageHeader'
import type { Tag } from '../../types'

const { Text } = Typography

type ModalMode = 'create' | 'edit'

interface TagFormValues {
  name: string
  slug: string
}

/** 生成 slug */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export default function TagPage() {
  const [search, setSearch] = useState('')
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingTag, setEditingTag] = useState<Tag | null>(null)
  const [form] = Form.useForm<TagFormValues>()

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['tags', search],
    queryFn: () => getTags(search || undefined),
  })

  const createMutation = useMutation({
    mutationFn: (values: TagFormValues) => createTag(values),
    onSuccess: () => {
      message.success('标签创建成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '创建失败，请重试')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: TagFormValues }) =>
      updateTag(id, values),
    onSuccess: () => {
      message.success('标签更新成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '更新失败，请重试')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTag(id),
    onSuccess: () => {
      message.success('标签已删除')
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '删除失败，请重试')
    },
  })

  const closeModal = () => {
    setModalVisible(false)
    setEditingTag(null)
    form.resetFields()
  }

  const handleCreate = () => {
    setModalMode('create')
    setEditingTag(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (tag: Tag) => {
    setModalMode('edit')
    setEditingTag(tag)
    form.setFieldsValue({ name: tag.name, slug: tag.slug })
    setModalVisible(true)
  }

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      if (modalMode === 'create') {
        createMutation.mutate(values)
      } else if (editingTag) {
        updateMutation.mutate({ id: editingTag.id, values })
      }
    })
  }

  /** 名称变化时自动生成 slug（编辑时若 slug 未手动修改则跟随） */
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const currentSlug = form.getFieldValue('slug') as string
    if (!currentSlug || (editingTag && currentSlug === editingTag.slug)) {
      form.setFieldValue('slug', generateSlug(e.target.value))
    }
  }

  const tags: Tag[] = data ?? []

  const columns: TableColumnsType<Tag> = [
    {
      title: '标签名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Slug',
      dataIndex: 'slug',
      key: 'slug',
      render: (slug: string) => <Text code>{slug}</Text>,
    },
    {
      title: '使用量',
      dataIndex: 'usageCount',
      key: 'usageCount',
      width: 100,
      align: 'center',
      render: (count: number | undefined) => (
        <Text type={count ? undefined : 'secondary'}>{count ?? 0}</Text>
      ),
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
            description={`确认删除标签「${record.name}」？`}
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
        title="标签管理"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建标签
          </Button>
        }
      />

      {/* 搜索框 */}
      <div style={{ marginBottom: 16, maxWidth: 320 }}>
        <Input
          placeholder="搜索标签名称或 slug"
          prefix={<SearchOutlined />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={tags}
        loading={isLoading}
        scroll={{ x: 700 }}
        pagination={{
          pageSize: 20,
          showTotal: (total) => `共 ${total} 个标签`,
          showSizeChanger: false,
        }}
        size="middle"
      />

      <Modal
        title={modalMode === 'create' ? '新建标签' : `编辑标签：${editingTag?.name ?? ''}`}
        open={modalVisible}
        onCancel={closeModal}
        onOk={handleSubmit}
        okText={modalMode === 'create' ? '创建' : '保存'}
        cancelText="取消"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={440}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="标签名称"
            rules={[{ required: true, message: '请输入标签名称' }]}
          >
            <Input
              placeholder="请输入标签名称"
              maxLength={50}
              onChange={handleNameChange}
            />
          </Form.Item>

          <Form.Item
            name="slug"
            label="Slug"
            rules={[
              { required: true, message: '请输入 Slug' },
              {
                pattern: /^[a-z0-9-]+$/,
                message: 'Slug 只能包含小写字母、数字和连字符',
              },
            ]}
          >
            <Input placeholder="url-friendly-slug" maxLength={80} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
