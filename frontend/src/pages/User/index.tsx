import React, { useState } from 'react'
import {
  App,
  Badge,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, SearchOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { assignRoles, deleteUser, getUsers, removeRoles, updateUser } from '../../api/user'
import { getRoles } from '../../api/role'
import PageHeader from '../../components/common/PageHeader'
import { formatDate } from '../../utils'
import type { Role, User } from '../../types'

const ROLE_COLORS = ['blue', 'green', 'orange', 'purple', 'cyan', 'magenta', 'gold', 'volcano']

function roleColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash + name.charCodeAt(i)) % ROLE_COLORS.length
  return ROLE_COLORS[hash]
}

interface EditFormValues {
  nickname: string
  email: string
  isActive: boolean
  roleNames: string[]
}

export default function UserPage() {
  const { message } = App.useApp()
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [editVisible, setEditVisible] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [form] = Form.useForm<EditFormValues>()

  const queryClient = useQueryClient()

  const { data: usersData, isLoading } = useQuery({
    queryKey: ['users', search],
    queryFn: () => getUsers({ search: search || undefined }),
  })

  const { data: rolesData } = useQuery({
    queryKey: ['roles'],
    queryFn: () => getRoles(),
  })

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      values,
      originalRoles,
    }: {
      id: string
      values: EditFormValues
      originalRoles: string[]
    }) => {
      await updateUser(id, {
        nickname: values.nickname,
        email: values.email,
        isActive: values.isActive,
      })

      const allRoles: Role[] = rolesData ?? []
      const newRoleIds = allRoles.filter((r) => values.roleNames.includes(r.name)).map((r) => r.id)
      const oldRoleIds = allRoles.filter((r) => originalRoles.includes(r.name)).map((r) => r.id)

      const toAdd = newRoleIds.filter((rid) => !oldRoleIds.includes(rid))
      const toRemove = oldRoleIds.filter((rid) => !newRoleIds.includes(rid))

      if (toAdd.length > 0) await assignRoles(id, toAdd)
      if (toRemove.length > 0) await removeRoles(id, toRemove)
    },
    onSuccess: () => {
      message.success('用户信息已更新')
      setEditVisible(false)
      setEditingUser(null)
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: () => {
      message.error('更新失败，请重试')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      message.success('用户已删除')
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: () => {
      message.error('删除失败，请重试')
    },
  })

  const handleEdit = (user: User) => {
    setEditingUser(user)
    form.setFieldsValue({
      nickname: user.nickname ?? '',
      email: user.email,
      isActive: user.isActive,
      roleNames: user.roles,
    })
    setEditVisible(true)
  }

  const handleEditSubmit = () => {
    if (!editingUser) return
    form.validateFields().then((values) => {
      updateMutation.mutate({ id: editingUser.id, values, originalRoles: editingUser.roles })
    })
  }

  const handleSearchConfirm = () => {
    setSearch(searchInput)
  }

  const users: User[] = usersData?.data ?? []
  const roles: Role[] = rolesData ?? []

  const columns: TableColumnsType<User> = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 130,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
      width: 200,
      ellipsis: true,
    },
    {
      title: '昵称',
      dataIndex: 'nickname',
      key: 'nickname',
      width: 120,
      render: (val: string | undefined) => val ?? '-',
    },
    {
      title: '角色',
      dataIndex: 'roles',
      key: 'roles',
      width: 200,
      render: (roleNames: string[] | undefined) =>
        (roleNames ?? []).length === 0 ? (
          <span style={{ color: '#bfbfbf' }}>-</span>
        ) : (
          (roleNames ?? []).map((name) => (
            <Tag key={name} color={roleColor(name)} style={{ marginBottom: 2 }}>
              {name}
            </Tag>
          ))
        ),
    },
    {
      title: '状态',
      dataIndex: 'isActive',
      key: 'isActive',
      width: 90,
      render: (isActive: boolean) =>
        isActive ? (
          <Badge status="success" text={<span style={{ color: '#52c41a' }}>正常</span>} />
        ) : (
          <Badge status="error" text={<span style={{ color: '#ff4d4f' }}>禁用</span>} />
        ),
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 160,
      render: (val: string | undefined) => (val ? formatDate(val) : '-'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (val: string) => formatDate(val),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <div style={{ display: 'flex', gap: 8 }}>
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
            description={`确认删除用户「${record.username}」？此操作不可恢复。`}
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader title="用户管理" />

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Input
          placeholder="搜索用户名、邮箱、昵称"
          prefix={<SearchOutlined />}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onPressEnter={handleSearchConfirm}
          style={{ width: 280 }}
          allowClear
          onClear={() => { setSearchInput(''); setSearch('') }}
        />
        <Button type="primary" onClick={handleSearchConfirm}>
          搜索
        </Button>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={isLoading}
        scroll={{ x: 1100 }}
        pagination={{
          pageSize: 20,
          showTotal: (total) => `共 ${total} 名用户`,
          showSizeChanger: false,
        }}
        size="middle"
      />

      <Modal
        title={`编辑用户：${editingUser?.username ?? ''}`}
        open={editVisible}
        onCancel={() => { setEditVisible(false); setEditingUser(null); form.resetFields() }}
        onOk={handleEditSubmit}
        okText="保存"
        cancelText="取消"
        confirmLoading={updateMutation.isPending}
        width={480}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="nickname"
            label="昵称"
          >
            <Input placeholder="请输入昵称" maxLength={50} />
          </Form.Item>

          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input placeholder="请输入邮箱" />
          </Form.Item>

          <Form.Item name="isActive" label="账号状态" valuePropName="checked">
            <Switch checkedChildren="正常" unCheckedChildren="禁用" />
          </Form.Item>

          <Form.Item name="roleNames" label="角色">
            <Select
              mode="multiple"
              placeholder="选择角色"
              options={roles.map((r) => ({ label: r.name, value: r.name }))}
              optionFilterProp="label"
              allowClear
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
