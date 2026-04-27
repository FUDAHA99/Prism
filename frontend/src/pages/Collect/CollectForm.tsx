import { useEffect, useState } from 'react'
import {
  Card, Form, Input, Select, InputNumber, Button, Space, Tabs, message,
  Table, Tag, Popconfirm, Switch, Tooltip, Empty, Spin, Typography,
} from 'antd'
import { ArrowLeftOutlined, SaveOutlined, ApiOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getSource, createSource, updateSource, testSource,
  discoverCategories, listMappings, batchUpsertMappings, deleteMapping,
  CollectCategoryMapping, DiscoveredCategory, UpsertMappingData,
} from '../../api/collect'
import { getCategories } from '../../api/category'
import PageHeader from '../../components/common/PageHeader'

const { Text } = Typography

export default function CollectForm() {
  const { id } = useParams<{ id: string }>()
  const isEdit = !!id
  const nav = useNavigate()
  const qc = useQueryClient()
  const [form] = Form.useForm()

  const { data: source, isLoading } = useQuery({
    queryKey: ['collect-source', id],
    queryFn: () => getSource(id!),
    enabled: isEdit,
  })

  useEffect(() => {
    if (source) {
      form.setFieldsValue({
        ...source,
        extraHeadersJson: source.extraHeaders ? JSON.stringify(source.extraHeaders, null, 2) : '',
      })
    }
  }, [source, form])

  const saveMut = useMutation({
    mutationFn: async (vals: any) => {
      const payload: any = { ...vals }
      delete payload.extraHeadersJson
      if (vals.extraHeadersJson) {
        try { payload.extraHeaders = JSON.parse(vals.extraHeadersJson) }
        catch { throw new Error('extraHeaders JSON 格式不正确') }
      }
      if (isEdit) return updateSource(id!, payload)
      return createSource(payload)
    },
    onSuccess: (res: any) => {
      message.success(isEdit ? '已保存' : '已创建')
      qc.invalidateQueries({ queryKey: ['collect-sources'] })
      if (!isEdit) nav(`/collect/${res.id}/edit`)
    },
    onError: (e: any) => message.error(e?.message || '保存失败'),
  })

  return (
    <div>
      <PageHeader
        title={isEdit ? '编辑采集源' : '新建采集源'}
        extra={
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/collect')}>返回</Button>
            <Button type="primary" icon={<SaveOutlined />}
              loading={saveMut.isPending}
              onClick={() => form.validateFields().then(saveMut.mutate)}>
              保存
            </Button>
          </Space>
        }
      />
      <Spin spinning={isLoading}>
        <Tabs
          items={[
            {
              key: 'basic',
              label: '基础设置',
              children: (
                <Card>
                  <Form form={form} layout="vertical" initialValues={{
                    sourceType: 'maccms_json',
                    contentType: 'movie',
                    status: 'active',
                    sortOrder: 0,
                    timeoutSec: 30,
                  }}>
                    <Form.Item name="name" label="名称" rules={[{ required: true }]}>
                      <Input placeholder="如：飞速资源" />
                    </Form.Item>
                    <Form.Item name="apiUrl" label="接口 URL"
                      rules={[{ required: true, type: 'url' }]}>
                      <Input placeholder="https://xxx.com/api.php/provide/vod/" />
                    </Form.Item>
                    <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
                      <Form.Item name="sourceType" label="接口类型" style={{ minWidth: 200 }}>
                        <Select options={[
                          { value: 'maccms_json', label: '苹果 CMS JSON' },
                          { value: 'maccms_xml', label: '苹果 CMS XML（暂未支持）', disabled: true },
                        ]} />
                      </Form.Item>
                      <Form.Item name="contentType" label="目标内容类型" style={{ minWidth: 200 }}>
                        <Select options={[
                          { value: 'movie', label: '影视' },
                          { value: 'novel', label: '小说' },
                          { value: 'comic', label: '漫画' },
                        ]} />
                      </Form.Item>
                      <Form.Item name="status" label="状态" style={{ minWidth: 140 }}>
                        <Select options={[
                          { value: 'active', label: '启用' },
                          { value: 'disabled', label: '禁用' },
                        ]} />
                      </Form.Item>
                      <Form.Item name="sortOrder" label="排序权重">
                        <InputNumber min={0} />
                      </Form.Item>
                      <Form.Item name="timeoutSec" label="请求超时(秒)">
                        <InputNumber min={5} max={600} />
                      </Form.Item>
                    </Space>
                    <Form.Item name="userAgent" label="User-Agent（可选）">
                      <Input placeholder="留空使用默认浏览器 UA" />
                    </Form.Item>
                    <Form.Item name="defaultPlayFrom" label="默认线路名（可选；留空匹配所有）">
                      <Input placeholder="如 ckm3u8" />
                    </Form.Item>
                    <Form.Item name="extraHeadersJson" label="额外请求头（JSON，可选）">
                      <Input.TextArea rows={3} placeholder='{"Referer":"https://xxx.com"}' />
                    </Form.Item>
                    <Form.Item name="remark" label="备注">
                      <Input.TextArea rows={2} />
                    </Form.Item>
                  </Form>
                </Card>
              ),
            },
            {
              key: 'mappings',
              label: '分类映射',
              disabled: !isEdit,
              children: isEdit ? <MappingsPanel sourceId={id!} /> : null,
            },
          ]}
        />
      </Spin>
    </div>
  )
}

