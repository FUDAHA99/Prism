import React from 'react'
import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

/**
 * 当前账号的角色打不开这个页面（例如 editor 直接输入 /users）。由 MainLayout 按 utils/access.ts 判定后
 * 代替页面渲染：不再先渲染页面、再让每个接口各报一次 403。
 */
export default function ForbiddenPage() {
  const navigate = useNavigate()
  return (
    <Result
      status="403"
      title="403"
      subTitle="当前账号无权访问此页面"
      extra={
        <Button type="primary" onClick={() => navigate('/')}>
          返回控制台
        </Button>
      }
    />
  )
}
