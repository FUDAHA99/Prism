import React, { useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCategory,
  deleteCategory,
  getCategories,
  updateCategory,
} from '../../api/category'
import PageHeader from '../../components/common/PageHeader'
import type { Category } from '../../types'

const { Text } = Typography

type ModalMode = 'create' | 'edit'

interface CategoryFormValues {
  name: string
  slug: string
  description?: string
  parentId?: string
  sortOrder: number
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export default function CategoryPage() {
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [form] = Form.useForm<CategoryFormValues>()

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: () => getCategories(),
  })

  const createMutation = useMutation({
    mutationFn: (values: CategoryFormValues) =>
      createCategory({
        name: values.name,
        slug: values.slug,
        description: values.description,
        parentId: values.parentId,
        sortOrder: values.sortOrder,
      }),
    onSuccess: () => {
      message.success('分类创建成功')
      setModalVisible(false)
      form.resetFields()
      queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: () => {
      message.error('创建失败，请重试')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: CategoryFormValues }) =>
      updateCategory(id, {
        name: values.name,
        slug: values.slug,
        description: values.description,
        parentId: values.parentId,
        sortOrder: values.sortOrder,
      }),
    onSuccess: () => {
      message.success('分类更新成功')
      setModalVisible(false)
      setEditingCategory(null)
      form.resetFields()
      queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: () => {
      message.error('更新失败，请重试')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCategory(id),
    onSuccess: () => {
      message.success('分类已删除')
      queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: () => {
      message.error('删除失败，请重试')
    },
  })

  const handleCreate = () => {
    setModalMode('create')
    setEditingCategory(null)
    form.resetFields()
    form.setFieldsValue({ sortOrder: 0 })
    setModalVisible(true)
  }

  const handleEdit = (category: Category) => {
    setModalMode('edit')
    setEditingCategory(category)
    form.setFieldsValue({
      name: category.name,
      slug: category.slug,
      description: category.description,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
    })
    setModalVisible(true)
  }

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      if (modalMode === 'create') {
        createMutation.mutate(values)
      } else if (editingCategory) {
        updateMutation.mutate({ id: editingCategory.id, values })
      }
    })
  }

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const currentSlug = form.getFieldValue('slug') as string
    if (!currentSlug || (editingCategory && currentSlug === editingCategory.slug)) {
      form.setFieldValue('slug', generateSlug(e.target.value))
    }
  }

  const categories: Category[] = data ?? []

  const parentOptions = categories
    .filter((c) => c.id !== editingCategory?.id)
    .map((c) => ({ label: c.name, value: c.id }))

  const columns: TableColumnsType<Category> = [
    {
      title: '分类名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Slug',
      dataIndex: 'slug',
      key: 'slug',
      width: 160,
      render: (slug: string) => <Text code>{slug}</Text>,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (val: string | undefined) => val ?? <Text type="secondary">-</Text>,
    },
    {
      title: '父分类',
      key: 'parent',
      width: 140,
      render: (_, record) =>
        record.parent ? (
          <Text>{record.parent.name}</Text>
        ) : (
          <Text type="secondary">-</Text>
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
      title: '子分类数',
      key: 'childrenCount',
      width: 100,
      align: 'center',
      render: (_, record) => {
        const count = record.children?.length ?? 0
        return <Text type={count > 0 ? undefined : 'secondary'}>{count}</Text>
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => {
        const hasChildren = (record.children?.length ?? 0) > 0
        return (
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
              description={
                hasChildren
                  ? `分类「${record.name}」含有 ${record.children!.length} 个子分类，删除后子分类将失去父级关联，确认删除？`
                  : `确认删除分类「${record.name}」？`
              }
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
        )
      },
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title="分类管理"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建分类
          </Button>
        }
      />

      <Table
        rowKey="id"
        columns={columns}
        dataSource={categories}
        loading={isLoading}
        scroll={{ x: 900 }}
        pagination={{
          pageSize: 20,
          showTotal: (total) => `共 ${total} 个分类`,
          showSizeChanger: false,
        }}
        size="middle"
      />

      <Modal
        title={modalMode === 'create' ? '新建分类' : `编辑分类：${editingCategory?.name ?? ''}`}
        open={modalVisible}
        onCancel={() => { setModalVisible(false); setEditingCategory(null); form.resetFields() }}
        onOk={handleSubmit}
        okText={modalMode === 'create' ? '创建' : '保存'}
        cancelText="取消"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={480}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="分类名称"
            rules={[{ required: true, message: '请输入分类名称' }]}
          >
            <Input placeholder="请输入分类名称" maxLength={100} onChange={handleNameChange} />
          </Form.Item>

          <Form.Item
            name="slug"
            label="Slug"
            rules={[
              { required: true, message: '请输入 Slug' },
              { pattern: /^[a-z0-9-]+$/, message: 'Slug 只能包含小写字母、数字和连字符' },
            ]}
          >
            <Input placeholder="url-friendly-slug" maxLength={120} />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <Input.TextArea placeholder="分类描述（可选）" rows={3} maxLength={500} showCount />
          </Form.Item>

          <Form.Item name="parentId" label="父分类">
            <Select
              placeholder="选择父分类（可选）"
              options={parentOptions}
              allowClear
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>

          <Form.Item name="sortOrder" label="排序值" initialValue={0}>
            <InputNumber min={0} max={9999} style={{ width: '100%' }} placeholder="数值越小越靠前" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
