import React, { useState } from 'react'
import { Form, Input, Button, Card, Typography, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessage } from '../../api/errors'
import { NO_BACKOFFICE_ACCESS_MESSAGE, signIn } from '../../stores/session'

interface LoginFormValues {
  email: string
  password: string
}

export default function Login() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values: LoginFormValues) => {
    setLoading(true)
    try {
      // 登录、取资料、核对后台角色（没有 admin / editor 时注销这次签发的 token）见 stores/session.ts
      const result = await signIn(values.email, values.password, queryClient)
      if (result.status === 'no-backoffice-access') {
        message.error(NO_BACKOFFICE_ACCESS_MESSAGE)
        return
      }
      message.success('登录成功')
      navigate('/')
    } catch (err: unknown) {
      message.error(errorMessage(err, '邮箱或密码错误'))
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
