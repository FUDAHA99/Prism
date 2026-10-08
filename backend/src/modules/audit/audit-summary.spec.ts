import { AUDIT_REDACTED } from './audit-sanitizer';
import { auditKeysOnly, auditUrlHost, changedAuditFields, pickAuditFields } from './audit-summary';

describe('changedAuditFields', () => {
  it('只列出值确实变了的字段，忽略 undefined', () => {
    const before = { title: 'a', slug: 's', body: 'long body', status: 'draft' };
    const patch = { title: 'b', slug: 's', body: undefined, status: 'draft' };
    expect(changedAuditFields(before, patch)).toEqual(['title']);
  });

  it('日期与 ISO 字符串、数字与数字字符串视为同值', () => {
    const before = { publishedAt: new Date('2026-01-01T00:00:00Z'), rating: '8.5', n: 3 };
    expect(
      changedAuditFields(before, { publishedAt: '2026-01-01T00:00:00.000Z', rating: 8.5, n: '3' }),
    ).toEqual([]);
    expect(changedAuditFields(before, { publishedAt: new Date('2026-02-01T00:00:00Z') })).toEqual([
      'publishedAt',
    ]);
  });

  it('对象 / 数组按 JSON 比较；null 与缺失视为同值', () => {
    const before = { extraHeaders: { A: '1' }, tags: ['x'], remark: null as string | null };
    expect(changedAuditFields(before, { extraHeaders: { A: '1' }, tags: ['x'], remark: null })).toEqual([]);
    expect(changedAuditFields(before, { extraHeaders: { A: '2' }, tags: ['x', 'y'] })).toEqual([
      'extraHeaders',
      'tags',
    ]);
    expect(changedAuditFields({}, { remark: null })).toEqual([]);
  });

  it('allowed 限定可记录的字段', () => {
    expect(
      changedAuditFields({ nickname: 'a' }, { nickname: 'b', passwordHash: '$2b$' }, ['nickname', 'email']),
    ).toEqual(['nickname']);
  });

  it('before / patch 为空时不抛错', () => {
    expect(changedAuditFields(null, { a: 1 })).toEqual(['a']);
    expect(changedAuditFields({ a: 1 }, null)).toEqual([]);
  });
});

describe('pickAuditFields', () => {
  it('只挑白名单里存在且非 undefined 的字段', () => {
    const src = { email: 'a@b.c', nickname: undefined, passwordHash: 'h' } as Record<string, unknown>;
    expect(pickAuditFields(src, ['email', 'nickname'])).toEqual({ email: 'a@b.c' });
    expect(pickAuditFields(null, ['email'])).toEqual({});
  });
});

describe('auditUrlHost', () => {
  it('只留 host（含端口），丢掉 userinfo、路径与 query 里的 key', () => {
    expect(auditUrlHost('https://user:pw@res.example.com:8443/api.php/provide/vod?ac=list&key=SECRET')).toBe(
      'res.example.com:8443',
    );
    expect(auditUrlHost('http://res.example.com/x?token=t')).toBe('res.example.com');
  });

  it('非法 URL 不回显原文', () => {
    expect(auditUrlHost('not a url with key=SECRET')).toBeNull();
    expect(auditUrlHost(undefined)).toBeNull();
    expect(auditUrlHost('')).toBeNull();
  });
});

describe('auditKeysOnly', () => {
  it('保留键名，值全部打码', () => {
    expect(auditKeysOnly({ Authorization: 'Bearer x', 'X-Key': 'k' })).toEqual({
      Authorization: AUDIT_REDACTED,
      'X-Key': AUDIT_REDACTED,
    });
  });

  it('非对象返回 null', () => {
    expect(auditKeysOnly(null)).toBeNull();
    expect(auditKeysOnly(undefined)).toBeNull();
    expect(auditKeysOnly(['a'] as unknown as Record<string, unknown>)).toBeNull();
  });
});
