import React, { useEffect, useMemo } from 'react'
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
import QueryErrorResult from '../../components/common/QueryErrorResult'
import {
  changedSettings,
  settingsFormValues,
  type BasicSettingValues,
  type FeatureSettingValues,
} from '../../utils/site-settings'

export default function SiteSettingPage() {
  const { message } = App.useApp()
  const [basicForm] = Form.useForm<BasicSettingValues>()
  const [featureForm] = Form.useForm<FeatureSettingValues>()

  const queryClient = useQueryClient()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['site-settings'],
    queryFn: getSiteSettings,
  })

  // 载入时两张表单的值：既用来填表单，也是保存时判断「改了什么」的基准
  const initialValues = useMemo(() => (data ? settingsFormValues(data) : undefined), [data])

  // 加载后填充表单
  useEffect(() => {
    if (!initialValues) return
    basicForm.setFieldsValue(initialValues.basic)
    featureForm.setFieldsValue(initialValues.feature)
  }, [initialValues, basicForm, featureForm])

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
    if (!initialValues) return
    let values: [Partial<BasicSettingValues>, Partial<FeatureSettingValues>]
    try {
      values = await Promise.all([basicForm.validateFields(), featureForm.validateFields()])
    } catch {
      // 表单校验失败，antd 会自动高亮错误字段
      return
    }
    const [basicValues, featureValues] = values
    // 只提交改过的项（见 utils/site-settings.ts）：没打开过、没改过的开关保持库里原来的值，
    // 不再被补成 false 一起写回（此前只改站点名称就会悄悄关掉注册、评论与评论审核）
    const changed = changedSettings(
      { ...initialValues.basic, ...initialValues.feature },
      { ...basicValues, ...featureValues },
    )
    if (changed.length === 0) {
      message.info('没有需要保存的修改')
      return
    }
    saveMutation.mutate(changed)
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  // 读取失败时不显示表单：空表单一保存，会把所有配置项写成空值 / 关闭
  if (isError) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title="系统配置" subtitle="管理站点基本信息与功能开关" />
        <QueryErrorResult error={error} onRetry={refetch} />
      </div>
    )
  }

  const tabItems = [
    {
      key: 'basic',
      label: '基本设置',
      // 两个标签都预先渲染：表单字段始终挂载，校验与取值覆盖到全部配置项（保存时仍只提交改过的项）
      forceRender: true,
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
      forceRender: true,
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

            <Form.Item
              name="posts_per_page"
              label="每页文章数"
              rules={[{ required: true, message: '请输入每页文章数' }]}
            >
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
