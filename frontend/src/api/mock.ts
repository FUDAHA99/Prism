import type { User, Content, Category, MediaFile, Role, LoginResult } from '../types'

const mockUser: User = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'admin',
  email: 'admin@cms.com',
  nickname: '系统管理员',
  isActive: true,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  roles: ['admin'],
  permissions: [],
}

const mockContents: Content[] = [
  {
    id: '1', title: '欢迎使用 CMS 管理系统', slug: 'welcome',
    body: '# 欢迎\n\n这是一篇示例文章。', contentType: 'article',
    status: 'published', authorId: mockUser.id, isPublished: true,
    viewCount: 128, publishedAt: '2024-03-01T10:00:00Z',
    createdAt: '2024-03-01T09:00:00Z', updatedAt: '2024-03-01T10:00:00Z',
    author: mockUser,
  },
  {
    id: '2', title: '系统使用指南', slug: 'guide',
    body: '## 指南\n\n详细说明。', contentType: 'page',
    status: 'draft', authorId: mockUser.id, isPublished: false,
    viewCount: 0,
    createdAt: '2024-03-10T09:00:00Z', updatedAt: '2024-03-10T09:00:00Z',
    author: mockUser,
  },
  {
    id: '3', title: '系统维护公告', slug: 'maintenance-notice',
    body: '系统将于本周日进行维护。', contentType: 'announcement',
    status: 'published', authorId: mockUser.id, isPublished: true,
    viewCount: 56, publishedAt: '2024-03-15T08:00:00Z',
    createdAt: '2024-03-15T08:00:00Z', updatedAt: '2024-03-15T08:00:00Z',
    author: mockUser,
  },
]

const mockCategories: Category[] = [
  { id: '1', name: '技术', slug: 'tech', sortOrder: 1, createdAt: '', updatedAt: '', children: [] },
  { id: '2', name: '公告', slug: 'notice', sortOrder: 2, createdAt: '', updatedAt: '', children: [] },
]

const mockMedia: MediaFile[] = [
  {
    id: '1', filename: 'banner.jpg', originalName: 'banner.jpg',
    mimeType: 'image/jpeg', size: 204800,
    url: 'https://picsum.photos/800/400?random=1',
    isUsed: true, createdAt: '2024-03-01T00:00:00Z', updatedAt: '2024-03-01T00:00:00Z',
    uploader: mockUser,
  },
  {
    id: '2', filename: 'logo.png', originalName: 'logo.png',
    mimeType: 'image/png', size: 51200,
    url: 'https://picsum.photos/200/200?random=2',
    isUsed: false, createdAt: '2024-03-05T00:00:00Z', updatedAt: '2024-03-05T00:00:00Z',
    uploader: mockUser,
  },
]

const mockRoles: Role[] = [
  { id: '1', name: 'admin', description: '系统管理员', isSystem: true, createdAt: '', updatedAt: '' },
  { id: '2', name: 'editor', description: '内容编辑', isSystem: true, createdAt: '', updatedAt: '' },
  { id: '3', name: 'author', description: '内容作者', isSystem: true, createdAt: '', updatedAt: '' },
]

function delay<T>(data: T, ms = 300): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(data), ms))
}

export const mockApi = {
  login: (_email: string, _password: string): Promise<LoginResult> => {
    if (_email === 'admin@cms.com' && _password === 'admin123') {
      return delay({
        user: mockUser,
        tokens: { accessToken: 'mock-token', refreshToken: 'mock-refresh', expiresIn: 3600, tokenType: 'Bearer' },
      })
    }
    return Promise.reject(new Error('邮箱或密码错误'))
  },
  getProfile: () => delay(mockUser),
  getContents: () => delay({ message: '', data: mockContents, meta: { total: mockContents.length, page: 1, limit: 20, totalPages: 1 } }),
  getContent: (id: string) => delay({ message: '', data: mockContents.find(c => c.id === id) ?? mockContents[0] }),
  createContent: (data: Partial<Content>) => delay({ message: '', data: { ...mockContents[0], ...data, id: String(Date.now()) } }),
  updateContent: (_id: string, data: Partial<Content>) => delay({ message: '', data: { ...mockContents[0], ...data } }),
  deleteContent: () => delay(undefined),
  publishContent: (id: string) => delay({ message: '', data: { ...mockContents.find(c => c.id === id)!, status: 'published' as const, isPublished: true } }),
  unpublishContent: (id: string) => delay({ message: '', data: { ...mockContents.find(c => c.id === id)!, status: 'draft' as const, isPublished: false } }),
  getCategories: () => delay({ message: '', data: mockCategories }),
  getCategoryTree: () => delay({ message: '', data: mockCategories }),
  getCategory: (id: string) => delay({ message: '', data: mockCategories.find(c => c.id === id) ?? mockCategories[0] }),
  createCategory: (data: Partial<Category>) => delay({ message: '', data: { ...mockCategories[0], ...data, id: String(Date.now()) } }),
  updateCategory: (_id: string, data: Partial<Category>) => delay({ message: '', data: { ...mockCategories[0], ...data } }),
  deleteCategory: () => delay(undefined),
  getMediaFiles: () => delay({ message: '', data: mockMedia, meta: { total: mockMedia.length, page: 1, limit: 20, totalPages: 1 } }),
  getMediaFile: (id: string) => delay({ message: '', data: mockMedia.find(m => m.id === id) ?? mockMedia[0] }),
  uploadFile: () => delay({ message: '', data: mockMedia[0] }),
  deleteMediaFile: () => delay(undefined),
  getUsers: () => delay({ message: '', data: [mockUser], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } }),
  getUser: () => delay({ message: '', data: mockUser }),
  updateUser: (_id: string, data: Partial<User>) => delay({ message: '', data: { ...mockUser, ...data } }),
  deleteUser: () => delay(undefined),
  assignRoles: () => delay({ message: '', data: mockUser }),
  removeRoles: () => delay({ message: '', data: mockUser }),
  getRoles: () => delay({ message: '', data: mockRoles }),
}
