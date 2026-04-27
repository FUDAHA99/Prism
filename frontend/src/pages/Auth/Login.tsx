import React, { useState } from 'react'
import { Form, Input, Button, Card, Typography, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { login, getProfile } from '../../api/auth'
import { useAuthStore } from '../../stores/authStore'

interface LoginFormValues {
  email: string
  password: string
}

export default function Login() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values: LoginFormValues) => {
    setLoading(true)
    try {
      const result = await login(values.email, values.password)
      // Set the token before fetching profile so the client can authenticate
      localStorage.setItem('access_token', result.tokens.accessToken)
      const user = await getProfile()
      setAuth(user, result.tokens.accessToken, result.tokens.refreshToken)
      message.success('登录成功')
      navigate('/')
    } catch (err: unknown) {
      const error = err as { message?: string }
      const msg = error?.message ?? '邮箱或密码错误'
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            CMS 管理系统
          </Typography.Title>
          <Typography.Text type="secondary">请登录您的账户</Typography.Text>
        </div>

        <Form<LoginFormValues>
          layout="vertical"
          onFinish={handleSubmit}
          autoComplete="off"
        >
          <Form.Item
            label="邮箱"
            name="email"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '请输入有效的邮箱地址' },
            ]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="请输入邮箱"
              size="large"
            />
          </Form.Item>

          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="请输入密码"
              size="large"
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              block
              loading={loading}
            >
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
