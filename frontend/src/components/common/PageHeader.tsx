import React from 'react'
import { Space, Typography } from 'antd'

interface PageHeaderProps {
  title: string
  subtitle?: string
  extra?: React.ReactNode
}

export default function PageHeader({ title, subtitle, extra }: PageHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: 24,
      }}
    >
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
        )}
      </Space>
      {extra && <div>{extra}</div>}
    </div>
  )
}
