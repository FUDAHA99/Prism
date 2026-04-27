import React, { useEffect } from 'react'
import {
  App,
  Form,
  Input,
  Button,
  Select,
  Spin,
  Space,
  Row,
  Col,
  DatePicker,
  Card,
  Divider,
} from 'antd'
import { CalendarOutlined, SendOutlined, SaveOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getContent, createContent, updateContent } from '../../api/content'
import { getCategories } from '../../api/category'
import type { CreateContentData } from '../../api/content'
import PageHeader from '../../components/common/PageHeader'
import MarkdownEditor from '../../components/editor/MarkdownEditor'
import MediaPicker from '../../components/media/MediaPicker'
import { generateSlug } from '../../utils'

interface ContentFormValues {
  title: string
  slug: string
  contentType: 'article' | 'page' | 'announcement'
  categoryId?: string
  excerpt?: string
  body: string
  featuredImageUrl?: string
  metaTitle?: string
  metaDescription?: string
  publishAt?: dayjs.Dayjs
}

export default function ContentForm() {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const isEditing = Boolean(id)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form] = Form.useForm<ContentFormValues>()

  // Load content when editing
  const { data: contentData, isLoading: isLoadingContent } = useQuery({
    queryKey: ['content', id],
    queryFn: () => getContent(id!),
    enabled: isEditing,
  })

  // Load categories for select
  const { data: categoriesData } = useQuery({
    queryKey: ['categories'],
    queryFn: getCategories,
  })

  const categories = categoriesData ?? []
  const content = contentData

  // Populate form when content loads
  useEffect(() => {
    if (content) {
      form.setFieldsValue({
        title: content.title,
        slug: content.slug,
        contentType: content.contentType,
        categoryId: content.categoryId,
        excerpt: content.excerpt,
        body: content.body,
        featuredImageUrl: content.featuredImageUrl,
        metaTitle: content.metaTitle,
        metaDescription: content.metaDescription,
      })
    }
  }, [content, form])

  const createMutation = useMutation({
    mutationFn: (data: CreateContentData) => createContent(data),
    onSuccess: () => {
      message.success('内容创建成功')
      queryClient.invalidateQueries({ queryKey: ['contents'] })
      navigate('/contents')
    },
    onError: () => {
      message.error('创建失败，请重试')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: Partial<CreateContentData>) => updateContent(id!, data),
    onSuccess: () => {
      message.success('内容更新成功')
      queryClient.invalidateQueries({ queryKey: ['contents'] })
      queryClient.invalidateQueries({ queryKey: ['content', id] })
      navigate('/contents')
    },
    onError: () => {
      message.error('更新失败，请重试')
    },
  })

  const handleSubmit = (values: ContentFormValues, publish = false) => {
    const payload: CreateContentData = {
      title: values.title,
      slug: values.slug,
      body: values.body,
      contentType: values.contentType,
      categoryId: values.categoryId,
      excerpt: values.excerpt,
      featuredImageUrl: values.featuredImageUrl,
      metaTitle: values.metaTitle,
      metaDescription: values.metaDescription,
      ...(publish ? { status: 'published' } : {}),
      ...(values.publishAt ? { publishedAt: values.publishAt.toISOString() } : {}),
    }

    if (isEditing) {
      updateMutation.mutate(payload)
    } else {
      createMutation.mutate(payload)
    }
  }

  const handleSaveDraft = () => {
    form.validateFields().then((values) => handleSubmit(values, false))
  }

  const handlePublish = () => {
    form.validateFields().then((values) => handleSubmit(values, true))
  }

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const title = e.target.value
    // Only auto-generate slug when creating, not when editing
    if (!isEditing) {
      form.setFieldValue('slug', generateSlug(title))
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  if (isEditing && isLoadingContent) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" tip="加载中..." />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={isEditing ? '编辑内容' : '创建内容'}
        extra={
          <Button onClick={() => navigate('/contents')}>返回列表</Button>
        }
      />

      <Form<ContentFormValues>
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ contentType: 'article' }}
        style={{ maxWidth: 900 }}
      >
        <Row gutter={24}>
          {/* Left column: main content */}
          <Col span={16}>
            <Form.Item
              label="标题"
              name="title"
              rules={[{ required: true, message: '请输入标题' }]}
            >
              <Input
                placeholder="请输入内容标题"
                onChange={handleTitleChange}
              />
            </Form.Item>

            <Form.Item
              label="Slug"
              name="slug"
              rules={[
                { required: true, message: '请输入 Slug' },
                {
                  pattern: /^[a-z0-9-]+$/,
                  message: 'Slug 只能包含小写字母、数字和连字符',
                },
              ]}
            >
              <Input placeholder="url-friendly-slug" />
            </Form.Item>

            <Form.Item label="摘要" name="excerpt">
              <Input.TextArea
                rows={3}
                placeholder="可选，简短描述内容"
                showCount
                maxLength={500}
              />
            </Form.Item>

            <Form.Item
              label="正文"
              name="body"
              rules={[{ required: true, message: '请输入正文内容' }]}
            >
              <MarkdownEditor />
            </Form.Item>
          </Col>

          {/* Right column: metadata */}
          <Col span={8}>
            <Form.Item
              label="内容类型"
              name="contentType"
              rules={[{ required: true, message: '请选择内容类型' }]}
            >
              <Select>
                <Select.Option value="article">文章</Select.Option>
                <Select.Option value="page">页面</Select.Option>
                <Select.Option value="announcement">公告</Select.Option>
              </Select>
            </Form.Item>

            <Form.Item label="分类" name="categoryId">
              <Select
                placeholder="选择分类（可选）"
                allowClear
                showSearch
                optionFilterProp="children"
              >
                {categories.map((cat) => (
                  <Select.Option key={cat.id} value={cat.id}>
                    {cat.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item label="封面图片" name="featuredImageUrl">
              <MediaPicker />
            </Form.Item>

            <Divider style={{ margin: '12px 0' }} />

            <Card size="small" title={<><CalendarOutlined style={{ marginRight: 6 }} />定时发布</>}>
              <Form.Item
                name="publishAt"
                style={{ marginBottom: 0 }}
                help="不填则立即发布（点击「立即发布」时）"
              >
                <DatePicker
                  showTime
                  style={{ width: '100%' }}
                  placeholder="选择定时发布时间"
                  disabledDate={(d) => d && d.isBefore(dayjs(), 'minute')}
                />
              </Form.Item>
            </Card>

            <Divider style={{ margin: '12px 0' }} />

            <Form.Item label="SEO 标题" name="metaTitle">
              <Input placeholder="自定义搜索引擎标题（可选）" />
            </Form.Item>

            <Form.Item label="SEO 描述" name="metaDescription">
              <Input.TextArea
                rows={3}
                placeholder="自定义搜索引擎描述（可选）"
                showCount
                maxLength={160}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item style={{ marginTop: 8 }}>
          <Space>
            <Button
              icon={<SaveOutlined />}
              loading={isPending}
              onClick={handleSaveDraft}
            >
              保存草稿
            </Button>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={isPending}
              onClick={handlePublish}
            >
              {isEditing ? '保存并发布' : '立即发布'}
            </Button>
            <Button onClick={() => navigate('/contents')}>取消</Button>
          </Space>
        </Form.Item>
      </Form>
    </div>
  )
}
