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
  InputNumber,
  Switch,
  Card,
  Divider,
} from 'antd'
import { SaveOutlined, SendOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getComic,
  createComic,
  updateComic,
  type CreateComicData,
} from '../../api/comic'
import PageHeader from '../../components/common/PageHeader'
import MediaPicker from '../../components/media/MediaPicker'
import { generateSlug } from '../../utils'

export default function ComicForm() {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const isEditing = Boolean(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form] = Form.useForm<CreateComicData>()

  const { data: comic, isLoading } = useQuery({
    queryKey: ['comic', id],
    queryFn: () => getComic(id!),
    enabled: isEditing,
  })

  useEffect(() => {
    if (comic) {
      form.setFieldsValue({
        title: comic.title,
        slug: comic.slug,
        author: comic.author,
        subType: comic.subType,
        coverUrl: comic.coverUrl,
        intro: comic.intro,
        serialStatus: comic.serialStatus,
        score: comic.score,
        isFeatured: comic.isFeatured,
        isVip: comic.isVip,
        metaTitle: comic.metaTitle,
        metaKeywords: comic.metaKeywords,
        metaDescription: comic.metaDescription,
      })
    }
  }, [comic, form])

  const createMut = useMutation({
    mutationFn: (data: CreateComicData) => createComic(data),
    onSuccess: (n) => {
      message.success('创建成功')
      qc.invalidateQueries({ queryKey: ['comics'] })
      navigate(`/comics/${n.id}/edit`)
    },
    onError: () => message.error('创建失败'),
  })

  const updateMut = useMutation({
    mutationFn: (data: Partial<CreateComicData>) => updateComic(id!, data),
    onSuccess: () => {
      message.success('更新成功')
      qc.invalidateQueries({ queryKey: ['comics'] })
      qc.invalidateQueries({ queryKey: ['comic', id] })
    },
    onError: () => message.error('更新失败'),
  })

  const handleSubmit = (publish = false) => {
    form.validateFields().then((values) => {
      const payload: CreateComicData = {
        ...values,
        ...(publish ? { status: 'published' } : {}),
      }
      if (isEditing) updateMut.mutate(payload)
      else createMut.mutate(payload)
    })
  }

  const isPending = createMut.isPending || updateMut.isPending

  if (isEditing && isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={isEditing ? '编辑漫画' : '新建漫画'}
        extra={
          <Space>
            {isEditing && (
              <Button onClick={() => navigate(`/comics/${id}/chapters`)}>
                章节管理
              </Button>
            )}
            <Button onClick={() => navigate('/comics')}>返回列表</Button>
          </Space>
        }
      />

      <Form<CreateComicData>
        form={form}
        layout="vertical"
        initialValues={{
          serialStatus: 'ongoing',
          isFeatured: false,
          isVip: false,
          score: 0,
        }}
        style={{ maxWidth: 1100 }}
      >
        <Row gutter={24}>
          <Col span={16}>
            <Card size="small" title="基础信息" style={{ marginBottom: 16 }}>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    label="书名"
                    name="title"
                    rules={[{ required: true, message: '请输入书名' }]}
                  >
                    <Input
                      placeholder="例：海贼王"
                      onChange={(e) => {
                        if (!isEditing) {
                          form.setFieldValue('slug', generateSlug(e.target.value))
                        }
                      }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="作者" name="author">
                    <Input placeholder="作者姓名" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    label="Slug"
                    name="slug"
                    rules={[
                      { required: true, message: '请输入 Slug' },
                      {
                        pattern: /^[a-z0-9-]+$/,
                        message: '只能小写字母/数字/连字符',
                      },
                    ]}
                  >
                    <Input placeholder="one-piece" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="子分类" name="subType">
                    <Input placeholder="少年 / 热血" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item
                    label="连载状态"
                    name="serialStatus"
                    rules={[{ required: true }]}
                  >
                    <Select>
                      <Select.Option value="ongoing">连载中</Select.Option>
                      <Select.Option value="finished">已完结</Select.Option>
                      <Select.Option value="paused">暂停</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item label="简介" name="intro">
                <Input.TextArea rows={5} showCount maxLength={2000} />
              </Form.Item>
            </Card>

            <Card size="small" title="SEO">
              <Form.Item label="SEO 标题" name="metaTitle">
                <Input />
              </Form.Item>
              <Form.Item label="SEO 关键字" name="metaKeywords">
                <Input placeholder="逗号分隔" />
              </Form.Item>
              <Form.Item label="SEO 描述" name="metaDescription">
                <Input.TextArea rows={3} maxLength={500} showCount />
              </Form.Item>
            </Card>
          </Col>

          <Col span={8}>
            <Card size="small" title="封面" style={{ marginBottom: 16 }}>
              <Form.Item label="封面图" name="coverUrl">
                <MediaPicker />
              </Form.Item>
            </Card>

            <Card size="small" title="状态">
              <Form.Item label="评分" name="score">
                <InputNumber min={0} max={10} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item label="是否推荐" name="isFeatured" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item label="VIP内容" name="isVip" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Card>
          </Col>
        </Row>

        <Divider />
        <Space>
          <Button
            icon={<SaveOutlined />}
            loading={isPending}
            onClick={() => handleSubmit(false)}
          >
            保存草稿
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={isPending}
            onClick={() => handleSubmit(true)}
          >
            {isEditing ? '保存并发布' : '立即发布'}
          </Button>
          <Button onClick={() => navigate('/comics')}>取消</Button>
        </Space>
      </Form>
    </div>
  )
}
