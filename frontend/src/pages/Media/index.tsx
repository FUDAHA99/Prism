import React, { useState } from 'react'
import {
  Button,
  Card,
  Col,
  message,
  Modal,
  Pagination,
  Popconfirm,
  Row,
  Select,
  Spin,
  Typography,
  Upload,
} from 'antd'
import {
  DeleteOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UploadFile } from 'antd'
import { deleteMediaFile, getMediaFiles, uploadFile } from '../../api/media'
import PageHeader from '../../components/common/PageHeader'
import { formatBytes, formatDate } from '../../utils'
import type { MediaFile } from '../../types'

const { Text } = Typography
const { Dragger } = Upload

const MIME_OPTIONS = [
  { label: '全部类型', value: '' },
  { label: '图片', value: 'image' },
  { label: '视频', value: 'video' },
  { label: 'PDF', value: 'application/pdf' },
]

const PAGE_SIZE = 18

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('video/')) return <VideoCameraOutlined style={{ fontSize: 48, color: '#1890ff' }} />
  if (mimeType === 'application/pdf') return <FilePdfOutlined style={{ fontSize: 48, color: '#ff4d4f' }} />
  if (mimeType.startsWith('text/')) return <FileTextOutlined style={{ fontSize: 48, color: '#52c41a' }} />
  return <FileOutlined style={{ fontSize: 48, color: '#8c8c8c' }} />
}

function MediaCard({ file, onDelete }: { file: MediaFile; onDelete: (id: string) => void }) {
  const [hovered, setHovered] = useState(false)
  const isImage = file.mimeType.startsWith('image/')

  return (
    <div
      style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid #f0f0f0', background: '#fff' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          height: 160,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fafafa',
          overflow: 'hidden',
        }}
      >
        {isImage ? (
          <img
            src={file.thumbnailUrl ?? file.url}
            alt={file.originalName}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <FileTypeIcon mimeType={file.mimeType} />
        )}
      </div>

      {hovered && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Popconfirm
            title="确认删除"
            description="删除后无法恢复，确认删除该文件？"
            onConfirm={() => onDelete(file.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()}>
              删除
            </Button>
          </Popconfirm>
        </div>
      )}

      <div style={{ padding: '8px 10px' }}>
        <Text
          ellipsis={{ tooltip: file.originalName }}
          style={{ display: 'block', fontSize: 13, fontWeight: 500 }}
        >
          {file.originalName}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatBytes(file.size)} · {formatDate(file.createdAt, 'YYYY-MM-DD')}
        </Text>
      </div>
    </div>
  )
}

export default function MediaPage() {
  const [mimeFilter, setMimeFilter] = useState('')
  const [page, setPage] = useState(1)
  const [uploadVisible, setUploadVisible] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [uploading, setUploading] = useState(false)

  const queryClient = useQueryClient()

  const params = {
    mimeType: mimeFilter || undefined,
    page,
    limit: PAGE_SIZE,
  }

  const { data, isLoading } = useQuery({
    queryKey: ['media', params],
    queryFn: () => getMediaFiles(params),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMediaFile(id),
    onSuccess: () => {
      message.success('文件已删除')
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
    onError: () => {
      message.error('删除失败，请重试')
    },
  })

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id)
  }

  const handleUpload = async () => {
    if (fileList.length === 0) {
      message.warning('请先选择文件')
      return
    }

    setUploading(true)
    const results = await Promise.allSettled(
      fileList.map((f) => uploadFile(f.originFileObj as File))
    )

    const failed = results.filter((r) => r.status === 'rejected').length
    const succeeded = results.length - failed

    setUploading(false)

    if (succeeded > 0) {
      message.success(`成功上传 ${succeeded} 个文件`)
      queryClient.invalidateQueries({ queryKey: ['media'] })
    }
    if (failed > 0) {
      message.error(`${failed} 个文件上传失败`)
    }

    setFileList([])
    setUploadVisible(false)
  }

  const files = data?.data ?? []
  const total = data?.meta?.total ?? 0

  return (
    <div style={{ padding: 24 }}>
      <PageHeader
        title="媒体库"
        extra={
          <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadVisible(true)}>
            上传文件
          </Button>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <Select
          value={mimeFilter}
          onChange={(val) => { setMimeFilter(val); setPage(1) }}
          options={MIME_OPTIONS}
          style={{ width: 160 }}
          placeholder="文件类型"
        />
      </div>

      <Spin spinning={isLoading}>
        {files.length === 0 && !isLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8c8c8c' }}>
            暂无媒体文件
          </div>
        ) : (
          <Row gutter={[16, 16]}>
            {files.map((file) => (
              <Col key={file.id} xs={24} sm={12} md={8} lg={6} xl={4}>
                <MediaCard file={file} onDelete={handleDelete} />
              </Col>
            ))}
          </Row>
        )}
      </Spin>

      {total > PAGE_SIZE && (
        <div style={{ marginTop: 24, textAlign: 'right' }}>
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={(p) => setPage(p)}
            showSizeChanger={false}
            showTotal={(t) => `共 ${t} 个文件`}
          />
        </div>
      )}

      <Modal
        title="上传文件"
        open={uploadVisible}
        onCancel={() => { setUploadVisible(false); setFileList([]) }}
        onOk={handleUpload}
        okText="开始上传"
        cancelText="取消"
        confirmLoading={uploading}
        width={520}
      >
        <Dragger
          multiple
          beforeUpload={() => false}
          fileList={fileList}
          onChange={({ fileList: list }) => setFileList(list)}
          style={{ marginTop: 8 }}
        >
          <p className="ant-upload-drag-icon">
            <UploadOutlined style={{ fontSize: 32, color: '#1890ff' }} />
          </p>
          <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
          <p className="ant-upload-hint">支持单个或批量上传，支持图片、视频、PDF 等格式</p>
        </Dragger>
      </Modal>
    </div>
  )
}
