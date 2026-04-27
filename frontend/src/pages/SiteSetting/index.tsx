import React, { useEffect } from 'react'
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Spin,
  Switch,
  Tabs,
} from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSiteSettings, saveSiteSettings } from '../../api/siteSetting'
import PageHeader from '../../components/common/PageHeader'
import type { SiteSetting } from '../../types'

/** 将配置数组转换为 key-value 对象 */
function toFormValues(settings: SiteSetting[]): Record<string, string> {
  return settings.reduce<Record<string, string>>((acc, item) => {
    acc[item.key] = item.value
    return acc
  }, {})
}

/** 将 form 对象转换为批量保存数组格式 */
function toSettingsArray(values: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: value === undefined || value === null ? '' : String(value),
  }))
}

export default function SiteSettingPage() {
  const { message } = App.useApp()
  const [basicForm] = Form.useForm<Record<string, string>>()
  const [featureForm] = Form.useForm<Record<string, string | boolean | number>>()

  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['site-settings'],
    queryFn: getSiteSettings,
  })

  // 加载后填充表单
  useEffect(() => {
    if (!data) return
    const vals = toFormValues(data)

    basicForm.setFieldsValue({
      site_name: vals.site_name ?? '',
      site_description: vals.site_description ?? '',
      site_logo: vals.site_logo ?? '',
      site_favicon: vals.site_favicon ?? '',
      site_icp: vals.site_icp ?? '',
    })

    featureForm.setFieldsValue({
      enable_register: vals.enable_register === 'true',
      enable_comment: vals.enable_comment === 'true',
      comment_audit: vals.comment_audit === 'true',
      posts_per_page: Number(vals.posts_per_page ?? 10),
    })
  }, [data, basicForm, featureForm])

  const saveMutation = useMutation({
    mutationFn: (settings: Array<{ key: string; value: string }>) =>
      saveSiteSettings(settings),
    onSuccess: () => {
      message.success('配置已保存')
      queryClient.invalidateQueries({ queryKey: ['site-settings'] })
    },
    onError: (err: Error) => {
      message.error(err.message || '保存失败，请重试')
    },
  })

  const handleSave = async () => {
    try {
      const [basicValues, featureValues] = await Promise.all([
        basicForm.validateFields(),
        featureForm.validateFields(),
      ])

      // 将 boolean/number 转换为 string
      const merged: Record<string, string> = {
        ...basicValues,
        enable_register: String(featureValues.enable_register ?? false),
        enable_comment: String(featureValues.enable_comment ?? false),
        comment_audit: String(featureValues.comment_audit ?? false),
        posts_per_page: String(featureValues.posts_per_page ?? 10),
      }

      saveMutation.mutate(toSettingsArray(merged))
    } catch {
      // 表单校验失败，antd 会自动高亮错误字段
    }
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  const tabItems = [
    {
      key: 'basic',
      label: '基本设置',
      children: (
        <Card>
          <Form form={basicForm} layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item
              name="site_name"
              label="站点名称"
              rules={[{ required: true, message: '请输入站点名称' }]}
            >
              <Input placeholder="我的博客" maxLength={100} />
            </Form.Item>

            <Form.Item name="site_description" label="站点描述">
              <Input.TextArea placeholder="站点简介" rows={3} maxLength={500} showCount />
            </Form.Item>

            <Form.Item name="site_logo" label="Logo URL">
              <Input placeholder="https://example.com/logo.png" maxLength={500} />
            </Form.Item>

            <Form.Item name="site_favicon" label="Favicon URL">
              <Input placeholder="https://example.com/favicon.ico" maxLength={500} />
            </Form.Item>

            <Form.Item name="site_icp" label="ICP 备案号">
              <Input placeholder="京ICP备XXXXXXXX号" maxLength={100} />
            </Form.Item>
          </Form>
        </Card>
      ),
    },
    {
      key: 'feature',
      label: '功能设置',
      children: (
        <Card>
          <Form form={featureForm} layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item
              name="enable_register"
              label="允许注册"
              valuePropName="checked"
            >
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>

            <Form.Item
              name="enable_comment"
              label="开启评论"
              valuePropName="checked"
            >
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>

            <Form.Item
              name="comment_audit"
              label="评论需审核"
              valuePropName="checked"
            >
              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
            </Form.Item>

            <Form.Item name="posts_per_page" label="每页文章数">
              <InputNumber min={1} max={100} style={{ width: 160 }} />
            </Form.Item>
          </Form>
        </Card>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title="系统配置"
        subtitle="管理站点基本信息与功能开关"
        extra={
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saveMutation.isPending}
            onClick={handleSave}
          >
            保存配置
          </Button>
        }
      />

      <Tabs defaultActiveKey="basic" items={tabItems} />
    </div>
  )
}