// =========================================================
// 分类映射子面板
// =========================================================
function MappingsPanel({ sourceId }: { sourceId: string }) {
  const qc = useQueryClient()

  const { data: localCats } = useQuery({
    queryKey: ['categories'],
    queryFn: getCategories,
  })

  const { data: mappings = [], refetch: refetchMappings, isLoading } = useQuery({
    queryKey: ['collect-mappings', sourceId],
    queryFn: () => listMappings(sourceId),
  })

  const [discovered, setDiscovered] = useState<DiscoveredCategory[]>([])
  const discoverMut = useMutation({
    mutationFn: () => discoverCategories(sourceId),
    onSuccess: (cats) => {
      setDiscovered(cats)
      message.success(`从源站发现 ${cats.length} 个分类`)
    },
    onError: (e: any) => message.error(`探查失败：${e?.message || e}`),
  })

  const testMut = useMutation({
    mutationFn: () => testSource(sourceId),
    onSuccess: (r) => {
      if (r.ok) message.success(`✅ 连接 OK，总数 ${r.total} / 总页 ${r.pagecount}`)
      else message.error(`❌ ${r.error}`)
    },
  })

  const saveMut = useMutation({
    mutationFn: (items: UpsertMappingData[]) => batchUpsertMappings(sourceId, items),
    onSuccess: () => {
      message.success('映射已保存')
      refetchMappings()
    },
  })

  const delMut = useMutation({
    mutationFn: deleteMapping,
    onSuccess: () => { message.success('已删除'); refetchMappings() },
  })

  // 工作集 —— 把已有映射和新探查的分类合并
  const merged = mergeMappings(mappings, discovered)
  const [draft, setDraft] = useState<Map<string, UpsertMappingData>>(new Map())

  const updateDraft = (sourceCatId: string, sourceCatName: string,
    patch: Partial<UpsertMappingData>) => {
    const next = new Map(draft)
    const existing = next.get(sourceCatId) ?? {
      sourceCategoryId: sourceCatId,
      sourceCategoryName: sourceCatName,
    }
    next.set(sourceCatId, { ...existing, ...patch, sourceCategoryId: sourceCatId, sourceCategoryName: sourceCatName })
    setDraft(next)
  }

  const handleSave = () => {
    if (draft.size === 0) { message.info('没有变更'); return }
    saveMut.mutate(Array.from(draft.values()))
    setDraft(new Map())
  }

  const columns = [
    { title: '源分类 ID', dataIndex: 'sourceCategoryId', width: 100, render: (v: string) => <Text code>{v}</Text> },
    { title: '源分类名', dataIndex: 'sourceCategoryName', width: 180 },
    {
      title: '映射到本地分类', width: 280,
      render: (_: any, r: any) => {
        const current = draft.get(r.sourceCategoryId)?.localCategoryId ?? r.localCategoryId ?? null
        return (
          <Select
            allowClear style={{ width: '100%' }}
            placeholder="留空 = 跳过该分类"
            value={current ?? undefined}
            onChange={(v) => updateDraft(r.sourceCategoryId, r.sourceCategoryName, { localCategoryId: v ?? null })}
            options={(localCats || []).map((c) => ({ value: c.id, label: c.name }))}
            showSearch optionFilterProp="label"
          />
        )
      },
    },
    {
      title: '启用', width: 80,
      render: (_: any, r: any) => {
        const current = draft.get(r.sourceCategoryId)?.enabled ?? r.enabled ?? true
        return (
          <Switch checked={current}
            onChange={(v) => updateDraft(r.sourceCategoryId, r.sourceCategoryName, { enabled: v })} />
        )
      },
    },
    {
      title: '操作', width: 80,
      render: (_: any, r: any) => r.id ? (
        <Popconfirm title="删除此映射？" onConfirm={() => delMut.mutate(r.id)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ) : <Tag color="processing">未保存</Tag>,
    },
  ]

  return (
    <Card>
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<ApiOutlined />} loading={testMut.isPending}
          onClick={() => testMut.mutate()}>
          测试连接
        </Button>
        <Button type="primary" icon={<ReloadOutlined />}
          loading={discoverMut.isPending}
          onClick={() => discoverMut.mutate()}>
          从源站探查分类
        </Button>
        <Button type="primary" ghost
          loading={saveMut.isPending}
          disabled={draft.size === 0}
          onClick={handleSave}>
          保存变更{draft.size > 0 ? ` (${draft.size})` : ''}
        </Button>
      </Space>

      <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        💡 工作流：① 测试连接 → ② 探查分类 → ③ 把每个源分类映射到本地分类 → ④ 保存。
        留空本地分类 / 关闭"启用"开关 = 该分类的内容会被跳过。
      </Text>

      {merged.length === 0 ? (
        <Empty description="尚无分类映射，点击「从源站探查分类」开始" />
      ) : (
        <Table
          rowKey={(r) => r.id || `_new_${r.sourceCategoryId}`}
          loading={isLoading}
          columns={columns}
          dataSource={merged}
          pagination={false}
          size="small"
        />
      )}
    </Card>
  )
}

// 合并已有映射 + 探查到的分类（按 sourceCategoryId 去重，保留已有的元数据）
function mergeMappings(existing: CollectCategoryMapping[], discovered: DiscoveredCategory[]) {
  const seen = new Map<string, any>()
  for (const m of existing) seen.set(m.sourceCategoryId, m)
  for (const d of discovered) {
    if (!seen.has(d.id)) {
      seen.set(d.id, {
        id: '',
        sourceCategoryId: d.id,
        sourceCategoryName: d.name,
        localCategoryId: null,
        enabled: true,
      })
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    (a.sourceCategoryName || '').localeCompare(b.sourceCategoryName || ''))
}
