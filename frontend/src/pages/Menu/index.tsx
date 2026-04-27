import React, { useState } from 'react'
import {
  Button,
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
  InputNumber,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getMenus,
  createMenu,
  updateMenu,
  deleteMenu,
} from '../../api/menu'
import type { CreateMenuData } from '../../api/menu'
import PageHeader from '../../components/common/PageHeader'
import type { MenuItem } from '../../types'

const { Text, Link } = Typography

type ModalMode = 'create' | 'edit'

interface MenuFormValues {
  name: string
  url?: string
  target: '_self' | '_blank'
  icon?: string
  sortOrder: number
  isActive: boolean
  parentId?: string
}

export default function MenuPage() {
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [form] = Form.useForm<MenuFormValues>()

  const queryClient = useQueryClient()

  const { data: menus = [], isLoading } = useQuery({
    queryKey: ['menus'],
    queryFn: getMenus,
  })

  // 顶级菜单选项（不含自身）
  const parentOptions = menus
    .filter((m) => !m.parentId && m.id !== editingItem?.id)
    .map((m) => ({ label: m.name, value: m.id }))

  const createMutation = useMutation({
    mutationFn: (data: CreateMenuData) => createMenu(data),
    onSuccess: () => {
      message.success('菜单项已创建')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['menus'] })
    },
    onError: (err: Error) => message.error(err.message || '创建失败'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: CreateMenuData }) =>
      updateMenu(id, data),
    onSuccess: () => {
      message.success('菜单项已更新')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['menus'] })
    },
    onError: (err: Error) => message.error(err.message || '更新失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMenu(id),
    onSuccess: () => {
      message.success('菜单项已删除')
      queryClient.invalidateQueries({ queryKey: ['menus'] })
    },
    onError: (err: Error) => message.error(err.message || '删除失败'),
  })

  const closeModal = () => {
    setModalVisible(false)
    setEditingItem(null)
    form.resetFields()
  }

  const handleCreate = () => {
    setModalMode('create')
    setEditingItem(null)
    form.resetFields()
    form.setFieldsValue({ target: '_self', sortOrder: 0, isActive: true })
    setModalVisible(true)
  }

  const handleEdit = (item: MenuItem) => {
    setModalMode('edit')
    setEditingItem(item)
    form.setFieldsValue({
      name: item.name,
      url: item.url,
      target: item.target,
      icon: item.icon,
      sortOrder: item.sortOrder,
      isActive: item.isActive,
      parentId: item.parentId,
    })
    setModalVisible(true)
  }

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      const payload: CreateMenuData = {
        ...values,
        parentId: values.parentId || undefined,
      }
      if (modalMode === 'create') {
        createMutation.mutate(payload)
      } else if (editingItem) {
        updateMutation.mutate({ id: editingItem.id, data: payload })
      }
    })
  }

  // 父菜单名称映射
  const parentMap = Object.fromEntries(menus.map((m) => [m.id, m.name]))

  const columns: TableColumnsType<MenuItem> = [
    {
      title: '菜单名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record) => (
        <Space>
          {record.icon && <GlobalOutlined />}
          <Text strong>{name}</Text>
          {record.parentId && (
            <Tag color="blue" style={{ fontSize: 11 }}>
              子菜单 / {parentMap[record.parentId] ?? record.parentId}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '链接',
      dataIndex: 'url',
      key: 'url',
      ellipsis: true,
      render: (url: string, record) =>
        url ? (
          <Link href={url} target={record.target} rel="noopener noreferrer">
            {url}
          </Link>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '打开方式',
      dataIndex: 'target',
      key: 'target',
      width: 100,
      render: (t: string) => (
        <Tag color={t === '_blank' ? 'geekblue' : 'default'}>
          {t === '_blank' ? '新窗口' : '当前页'}
        </Tag>
      ),
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
      width: 80,
      align: 'center',
      render: (active: boolean) => (
        <Tag color={active ? 'success' : 'default'}>{active ? '启用' : '禁用'}</Tag>
      ),
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
            description={`确认删除菜单「${record.name}」？`}
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
        title="导航菜单"
        subtitle="管理站点导航栏菜单项"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建菜单项
          </Button>
        }
      />

      <Table
        rowKey="id"
        columns={columns}
        dataSource={menus}
        loading={isLoading}
        scroll={{ x: 800 }}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        size="middle"
      />

      <Modal
        title={modalMode === 'create' ? '新建菜单项' : `编辑：${editingItem?.name ?? ''}`}
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
            label="菜单名称"
            rules={[{ required: true, message: '请输入菜单名称' }]}
          >
            <Input placeholder="如：首页、关于我们" maxLength={100} />
          </Form.Item>

          <Form.Item name="url" label="链接地址">
            <Input placeholder="https://example.com 或 /about（可选）" maxLength={500} />
          </Form.Item>

          <Form.Item name="target" label="打开方式" initialValue="_self">
            <Select
              options={[
                { label: '当前页（_self）', value: '_self' },
                { label: '新窗口（_blank）', value: '_blank' },
              ]}
            />
          </Form.Item>

          <Form.Item name="parentId" label="父级菜单（留空表示顶级）">
            <Select
              allowClear
              placeholder="选择父级菜单（可选）"
              options={parentOptions}
            />
          </Form.Item>

          <Form.Item name="icon" label="图标（可选）">
            <Input placeholder="图标类名或 URL" maxLength={100} />
          </Form.Item>

          <Form.Item name="sortOrder" label="排序值" initialValue={0}>
            <InputNumber min={0} max={9999} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="isActive" label="是否启用" valuePropName="checked" initialValue={true}>
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
