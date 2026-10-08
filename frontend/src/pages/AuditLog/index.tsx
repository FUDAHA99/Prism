import React, { useState } from 'react'
import { Select, Table, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { getAuditLogs } from '../../api/auditLog'
import PageHeader from '../../components/common/PageHeader'
import type { AuditLog } from '../../types'

const { Text } = Typography

const PAGE_SIZE = 20

/**
 * 操作类型筛选项。后端按 action 精确匹配，所以值必须与后端 auditService.log 实际写入的动作名一字不差
 * （此前的 ROLE_ASSIGN 后端从未写过，按角色变更筛选永远为空）。
 * backend/src/modules/audit/audit-actions.spec.ts 会扫描后端源码，与这里的 [动作名, 说明] 清单逐项比对：
 * 后端新增或改名动作而这里没跟上，测试即失败。
 */
const ACTION_GROUPS: { label: string; actions: [action: string, text: string][] }[] = [
  {
    label: '账号与权限',
    actions: [
      ['USER_LOGIN', '登录'],
      ['USER_LOGOUT', '退出登录'],
      ['USER_REGISTER', '注册'],
      ['USER_CHANGE_PASSWORD', '修改密码'],
      ['USER_CREATE', '新建用户'],
      ['USER_UPDATE', '修改用户'],
      ['USER_DELETE', '删除用户'],
      ['USER_ACTIVATE', '启用用户'],
      ['USER_DEACTIVATE', '禁用用户'],
      ['USER_ASSIGN_ROLES', '分配角色'],
      ['USER_REMOVE_ROLES', '移除角色'],
    ],
  },
  {
    label: '文章',
    actions: [
      ['CONTENT_CREATE', '新建文章'],
      ['CONTENT_UPDATE', '修改文章'],
      ['CONTENT_PUBLISH', '发布文章'],
      ['CONTENT_UNPUBLISH', '下线文章'],
      ['CONTENT_DELETE', '删除文章'],
    ],
  },
  {
    label: '影视',
    actions: [
      ['MOVIE_CREATE', '新建影视'],
      ['MOVIE_UPDATE', '修改影视'],
      ['MOVIE_UPDATE_POSTER', '更换海报'],
      ['MOVIE_PUBLISH', '发布影视'],
      ['MOVIE_UNPUBLISH', '下线影视'],
      ['MOVIE_DELETE', '删除影视'],
      ['MOVIE_SOURCE_CREATE', '新建播放源'],
      ['MOVIE_SOURCE_DELETE', '删除播放源'],
      ['MOVIE_EPISODE_CREATE', '新建剧集'],
      ['MOVIE_EPISODE_UPDATE', '修改剧集'],
      ['MOVIE_EPISODE_DELETE', '删除剧集'],
    ],
  },
  {
    label: '小说',
    actions: [
      ['NOVEL_CREATE', '新建小说'],
      ['NOVEL_UPDATE', '修改小说'],
      ['NOVEL_PUBLISH', '发布小说'],
      ['NOVEL_UNPUBLISH', '下线小说'],
      ['NOVEL_DELETE', '删除小说'],
      ['NOVEL_CHAPTER_CREATE', '新建小说章节'],
      ['NOVEL_CHAPTER_UPDATE', '修改小说章节'],
      ['NOVEL_CHAPTER_DELETE', '删除小说章节'],
    ],
  },
  {
    label: '漫画',
    actions: [
      ['COMIC_CREATE', '新建漫画'],
      ['COMIC_UPDATE', '修改漫画'],
      ['COMIC_PUBLISH', '发布漫画'],
      ['COMIC_UNPUBLISH', '下线漫画'],
      ['COMIC_DELETE', '删除漫画'],
      ['COMIC_CHAPTER_CREATE', '新建漫画章节'],
      ['COMIC_CHAPTER_UPDATE', '修改漫画章节'],
      ['COMIC_CHAPTER_DELETE', '删除漫画章节'],
    ],
  },
  {
    label: '媒体',
    actions: [
      ['MEDIA_UPLOAD', '上传文件'],
      ['MEDIA_DELETE', '删除文件'],
    ],
  },
  {
    // 采集模块写的是通用动作名，资源类型列区分 collect_source / collect_category_mapping
    label: '采集',
    actions: [
      ['CREATE', '新建采集源'],
      ['UPDATE', '修改采集源'],
      ['DELETE', '删除采集源或分类映射'],
      ['UPSERT', '保存分类映射'],
    ],
  },
]

const ACTION_OPTIONS = [
  { label: '全部操作', value: '' },
  ...ACTION_GROUPS.map((group) => ({
    label: group.label,
    options: group.actions.map(([value, text]) => ({ label: `${text}（${value}）`, value })),
  })),
]

export default function AuditLogPage() {
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', action, page],
    queryFn: () =>
      getAuditLogs({
        action: action || undefined,
        page,
        limit: PAGE_SIZE,
      }),
  })

  const logs: (AuditLog & { username?: string })[] = data?.data ?? []
  const total = data?.meta?.total ?? 0

  const columns: TableColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (val: string) => new Date(val).toLocaleString('zh-CN'),
    },
    {
      title: '操作用户',
      dataIndex: 'username',
      key: 'username',
      width: 160,
      render: (_: string, record: AuditLog & { username?: string }) => {
        if (!record.userId) return <Text type="secondary">-</Text>
        return record.username ? (
          <Tooltip title={`UID: ${record.userId}`}>
            <Text strong>{record.username}</Text>
          </Tooltip>
        ) : (
          <Text code style={{ fontSize: 11 }}>{record.userId.slice(0, 8)}…</Text>
        )
      },
    },
    {
      title: '操作',
      dataIndex: 'action',
      key: 'action',
      width: 180,
      render: (val: string) => <Text strong>{val}</Text>,
    },
    {
      title: '资源类型',
      dataIndex: 'resourceType',
      key: 'resourceType',
      width: 140,
    },
    {
      title: 'IP地址',
      dataIndex: 'ipAddress',
      key: 'ipAddress',
      width: 150,
      render: (ip: string) => <Text type="secondary">{ip}</Text>,
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <PageHeader title="操作日志" subtitle="记录所有用户的关键操作" />

      {/* 操作类型筛选 */}
      <div style={{ marginBottom: 16 }}>
        <Select
          value={action}
          options={ACTION_OPTIONS}
          showSearch
          optionFilterProp="label"
          style={{ width: 280 }}
          onChange={(val) => {
            setAction(val)
            setPage(1)
          }}
          placeholder="筛选操作类型"
        />
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={logs}
        loading={isLoading}
        scroll={{ x: 900 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          onChange: (p) => setPage(p),
          showTotal: (t) => `共 ${t} 条日志`,
          showSizeChanger: false,
        }}
        size="middle"
      />
    </div>
  )
}
