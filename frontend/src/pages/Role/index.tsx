import React, { useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getRoles,
  getPermissions,
  createRole,
  updateRole,
  deleteRole,
  assignPermissions,
} from '../../api/role'
import PageHeader from '../../components/common/PageHeader'
import type { Role, Permission } from '../../types'

const { Text } = Typography

type ModalMode = 'create' | 'edit'

interface RoleFormValues {
  name: string
  description?: string
}

/** 按模块分组权限 */
function groupPermissions(permissions: Permission[]): Record<string, Permission[]> {
  return permissions.reduce<Record<string, Permission[]>>((acc, p) => {
    if (!acc[p.module]) acc[p.module] = []
    acc[p.module].push(p)
    return acc
  }, {})
}

export default function RolePage() {
  const [modalVisible, setModalVisible] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [permDrawerRole, setPermDrawerRole] = useState<Role | null>(null)
  const [selectedPermIds, setSelectedPermIds] = useState<string[]>([])
  const [form] = Form.useForm<RoleFormValues>()

  const queryClient = useQueryClient()

  const { data: roles, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: getRoles,
  })

  const { data: allPermissions = [] } = useQuery({
    queryKey: ['permissions'],
    queryFn: getPermissions,
    enabled: permDrawerRole !== null,
  })

  const createMutation = useMutation({
    mutationFn: (values: RoleFormValues) => createRole(values),
    onSuccess: () => {
      message.success('角色创建成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['roles'] })
    },
    onError: (err: Error) => message.error(err.message || '创建失败'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: RoleFormValues }) =>
      updateRole(id, values),
    onSuccess: () => {
      message.success('角色更新成功')
      closeModal()
      queryClient.invalidateQueries({ queryKey: ['roles'] })
    },
    onError: (err: Error) => message.error(err.message || '更新失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRole(id),
    onSuccess: () => {
      message.success('角色已删除')
      queryClient.invalidateQueries({ queryKey: ['roles'] })
    },
    onError: (err: Error) => message.error(err.message || '删除失败'),
  })

  const assignMutation = useMutation({
    mutationFn: ({ roleId, permIds }: { roleId: string; permIds: string[] }) =>
      assignPermissions(roleId, permIds),
    onSuccess: () => {
      message.success('权限分配成功')
      setPermDrawerRole(null)
      queryClient.invalidateQueries({ queryKey: ['roles'] })
    },
    onError: (err: Error) => message.error(err.message || '权限分配失败'),
  })

  const closeModal = () => {
    setModalVisible(false)
    setEditingRole(null)
    form.resetFields()
  }

  const handleCreate = () => {
    setModalMode('create')
    setEditingRole(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (role: Role) => {
    setModalMode('edit')
    setEditingRole(role)
    form.setFieldsValue({ name: role.name, description: role.description })
    setModalVisible(true)
  }

  const handleOpenPermDrawer = (role: Role) => {
    setPermDrawerRole(role)
    setSelectedPermIds((role.permissions ?? []).map((p) => p.id))
  }

  const handleSubmit = () => {
    form.validateFields().then((values) => {
      if (modalMode === 'create') {
        createMutation.mutate(values)
      } else if (editingRole) {
        updateMutation.mutate({ id: editingRole.id, values })
      }
    })
  }

  const handleSavePermissions = () => {
    if (!permDrawerRole) return
    assignMutation.mutate({ roleId: permDrawerRole.id, permIds: selectedPermIds })
  }

  const permGroups = groupPermissions(allPermissions)

  const columns: TableColumnsType<Role> = [
    {
      title: '角色名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (name: string, record) => (
        <Space>
          <Text strong>{name}</Text>
          {record.isSystem && <Tag color="blue">系统</Tag>}
        </Space>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      render: (desc: string) => <Text type="secondary">{desc || '—'}</Text>,
    },
    {
      title: '权限数量',
      key: 'permCount',
      width: 100,
      align: 'center',
      render: (_, record) => (
        <Badge
          count={(record.permissions ?? []).length}
          showZero
          style={{ backgroundColor: '#52c41a' }}
        />
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
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            icon={<KeyOutlined />}
            onClick={() => handleOpenPermDrawer(record)}
          >
            权限
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            disabled={record.isSystem}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除"
            description={`确认删除角色「${record.name}」？`}
            onConfirm={() => deleteMutation.mutate(record.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={record.isSystem}
          >
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={record.isSystem}
            >
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
        title="角色管理"
        subtitle="管理系统角色及权限分配"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建角色
          </Button>
        }
      />

      <Table
        rowKey="id"
        columns={columns}
        dataSource={roles ?? []}
        loading={isLoading}
        scroll={{ x: 800 }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        size="middle"
      />

      {/* 创建/编辑 Modal */}
      <Modal
        title={modalMode === 'create' ? '新建角色' : `编辑角色：${editingRole?.name ?? ''}`}
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
            label="角色名称"
            rules={[{ required: true, message: '请输入角色名称' }]}
          >
            <Input placeholder="如：editor、moderator" maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea placeholder="角色用途说明（可选）" rows={3} maxLength={200} showCount />
          </Form.Item>
        </Form>
      </Modal>

      {/* 权限分配 Drawer */}
      <Drawer
        title={
          <Space>
            <LockOutlined />
            {`分配权限：${permDrawerRole?.name ?? ''}`}
          </Space>
        }
        open={permDrawerRole !== null}
        onClose={() => setPermDrawerRole(null)}
        width={480}
        extra={
          <Button
            type="primary"
            loading={assignMutation.isPending}
            onClick={handleSavePermissions}
          >
            保存权限
          </Button>
        }
      >
        {allPermissions.length === 0 ? (
          <Text type="secondary">暂无权限数据</Text>
        ) : (
          Object.entries(permGroups).map(([module, perms]) => (
            <div key={module} style={{ marginBottom: 20 }}>
              <Text strong style={{ display: 'block', marginBottom: 8, textTransform: 'capitalize' }}>
                {module}
              </Text>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {perms.map((p) => (
                  <Checkbox
                    key={p.id}
                    checked={selectedPermIds.includes(p.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedPermIds((prev) => [...prev, p.id])
                      } else {
                        setSelectedPermIds((prev) => prev.filter((id) => id !== p.id))
                      }
                    }}
                  >
                    <Text>{p.name}</Text>
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {p.code}
                    </Text>
                  </Checkbox>
                ))}
              </Space>
            </div>
          ))
        )}
      </Drawer>
    </div>
  )
}
