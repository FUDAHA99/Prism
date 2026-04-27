import { useEffect, useState } from 'react'
import {
  Card, Table, Tag, Button, Space, Drawer, Descriptions, Typography, Statistic, Row, Col, Progress, Empty,
} from 'antd'
import { ReloadOutlined, EyeOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { listLogs, getLog, CollectLog, CollectLogStatus } from '../../api/collect'
import PageHeader from '../../components/common/PageHeader'

const { Text } = Typography

const STATUS_LABEL: Record<CollectLogStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: 'processing' },
  success: { label: '成功', color: 'success' },
  partial: { label: '部分成功', color: 'warning' },
  failed: { label: '失败', color: 'error' },
  cancelled: { label: '已取消', color: 'default' },
}

const MODE_LABEL: Record<string, string> = {
  hours: '增量',
  all: '全量',
  page: '指定页',
  single: '单条',
}

export default function CollectLogs() {
  const [sp, setSp] = useSearchParams()
  const initialId = sp.get('logId') || undefined
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [openId, setOpenId] = useState<string | undefined>(initialId)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['collect-logs', page, pageSize],
    queryFn: () => listLogs({ page, pageSize }),
    // 列表如果有运行中的，3 秒轮询
    refetchInterval: (q) =>
      q.state.data?.items?.some((l: CollectLog) => l.status === 'running') ? 3000 : false,
  })

  const columns = [
    {
      title: '采集源', dataIndex: 'sourceName', width: 180,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '模式', dataIndex: 'mode', width: 90,
      render: (v: string) => <Tag>{MODE_LABEL[v] || v}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (v: CollectLogStatus) => {
        const c = STATUS_LABEL[v]
        return <Tag color={c.color}>{c.label}</Tag>
      },
    },
    {
      title: '总/新增/更新/跳过/失败', width: 220,
      render: (_: any, r: CollectLog) =>
        <Text style={{ fontSize: 12 }}>
          {r.totalCount} / <Text type="success">{r.insertedCount}</Text>
          {' / '}<Text style={{ color: '#1677ff' }}>{r.updatedCount}</Text>
          {' / '}<Text type="secondary">{r.skippedCount}</Text>
          {' / '}<Text type="danger">{r.failedCount}</Text>
        </Text>,
    },
    {
      title: '耗时', dataIndex: 'durationMs', width: 90,
      render: (v: number) => v ? `${(v / 1000).toFixed(1)}s` : <Text type="secondary">-</Text>,
    },
    {
      title: '开始时间', dataIndex: 'createdAt', width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作', width: 100, fixed: 'right' as const,
      render: (_: any, r: CollectLog) => (
        <Button size="small" icon={<EyeOutlined />}
          onClick={() => { setOpenId(r.id); sp.set('logId', r.id); setSp(sp) }}>
          详情
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="采集日志"
        subtitle="所有采集任务的运行记录与统计"
        extra={<Button icon={<ReloadOutlined />} onClick={() => refetch()}>刷新</Button>}
      />
      <Card>
        <Table
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data?.items ?? []}
          scroll={{ x: 1100 }}
          pagination={{
            current: page, pageSize, total: data?.total ?? 0,
            showSizeChanger: true,
            onChange: (p, s) => { setPage(p); setPageSize(s) },
          }}
          locale={{ emptyText: <Empty description="尚无采集记录" /> }}
        />
      </Card>

      <LogDetailDrawer logId={openId} onClose={() => {
        setOpenId(undefined); sp.delete('logId'); setSp(sp)
      }} />
    </div>
  )
}

// ==========================
function LogDetailDrawer({ logId, onClose }: { logId?: string; onClose: () => void }) {
  const { data: log, refetch } = useQuery({
    queryKey: ['collect-log', logId],
    queryFn: () => getLog(logId!),
    enabled: !!logId,
    refetchInterval: (q) => q.state.data?.status === 'running' ? 2000 : false,
  })

  // 切换打开时主动刷新
  useEffect(() => { if (logId) refetch() }, [logId, refetch])

  const total = log?.totalCount || 0
  const success = (log?.insertedCount || 0) + (log?.updatedCount || 0)
  const successRate = total > 0 ? Math.round((success / total) * 100) : 0

  return (
    <Drawer
      title="采集任务详情"
      open={!!logId}
      onClose={onClose}
      width={560}
    >
      {log ? (
        <>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="采集源">{log.sourceName}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_LABEL[log.status]?.color}>{STATUS_LABEL[log.status]?.label}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="模式">
              {MODE_LABEL[log.mode] || log.mode}
            </Descriptions.Item>
            <Descriptions.Item label="参数">
              <Text code style={{ fontSize: 12 }}>{JSON.stringify(log.params || {}, null, 0)}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="开始时间">{new Date(log.createdAt).toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="完成时间">
              {log.finishedAt ? new Date(log.finishedAt).toLocaleString() : <Text type="secondary">运行中…</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="耗时">
              {log.durationMs ? `${(log.durationMs / 1000).toFixed(2)} 秒` : '-'}
            </Descriptions.Item>
          </Descriptions>

          <Row gutter={[12, 12]}>
            <Col span={8}><Card size="small"><Statistic title="总抓取" value={log.totalCount} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="新增" value={log.insertedCount} valueStyle={{ color: '#10B981' }} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="更新" value={log.updatedCount} valueStyle={{ color: '#1677ff' }} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="跳过" value={log.skippedCount} valueStyle={{ color: '#94A3B8' }} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="失败" value={log.failedCount} valueStyle={{ color: '#EF4444' }} /></Card></Col>
            <Col span={8}><Card size="small"><Statistic title="成功率" value={successRate} suffix="%" /></Card></Col>
          </Row>

          <div style={{ marginTop: 16 }}>
            <Text>处理进度</Text>
            <Progress percent={successRate} size="small"
              status={log.status === 'failed' ? 'exception' : log.status === 'running' ? 'active' : 'success'} />
          </div>

          {log.errorMessage ? (
            <Card size="small" style={{ marginTop: 16, borderColor: '#fadb14' }}
              title={<Text type="warning">错误信息</Text>}>
              <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{log.errorMessage}</Text>
            </Card>
          ) : null}
        </>
      ) : <Empty />}
    </Drawer>
  )
}
