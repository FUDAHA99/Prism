import { describe, expect, it } from 'vitest'
import { buildUserEditPayload, type UserEditFormValues } from './user-edit'

/**
 * 1-F-3 复审 medium：编辑弹窗此前每次保存都原样回传昵称。存量账号的全角仿冒昵称（如 'ＳｉｔｅＡｄｍｉｎ'）
 * 经后端规范化后与管理员昵称相同，被当成「改了」查重得 409，停用、降权都做不了。
 * 现在昵称与邮箱一样，只在和载入值不同时才提交（后端另按规范化后的值判断是否真的改了）。
 */
describe('buildUserEditPayload（用户管理 → 编辑）', () => {
  const legacy = { nickname: 'ＳｉｔｅＡｄｍｉｎ', email: 'legacy@例子.cn' }
  const values = (extra: Partial<UserEditFormValues> = {}): UserEditFormValues => ({
    nickname: legacy.nickname,
    email: legacy.email,
    isActive: true,
    roleNames: ['editor'],
    ...extra,
  })

  it('只改启用状态：不带昵称、不带邮箱', () => {
    expect(buildUserEditPayload(legacy, values({ isActive: false }))).toEqual({ isActive: false })
  })

  it('只改角色（角色另走 assign / remove-roles）：请求体只剩启用状态', () => {
    expect(buildUserEditPayload(legacy, values({ roleNames: [] }))).toEqual({ isActive: true })
  })

  it('改了昵称：带上新昵称（原样，规范化与查重由后端做）', () => {
    expect(buildUserEditPayload(legacy, values({ nickname: ' 新昵称 ' }))).toEqual({ nickname: ' 新昵称 ', isActive: true })
  })

  it('清空昵称：提交空串（后端按清空处理）', () => {
    expect(buildUserEditPayload(legacy, values({ nickname: '' }))).toEqual({ nickname: '', isActive: true })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('载入时没有昵称（%s）、表单里仍是空的：不带昵称', (_label, nickname) => {
    const original = { nickname: nickname as string | null | undefined, email: 'a@cms.test' }
    expect(buildUserEditPayload(original, values({ nickname: '', email: 'a@cms.test' }))).toEqual({ isActive: true })
    expect(buildUserEditPayload(original, values({ nickname: undefined, email: 'a@cms.test' }))).toEqual({ isActive: true })
  })

  it('载入时没有昵称、填了新昵称：带上', () => {
    const original = { nickname: null, email: 'a@cms.test' }
    expect(buildUserEditPayload(original, values({ nickname: '小张', email: 'a@cms.test' }))).toEqual({
      nickname: '小张',
      isActive: true,
    })
  })

  it('改了邮箱：带上新邮箱；昵称没改照样不带', () => {
    expect(buildUserEditPayload(legacy, values({ email: 'new@cms.test' }))).toEqual({ email: 'new@cms.test', isActive: true })
  })
})
