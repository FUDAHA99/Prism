import { Card, Spin, Table, Typography } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { getSearchKeywords, type SearchKeywords } from '../../api/stats'
import { hasAnyRole, ROLES_FOR_ACCESS } from '../../utils/access'
import { portalMovieSearchUrl } from '../../utils/portal-url'
import QueryErrorResult from '../../components/common/QueryErrorResult'

export default function SearchKeywordCard({ roles }: { roles: unknown }) {
  return hasAnyRole(roles, ROLES_FOR_ACCESS.admin) ? <SearchKeywordResults /> : null
}

function SearchKeywordResults() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['search-keywords'],
    queryFn: getSearchKeywords,
    refetchInterval: 60_000,
  })

  return (
    <Card title="近7日影视搜索提交榜" style={{ marginTop: 16 }}>
      <Typography.Paragraph type="secondary">按有效上报次数排序，不代表独立访客数。</Typography.Paragraph>
      {error ? <QueryErrorResult error={error} onRetry={refetch} /> : isPending ? (
        <div><Spin size="small" /> 正在加载搜索榜单…</div>
      ) : data && (
        <>
          <Typography.Paragraph type="secondary">{data.from} 至 {data.to}（北京时间）</Typography.Paragraph>
          <Table<SearchKeywords['items'][number]>
            size="small"
            rowKey="keyword"
            pagination={false}
            dataSource={data.items}
            locale={{ emptyText: '近7日暂无有效搜索上报' }}
            columns={[
              {
                title: '搜索词', dataIndex: 'keyword',
                render: (keyword: string) => <a href={portalMovieSearchUrl(keyword)} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: 'anywhere' }}>{keyword}</a>,
              },
              { title: '有效上报次数', dataIndex: 'count', width: 130 },
            ]}
          />
        </>
      )}
    </Card>
  )
}
