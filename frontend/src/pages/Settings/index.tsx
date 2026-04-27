import React from 'react'
import { Button, Form, Input, message, Tabs } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { changePassword } from '../../api/auth'
import { updateUser } from '../../api/user'
import PageHeader from '../../components/common/PageHeader'
import { useAuthStore } from '../../stores/authStore'

interface ProfileFormValues {
  nickname: string
  email: string
  avatarUrl: string
}

interface PasswordFormValues {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

function ProfileTab() {
  const user = useAuthStore((s) => s.user)
  const updateUserStore = useAuthStore((s) => s.updateUser)
  const [form] = Form.useForm<ProfileFormValues>()
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (user) {
      form.setFieldsValue({
        nickname: user.nickname ?? '',
        email: user.email,
        avatarUrl: user.avatarUrl ?? '',
      })
    }
  }, [user, form])

  const handleSubmit = async () => {
    if (!user) return
    const values = await form.validateFields()
    setLoading(true)
    try {
      const res = await updateUser(user.id, {
        nickname: values.nickname,
        email: values.email,
        avatarUrl: values.avatarUrl || undefined,
      })
      updateUserStore({
        nickname: res.nickname,
        email: res.email,
        avatarUrl: res.avatarUrl,
      })
      message.success('个人信息已更新')
    } catch {
      message.error('更新失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 480, marginTop: 16 }}>
      <Form.Item label="用户名">
        <Input value={user?.username ?? ''} disabled />
      </Form.Item>

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

      <Form.Item
        name="avatarUrl"
        label="头像 URL"
        rules={[{ type: 'url', message: '请输入有效的 URL' }]}
      >
        <Input placeholder="https://example.com/avatar.png" />
      </Form.Item>

      <Form.Item>
        <Button type="primary" onClick={handleSubmit} loading={loading}>
          保存修改
        </Button>
      </Form.Item>
    </Form>
  )
}

function PasswordTab() {
  const [form] = Form.useForm<PasswordFormValues>()
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async () => {
    const values = await form.validateFields()

    if (values.newPassword !== values.confirmPassword) {
      form.setFields([
        { name: 'confirmPassword', errors: ['两次输入的密码不一致'] },
      ])
      return
    }

    setLoading(true)
    try {
      await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      })
      message.success('密码修改成功，请重新登录')
      form.resetFields()
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } }
      const msg = axiosErr?.response?.data?.message
      if (msg) {
        message.error(msg)
      } else {
        message.error('密码修改失败，请检查当前密码是否正确')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 480, marginTop: 16 }}>
      <Form.Item
        name="currentPassword"
        label="当前密码"
        rules={[{ required: true, message: '请输入当前密码' }]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="请输入当前密码"
          autoComplete="current-password"
        />
      </Form.Item>

      <Form.Item
        name="newPassword"
        label="新密码"
        rules={[
          { required: true, message: '请输入新密码' },
          { min: 8, message: '密码长度不能少于 8 位' },
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="至少 8 位"
          autoComplete="new-password"
        />
      </Form.Item>

      <Form.Item
        name="confirmPassword"
        label="确认新密码"
        dependencies={['newPassword']}
        rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('newPassword') === value) {
                return Promise.resolve()
              }
              return Promise.reject(new Error('两次输入的密码不一致'))
            },
          }),
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="请再次输入新密码"
          autoComplete="new-password"
        />
      </Form.Item>

      <Form.Item>
        <Button type="primary" onClick={handleSubmit} loading={loading}>
          修改密码
        </Button>
      </Form.Item>
    </Form>
  )
}

const TAB_ITEMS = [
  {
    key: 'profile',
    label: (
      <span>
        <UserOutlined />
        个人信息
      </span>
    ),
    children: <ProfileTab />,
  },
  {
    key: 'password',
    label: (
      <span>
        <LockOutlined />
        修改密码
      </span>
    ),
    children: <PasswordTab />,
  },
]

export default function SettingsPage() {
  return (
    <div style={{ padding: 24 }}>
      <PageHeader title="系统设置" />
      <Tabs defaultActiveKey="profile" items={TAB_ITEMS} />
    </div>
  )
}
