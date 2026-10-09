import { isNicknameChange } from './display-name';

describe('isNicknameChange（昵称是否真的改了）', () => {
  it.each<[string, string | null | undefined, string | null, boolean]>([
    ['原样回传规范昵称', '张三', '张三', false],
    ['原样回传存量全角昵称（规范化后相同）', 'ａｄｍｉｎ', 'admin', false],
    ['改成别的昵称', '张三', '李四', true],
    ['清空普通昵称', '张三', null, true],
    ['本来就没有昵称，再清空', null, null, false],
    ['存量空串，再清空', '', null, false],
    ['存量纯空白，再清空', '   ', null, false],
    // 门户评论按 trim 后的原值显示，这类昵称显示为空白的作者名；不当作变更就永远清不掉（1-F-3 复审 low）
    ['存量只含不可见字符，清空', '​', null, true],
    ['存量只含韩文填充符，清空', 'ㅤ', null, true],
    ['从无到有', null, '王五', true],
  ])('%s', (_label, stored, submitted, expected) => {
    expect(isNicknameChange(stored, submitted)).toBe(expected);
  });
});
