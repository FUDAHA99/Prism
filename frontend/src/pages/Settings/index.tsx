import React from 'react'
import { Button, Form, Input, message, Tabs } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { changePassword, updateProfile } from '../../api/auth'
import { errorMessage } from '../../api/errors'
import PageHeader from '../../components/common/PageHeader'
import { useAuthStore } from '../../stores/authStore'
import { PASSWORD_HINT, passwordRule } from '../../utils/password'
import {
  PROFILE_AVATAR_URL_MAX,
  PROFILE_NICKNAME_MAX,
  avatarUrlProblem,
  buildProfileUpdate,
  nicknameProblem,
} from '../../utils/profile'

interface ProfileFormValues {
  nickname: string
  avatarUrl: string
}

interface PasswordFormValues {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

/**
 * 个人资料：走 PATCH /auth/me，只能改昵称与头像（admin、editor 都能改自己的）。
 * 此前调的是 PATCH /users/:id —— 那是仅 admin 的用户管理接口，editor 保存一律 403，且失败时只提示「更新失败」。
 * 邮箱、用户名、角色由管理员在「用户管理」里改，这里只读显示。
 */
function ProfileTab() {
  const user = useAuthStore((s) => s.user)
  const updateUserStore = useAuthStore((s) => s.updateUser)
  const queryClient = useQueryClient()
  const [form] = Form.useForm<ProfileFormValues>()
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (user) {
      form.setFieldsValue({
        nickname: user.nickname ?? '',
        avatarUrl: user.avatarUrl ?? '',
      })
    }
  }, [user, form])

  const handleSubmit = async () => {
    if (!user) return
    const values = await form.validateFields()
    const payload = buildProfileUpdate(user, values)
    if (Object.keys(payload).length === 0) {
      message.info('没有需要保存的修改')
      return
    }
    setLoading(true)
    try {
      const res = await updateProfile(payload)
      // 返回值与 GET /auth/me 同形状：同时刷新登录态与 MainLayout 的资料缓存
      queryClient.setQueryData(['auth', 'me'], res)
      updateUserStore({
        nickname: res.nickname,
        avatarUrl: res.avatarUrl,
      })
      message.success('个人信息已更新')
    } catch (err: unknown) {
      // 后端的原因（如「该昵称已被其他用户使用」、头像地址不合法）已由拦截器放进 Error.message
      message.error(errorMessage(err, '更新失败，请重试'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 480, marginTop: 16 }}>
      <Form.Item label="用户名">
        <Input value={user?.username ?? ''} disabled />
      </Form.Item>

      <Form.Item label="邮箱" extra="邮箱由管理员在「用户管理」中修改">
        <Input value={user?.email ?? ''} disabled />
      </Form.Item>

      <Form.Item
        name="nickname"
        label="昵称"
        extra="留空表示不设置昵称（显示用户名）；不能与其他用户的用户名或昵称相同"
        rules={[
          {
            validator: (_, value?: string) => {
              const problem = nicknameProblem(value)
              return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
            },
          },
        ]}
      >
        <Input placeholder="请输入昵称" maxLength={PROFILE_NICKNAME_MAX} />
      </Form.Item>

      <Form.Item
        name="avatarUrl"
        label="头像地址"
        extra="http(s) 地址或站内路径（如媒体库上传得到的 /uploads/...）；留空表示不设置"
        rules={[
          {
            validator: (_, value?: string) => {
              const problem = avatarUrlProblem(value)
              return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
            },
          },
        ]}
      >
        <Input placeholder="https://example.com/avatar.png" maxLength={PROFILE_AVATAR_URL_MAX} />
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
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const navigate = useNavigate()

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
      // 改密成功后后端已吊销本账号此前签发的全部 token（含当前这个），直接回登录页
      message.success('密码修改成功，请重新登录')
      form.resetFields()
      clearAuth()
      navigate('/login')
    } catch (err: unknown) {
      // apiClient 的响应拦截器已把后端的 message 包成 Error.message（如「当前密码错误」）
      const msg = err instanceof Error ? err.message : ''
      message.error(msg || '密码修改失败，请检查当前密码是否正确')
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
        // 与后端同一套口令策略（utils/password.ts，后台新建用户也用它）
        rules={[{ required: true, message: '请输入新密码' }, passwordRule('新密码')]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder={PASSWORD_HINT}
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
