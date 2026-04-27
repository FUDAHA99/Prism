import { useState } from 'react'
import {
  Card, Table, Button, Space, Tag, Input, Select, message, Popconfirm,
  Modal, Form, InputNumber, Radio, Typography, Tooltip,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined,
  ApiOutlined, ReloadOutlined, ProfileOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  listSources, deleteSource, testSource, runCollect,
  CollectSource, CollectMode,
} from '../../api/collect'
import PageHeader from '../../components/common/PageHeader'

const { Text } = Typography

const CONTENT_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  movie: { label: '影视', color: 'blue' },
  novel: { label: '小说', color: 'green' },
  comic: { label: '漫画', color: 'orange' },
}

export default function CollectList() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [contentType, setContentType] = useState<string | undefined>()
  const [statusFilter, setStatusFilter] = useState<string | undefined>()

  const [runTarget, setRunTarget] = useState<CollectSource | null>(null)
  const [runForm] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['collect-sources', page, pageSize, keyword, contentType, statusFilter],
    queryFn: () => listSources({
      page, pageSize, keyword: keyword || undefined,
      contentType: contentType as any, status: statusFilter as any,
    }),
  })

  const delMut = useMutation({
    mutationFn: deleteSource,
    onSuccess: () => {
      message.success('已删除')
      qc.invalidateQueries({ queryKey: ['collect-sources'] })
    },
  })

  const testMut = useMutation({
    mutationFn: testSource,
    onSuccess: (res) => {
      if (res.ok) {
        Modal.success({
          title: '✅ 连接正常',
          width: 600,
          content: (
            <div>
              <p><Text type="secondary">总数：</Text>{res.total} <Text type="secondary"> 总页：</Text>{res.pagecount}</p>
              <p><Text type="secondary">样本：</Text></p>
              <ul style={{ paddingLeft: 20 }}>
                {(res.sample || []).map((s, i) => (
                  <li key={i}>
                    <Text code>{s.vod_id}</Text> {s.vod_name}
                    <Tag style={{ marginLeft: 8 }}>{s.type_name}</Tag>
                  </li>
                ))}
              </ul>
            </div>
          ),
        })
      } else {
        Modal.error({ title: '❌ 连接失败', content: res.error })
      }
    },
  })

  const runMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => runCollect(id, data),
    onSuccess: (res) => {
      message.success(`采集任务已启动 (logId: ${res.logId.slice(0, 8)}...)`)
      setRunTarget(null)
      runForm.resetFields()
      // 跳到日志页看进度
      setTimeout(() => nav(`/collect/logs?logId=${res.logId}`), 800)
    },
    onError: (e: any) => message.error(`启动失败：${e?.message || e}`),
  })

  const columns = [
    { title: '名称', dataIndex: 'name', width: 180 },
    {
      title: '类型', dataIndex: 'contentType', width: 80,
      render: (v: string) => {
        const c = CONTENT_TYPE_LABEL[v] || { label: v, color: 'default' }
        return <Tag color={c.color}>{c.label}</Tag>
      },
    },
    {
      title: '接口 URL', dataIndex: 'apiUrl',
      ellipsis: true,
      render: (v: string) => <Text style={{ fontSize: 12 }} copyable={{ text: v }}>{v}</Text>,
    },
    {
      title: '状态', dataIndex: 'status', width: 80,
      render: (v: string) =>
        v === 'active' ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>,
    },
    {
      title: '已采集', dataIndex: 'totalCollected', width: 90,
      render: (n: number) => <Text strong>{n}</Text>,
    },
    {
      title: '最近采集', dataIndex: 'lastRunAt', width: 160,
      render: (v: string | null) => v ? new Date(v).toLocaleString() : <Text type="secondary">-</Text>,
    },
    {
      title: '操作', width: 280, fixed: 'right' as const,
      render: (_: any, r: CollectSource) => (
        <Space size={4} wrap>
          <Tooltip title="测试连接">
            <Button size="small" icon={<ApiOutlined />}
              loading={testMut.isPending && testMut.variables === r.id}
              onClick={() => testMut.mutate(r.id)} />
          </Tooltip>
          <Tooltip title="开始采集">
            <Button size="small" type="primary" icon={<PlayCircleOutlined />}
              onClick={() => { setRunTarget(r); runForm.resetFields() }} />
          </Tooltip>
          <Button size="small" icon={<EditOutlined />}
            onClick={() => nav(`/collect/${r.id}/edit`)}>编辑</Button>
          <Popconfirm title="确认删除该采集源？所有映射也会一并删除。"
            onConfirm={() => delMut.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="采集管理"
        subtitle="对接苹果 CMS V10 标准接口，把外站资源拉到本地"
        extra={
          <Space>
            <Button icon={<ProfileOutlined />} onClick={() => nav('/collect/logs')}>
              采集日志
            </Button>
            <Button type="primary" icon={<PlusOutlined />}
              onClick={() => nav('/collect/create')}>新建采集源</Button>
          </Space>
        }
      />

      <Card bodyStyle={{ padding: 16 }}>
        <Space style={{ marginBottom: 12 }} wrap>
          <Input.Search placeholder="搜索名称 / URL"
            allowClear style={{ width: 240 }}
            onSearch={(v) => { setKeyword(v); setPage(1) }} />
          <Select placeholder="内容类型" allowClear style={{ width: 120 }}
            value={contentType}
            onChange={(v) => { setContentType(v); setPage(1) }}
            options={[
              { value: 'movie', label: '影视' },
              { value: 'novel', label: '小说' },
              { value: 'comic', label: '漫画' },
            ]} />
          <Select placeholder="状态" allowClear style={{ width: 100 }}
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            options={[
              { value: 'active', label: '启用' },
              { value: 'disabled', label: '禁用' },
            ]} />
          <Button icon={<ReloadOutlined />}
            onClick={() => qc.invalidateQueries({ queryKey: ['collect-sources'] })}>
            刷新
          </Button>
        </Space>

        <Table
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data?.items ?? []}
          scroll={{ x: 1200 }}
          pagination={{
            current: page, pageSize, total: data?.total ?? 0,
            showSizeChanger: true,
            onChange: (p, s) => { setPage(p); setPageSize(s) },
          }}
        />
      </Card>

      {/* 执行采集 Modal */}
      <Modal
        title={`开始采集：${runTarget?.name ?? ''}`}
        open={!!runTarget}
        onCancel={() => setRunTarget(null)}
        onOk={() => {
          runForm.validateFields().then((vals) => {
            runMut.mutate({ id: runTarget!.id, data: vals })
          })
        }}
        confirmLoading={runMut.isPending}
        okText="开始"
      >
        <Form form={runForm} layout="vertical" initialValues={{ mode: 'hours', hours: 24, maxPages: 50 }}>
          <Form.Item name="mode" label="采集模式" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="hours">最近 N 小时</Radio.Button>
              <Radio.Button value="all">全量</Radio.Button>
              <Radio.Button value="page">指定页</Radio.Button>
              <Radio.Button value="single">单条 vod_id</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item dependencies={['mode']} noStyle>
            {({ getFieldValue }) => {
              const mode: CollectMode = getFieldValue('mode')
              if (mode === 'hours')
                return <Form.Item name="hours" label="最近小时数"><InputNumber min={1} max={720} /></Form.Item>
              if (mode === 'page')
                return (
                  <Space>
                    <Form.Item name="pageStart" label="起始页"><InputNumber min={1} /></Form.Item>
                    <Form.Item name="pageEnd" label="结束页"><InputNumber min={1} /></Form.Item>
                  </Space>
                )
              if (mode === 'single')
                return (
                  <Form.Item name="vodIds" label="vod_id（多个用 , 分隔）" rules={[{ required: true }]}>
                    <Input placeholder="如：1024 或 1,2,3" />
                  </Form.Item>
                )
              if (mode === 'all')
                return (
                  <Form.Item name="maxPages" label="最大页数（安全上限）"
                    extra="保护：避免误采万页">
                    <InputNumber min={1} max={500} />
                  </Form.Item>
                )
              return null
            }}
          </Form.Item>

          <Form.Item name="typeId" label="仅采源站某个分类（可选 type_id）">
            <Input placeholder="留空 = 全部分类" />
          </Form.Item>

          <Text type="secondary" style={{ fontSize: 12 }}>
            ⚠️ 只有"启用 + 已映射本地分类"的源分类才会落库；其他会被跳过。
          </Text>
        </Form>
      </Modal>
    </div>
  )
}
