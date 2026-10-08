import React from 'react'
import { App, Upload, Button, Image } from 'antd'
import { UploadOutlined, DeleteOutlined, FileOutlined } from '@ant-design/icons'
import type { RcFile } from 'antd/es/upload'
import { uploadFile, UPLOAD_MAX_SIZE } from '../../api/media'

interface MediaPickerProps {
  value?: string
  onChange?: (url: string) => void
  accept?: string
}

const isImageUrl = (url: string) =>
  /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?.*)?$/i.test(url)

export default function MediaPicker({ value, onChange, accept }: MediaPickerProps) {
  const { message } = App.useApp()
  const handleBeforeUpload = async (file: RcFile) => {
    // 本地预检：超限文件不发请求（nginx 413 在慢上行下常表现为网络错误，拿不到提示）
    if (file.size > UPLOAD_MAX_SIZE) {
      message.error('文件大小不能超过 10MB')
      return false
    }
    try {
      const media = await uploadFile(file)
      // uploadFile returns ApiResponse<MediaFile> where the interceptor unwraps the outer
      // envelope leaving { message, data: MediaFile } — access .data.url
      const url = (media as any).data?.url ?? (media as any).url
      onChange?.(url)
      message.success('上传成功')
    } catch (e) {
      // 展示后端/拦截器给出的具体原因（如“不支持的文件类型”、413 中文提示）
      message.error(e instanceof Error && e.message ? e.message : '上传失败，请重试')
    }
    return false
  }

  const handleRemove = () => {
    onChange?.('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {value && (
        <div style={{ position: 'relative', display: 'inline-block' }}>
          {isImageUrl(value) ? (
            <Image
              src={value}
              width={120}
              height={80}
              style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #d9d9d9' }}
              preview={{ src: value }}
            />
          ) : (
            <div
              style={{
                width: 120,
                height: 80,
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                background: '#fafafa',
              }}
            >
              <FileOutlined style={{ fontSize: 24, color: '#8c8c8c' }} />
              <span style={{ fontSize: 11, color: '#8c8c8c', wordBreak: 'break-all', textAlign: 'center', padding: '0 4px' }}>
                {value.split('/').pop()}
              </span>
            </div>
          )}
          <Button
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            onClick={handleRemove}
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              background: 'rgba(255,255,255,0.85)',
              borderRadius: 4,
            }}
          />
        </div>
      )}
      <Upload
        accept={accept}
        showUploadList={false}
        beforeUpload={handleBeforeUpload}
      >
        <Button icon={<UploadOutlined />}>{value ? '重新上传' : '上传文件'}</Button>
      </Upload>
    </div>
  )
}
