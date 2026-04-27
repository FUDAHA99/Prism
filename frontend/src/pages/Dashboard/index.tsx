import React from 'react'
import {
  Row,
  Col,
  Card,
  Spin,
  Typography,
  Progress,
  Descriptions,
  Tag,
  Space,
  Statistic,
  Tooltip,
} from 'antd'
import {
  VideoCameraOutlined,
  ReadOutlined,
  PictureOutlined,
  FileTextOutlined,
  TeamOutlined,
  MessageOutlined,
  CloudServerOutlined,
  DesktopOutlined,
  ClockCircleOutlined,
  HddOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import ReactECharts from 'echarts-for-react'
import { getDashboardStats, getSystemInfo } from '../../api/stats'
import { useAuthStore } from '../../stores/authStore'
import PageHeader from '../../components/common/PageHeader'

const { Text, Title } = Typography

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 时 ${m} 分`
  if (h > 0) return `${h} 时 ${m} 分`
  return `${m} 分`
}

interface MetricCardProps {
  icon: React.ReactNode
  title: string
  value: number | string
  suffix?: string
  color: string
  background: string
}

function MetricCard({ icon, title, value, suffix, color, background }: MetricCardProps) {
  return (
    <Card hoverable bodyStyle={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background,
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {title}
          </Text>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', lineHeight: 1.2 }}>
            {value}
            {suffix && (
              <span style={{ fontSize: 12, color: '#94A3B8', marginLeft: 4 }}>
                {suffix}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

export default function Dashboard() {
  const user = useAuthStore((s) => s.user)

  const { data: sys, isLoading: sysLoading, refetch: refetchSys } = useQuery({
    queryKey: ['system-info'],
    queryFn: getSystemInfo,
    refetchInterval: 30_000,
  })

  const { data: stats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: getDashboardStats,
    refetchInterval: 60_000,
  })

  if (sysLoading || !sys) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  const memPercent = sys.system.memory.percent
  const memColor = memPercent > 85 ? '#ff4d4f' : memPercent > 60 ? '#faad14' : '#52c41a'

  // 7 日新增图（用户 + 内容）
  const days = sys.timeseries.users.map((d) => d.date.slice(5))
  const usersData = sys.timeseries.users.map((d) => d.count)
  const contentsData = sys.timeseries.contents.map((d) => d.count)

  const trendOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['新增用户', '新增内容'], top: 0, right: 8 },
    grid: { left: 36, right: 16, top: 36, bottom: 24 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: days,
      axisLine: { lineStyle: { color: '#E2E8F0' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#F1F5F9' } },
      axisLabel: { color: '#94A3B8', fontSize: 11 },
    },
    series: [
      {
        name: '新增用户',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        data: usersData,
        itemStyle: { color: '#6366F1' },
        areaStyle: { color: 'rgba(99,102,241,0.15)' },
      },
      {
        name: '新增内容',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        data: contentsData,
        itemStyle: { color: '#10B981' },
        areaStyle: { color: 'rgba(16,185,129,0.15)' },
      },
    ],
  }

  const mediaPieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, left: 'center', icon: 'circle' },
    series: [
      {
        type: 'pie',
        radius: ['52%', '78%'],
        center: ['50%', '42%'],
        label: { show: false },
        data: [
          {
            value: sys.counts.movie,
            name: '影视',
            itemStyle: { color: '#6366F1' },
          },
          {
            value: sys.counts.novel,
            name: '小说',
            itemStyle: { color: '#10B981' },
          },
          {
            value: sys.counts.comic,
            name: '漫画',
            itemStyle: { color: '#F59E0B' },
          },
          {
            value: sys.counts.content,
            name: '文章',
            itemStyle: { color: '#94A3B8' },
          },
        ],
      },
    ],
  }

  return (
    <div>
      <PageHeader
        title={`欢迎回来，${user?.nickname ?? user?.username ?? '管理员'}`}
        subtitle="系统运营 · 资源使用 · 内容总览"
      />

      {/* ─── 顶部 6 张统计卡 ─── */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={8} md={4}>
          <MetricCard
            icon={<VideoCameraOutlined />}
            title="影视库"
            value={sys.counts.movie}
            suffix="部"
            color="#6366F1"
            background="rgba(99,102,241,0.12)"
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <MetricCard
            icon={<ReadOutlined />}
            title="小说库"
            value={sys.counts.novel}
            suffix="本"
            color="#10B981"
            background="rgba(16,185,129,0.12)"
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <MetricCard
            icon={<PictureOutlined />}
            title="漫画库"
            value={sys.counts.comic}
            suffix="本"
            color="#F59E0B"
            background="rgba(245,158,11,0.12)"
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <MetricCard
            icon={<FileTextOutlined />}
            title="文章"
            value={sys.counts.content}
            suffix="篇"
            color="#0EA5E9"
            background="rgba(14,165,233,0.12)"
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <MetricCard
            icon={<TeamOutlined />}
            title="用户"
            value={sys.counts.user}
            suffix="人"
            color="#8B5CF6"
            background="rgba(139,92,246,0.12)"
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <MetricCard
            icon={<MessageOutlined />}
            title="评论"
            value={sys.counts.comment}
            color="#EF4444"
            background="rgba(239,68,68,0.12)"
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {/* ─── 系统信息卡 ─── */}
        <Col xs={24} lg={14}>
          <Card
            title={
              <Space>
                <CloudServerOutlined />
                <span>系统信息</span>
              </Space>
            }
            extra={
              <Tooltip title="刷新">
                <ReloadOutlined
                  onClick={() => refetchSys()}
                  style={{ cursor: 'pointer', color: '#64748B' }}
                />
              </Tooltip>
            }
            bodyStyle={{ padding: 16 }}
          >
            <Descriptions
              column={2}
              size="small"
              labelStyle={{ color: '#64748B', width: 110 }}
              contentStyle={{ color: '#0F172A' }}
            >
              <Descriptions.Item label="操作系统">
                <DesktopOutlined /> {sys.system.platform} ({sys.system.arch})
              </Descriptions.Item>
              <Descriptions.Item label="主机名">{sys.system.hostname}</Descriptions.Item>
              <Descriptions.Item label="Node 版本">
                <Tag color="green">{sys.system.nodeVersion}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="CPU 核心">
                {sys.system.cpu.cores} 核
              </Descriptions.Item>
              <Descriptions.Item label="CPU 型号" span={2}>
                <Text style={{ fontSize: 12 }}>{sys.system.cpu.model}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="系统运行">
                <ClockCircleOutlined /> {fmtUptime(sys.system.uptimeSec)}
              </Descriptions.Item>
              <Descriptions.Item label="进程运行">
                {fmtUptime(sys.system.processUptimeSec)}
              </Descriptions.Item>
              <Descriptions.Item label="登录账号">
                {user?.username}
              </Descriptions.Item>
              <Descriptions.Item label="角色">
                {(user?.roles ?? []).map((r) => (
                  <Tag color="blue" key={r}>
                    {r}
                  </Tag>
                ))}
              </Descriptions.Item>
            </Descriptions>

            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <Text style={{ fontSize: 13 }}>
                  <HddOutlined /> 内存使用
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {fmtBytes(sys.system.memory.used)} / {fmtBytes(sys.system.memory.total)}
                </Text>
              </div>
              <Progress
                percent={memPercent}
                strokeColor={memColor}
                size="small"
                showInfo
              />
            </div>

            {sys.system.cpu.loadAvg.length >= 3 && (
              <div style={{ marginTop: 12 }}>
                <Text style={{ fontSize: 13 }}>负载平均</Text>
                <Space style={{ marginLeft: 12 }}>
                  {sys.system.cpu.loadAvg.map((l, i) => (
                    <Tag key={i} color={l > sys.system.cpu.cores ? 'red' : 'default'}>
                      {['1m', '5m', '15m'][i]}: {l.toFixed(2)}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
          </Card>
        </Col>

        {/* ─── 资源占比饼图 ─── */}
        <Col xs={24} lg={10}>
          <Card title="内容资源占比" bodyStyle={{ padding: 8 }}>
            <ReactECharts option={mediaPieOption} style={{ height: 320 }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* ─── 7 日趋势 ─── */}
        <Col xs={24} lg={16}>
          <Card title="近 7 日新增趋势" bodyStyle={{ padding: 12 }}>
            <ReactECharts option={trendOption} style={{ height: 300 }} />
          </Card>
        </Col>

        {/* ─── 状态摘要 ─── */}
        <Col xs={24} lg={8}>
          <Card title="内容状态" bodyStyle={{ padding: 16 }}>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic
                  title="已发布"
                  value={stats?.content.published ?? 0}
                  valueStyle={{ color: '#10B981' }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="草稿"
                  value={stats?.content.draft ?? 0}
                  valueStyle={{ color: '#94A3B8' }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="待审评论"
                  value={stats?.comment.pending ?? 0}
                  valueStyle={{ color: '#F59E0B' }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="活跃用户"
                  value={stats?.user.active ?? 0}
                  valueStyle={{ color: '#6366F1' }}
                />
              </Col>
              <Col span={24}>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    媒体库容量
                  </Text>
                  <Title level={5} style={{ margin: 0 }}>
                    {fmtBytes(stats?.media.totalSize ?? 0)}
                    <Text
                      type="secondary"
                      style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}
                    >
                      ({stats?.media.total ?? 0} 个文件)
                    </Text>
                  </Title>
                </div>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
