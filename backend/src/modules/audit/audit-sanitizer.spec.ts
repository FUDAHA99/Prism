import {
  AUDIT_COLUMN_LIMITS,
  AUDIT_MAX_DEPTH,
  AUDIT_MAX_JSON_BYTES,
  AUDIT_MAX_STRING_LENGTH,
  AUDIT_REDACTED,
  createAuditSanitizeReport,
  isAuditUrlKey,
  isSensitiveAuditKey,
  sanitizeAuditRecord,
  sanitizeAuditUrl,
  sanitizeAuditValue,
  stripUrlsInAuditText,
  truncateAuditString,
} from './audit-sanitizer';
import { auditUrlHost } from './audit-summary';

/** 断言序列化结果里不出现任何一个秘密值 */
function expectNoSecrets(value: unknown, secrets: string[]): void {
  const text = JSON.stringify(value);
  for (const s of secrets) expect(text).not.toContain(s);
}

describe('audit-sanitizer 敏感键判定', () => {
  it.each([
    'password',
    'passwordHash',
    'newPassword',
    'pass',
    'hash',
    'refreshToken',
    'access_token',
    'token',
    'clientSecret',
    'secret',
    'cookie',
    'Set-Cookie',
    'authorization',
    'Authorization',
    'extraHeaders',
    'headers',
    'apiKey',
    'api_key',
    'api-key',
    'X-API-KEY',
    // 兜底扩展：口令缩写、凭据、私钥 / 访问密钥、会话、JWT、一次性验证码
    'pwd',
    'newPwd',
    'credential',
    'credentials',
    'awsCredentials',
    'privateKey',
    'private_key',
    'private-key',
    'accessKey',
    'access_key',
    'AccessKeyId',
    'session',
    'sessionId',
    'SESSION_ID',
    'jwt',
    'jwtPayload',
    'otp',
    'OTP',
    'otpCode',
    'otp_code',
    'x-otp',
    'userOtp',
    'userOtpCode',
    'smsOTP',
  ])('%s 是敏感键', (key) => {
    expect(isSensitiveAuditKey(key)).toBe(true);
  });

  it.each([
    'title',
    'slug',
    'email',
    'username',
    'apiUrl',
    'apiHost',
    'url',
    'userAgent',
    'changedFields',
    'name',
    // otp 只按独立的词匹配，这些普通键名不能被误伤
    'notPublished',
    'footprint',
    'hotpot',
    'isTopPick',
  ])('%s 不是敏感键', (key) => {
    expect(isSensitiveAuditKey(key)).toBe(false);
  });
});

describe('sanitizeAuditValue 打码', () => {
  it('管理员重置密码时的 passwordHash 与明文密码被打码，普通字段保留', () => {
    const hash = '$2b$12$abcdefghijklmnopqrstuuK0e7cFJ2zqvM1cH6nmpUCm1RA5b1Rhm';
    const out = sanitizeAuditValue({ nickname: '新昵称', passwordHash: hash, password: 'Plain123!' });
    expect(out).toEqual({ nickname: '新昵称', passwordHash: AUDIT_REDACTED, password: AUDIT_REDACTED });
    expectNoSecrets(out, [hash, 'Plain123!']);
  });

  it('采集源 extraHeaders：保留请求头名称，值全部打码；apiUrl 只留 host', () => {
    const out = sanitizeAuditValue({
      apiUrl: 'https://res.example.com/api.php/provide/vod',
      extraHeaders: { Authorization: 'Bearer sk-live-123', Cookie: 'sid=abc', 'X-Trace': 'ok' },
    });
    expect(out).toEqual({
      apiUrl: 'res.example.com',
      extraHeaders: { Authorization: AUDIT_REDACTED, Cookie: AUDIT_REDACTED, 'X-Trace': AUDIT_REDACTED },
    });
    expectNoSecrets(out, ['sk-live-123', 'sid=abc']);
  });

  it('递归：嵌套对象、数组里的对象都按键名打码', () => {
    const out = sanitizeAuditValue({
      a: { b: { c: [{ token: 't-1' }, { ok: 1, secret: { inner: 's-2' } }] } },
      list: [{ apiKey: 123456 }],
    });
    expect(out).toEqual({
      a: { b: { c: [{ token: AUDIT_REDACTED }, { ok: 1, secret: { inner: AUDIT_REDACTED } }] } },
      list: [{ apiKey: AUDIT_REDACTED }],
    });
    expectNoSecrets(out, ['t-1', 's-2', '123456']);
  });

  it('敏感键下的数组逐项打码，数字 / 大整数 / 日期 / 二进制也打码', () => {
    const out = sanitizeAuditValue({
      tokens: ['a1', 'b2'],
      pin_hash: 1234,
      tokenBig: BigInt(99),
      tokenDate: new Date('2026-01-01T00:00:00Z'),
      secretBuf: Buffer.from('raw-secret'),
    });
    expect(out).toEqual({
      tokens: [AUDIT_REDACTED, AUDIT_REDACTED],
      pin_hash: AUDIT_REDACTED,
      tokenBig: AUDIT_REDACTED,
      tokenDate: AUDIT_REDACTED,
      secretBuf: AUDIT_REDACTED,
    });
  });

  it('敏感键下的布尔与 null 保留：passwordChanged 这类事实要留在审计里', () => {
    expect(sanitizeAuditValue({ passwordChanged: true, apiKey: null, hasToken: false })).toEqual({
      passwordChanged: true,
      apiKey: null,
      hasToken: false,
    });
  });

  it('报告只记路径，不记值', () => {
    const report = createAuditSanitizeReport();
    sanitizeAuditValue(
      { passwordHash: 'h', extraHeaders: { Authorization: 'x' }, items: [{ token: 't' }] },
      report,
      'newValues',
    );
    expect(report.redacted).toEqual([
      'newValues.passwordHash',
      'newValues.extraHeaders.Authorization',
      'newValues.items.0.token',
    ]);
    expect(JSON.stringify(report)).not.toMatch(/"h"|"x"|"t"/);
  });
});

describe('sanitizeAuditValue 截断与异常输入', () => {
  it('超过 2000 字符的字符串截断，结果不超过上限并带原长度', () => {
    const body = '正'.repeat(5000);
    const out = sanitizeAuditValue({ body }) as { body: string };
    expect(out.body.length).toBeLessThanOrEqual(AUDIT_MAX_STRING_LENGTH);
    expect(out.body).toContain('[truncated 5000 chars]');
    expect(out.body.startsWith('正正正')).toBe(true);
  });

  it('恰好 2000 字符不截断', () => {
    const s = 'x'.repeat(AUDIT_MAX_STRING_LENGTH);
    expect(truncateAuditString(s)).toBe(s);
  });

  it('整体超过 16KB 时换成只含顶层键名的摘要', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i++) big[`field${i}`] = 'y'.repeat(1500);
    const report = createAuditSanitizeReport();
    const out = sanitizeAuditValue(big, report, 'newValues') as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out.originalBytes).toBeGreaterThan(AUDIT_MAX_JSON_BYTES);
    expect(out.keys).toEqual(Object.keys(big));
    expect(JSON.stringify(out)).not.toContain('yyyy');
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(AUDIT_MAX_JSON_BYTES);
    expect(report.oversized).toEqual(['newValues']);
  });

  it('超大数组摘要只留长度；键很多时摘要仍不超过上限', () => {
    const arr = Array.from({ length: 2000 }, (_, i) => `item-${i}-${'z'.repeat(20)}`);
    expect(sanitizeAuditValue(arr)).toEqual({
      _truncated: true,
      originalBytes: Buffer.byteLength(JSON.stringify(arr)),
      length: 2000,
    });

    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) manyKeys[`${'k'.repeat(200)}${i}`] = i;
    const out = sanitizeAuditValue(manyKeys) as { keys: string[]; omittedKeys: number };
    expect(out.keys).toHaveLength(50);
    expect(out.keys.every((k) => k.length <= 64)).toBe(true);
    expect(out.omittedKeys).toBe(2950);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(AUDIT_MAX_JSON_BYTES);
  });

  it('循环引用、超深嵌套、函数、Symbol、NaN 都不抛错', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < AUDIT_MAX_DEPTH + 5; i++) deep = { next: deep };

    const out = sanitizeAuditValue({
      cyclic,
      deep,
      fn: () => 1,
      sym: Symbol('s'),
      nan: NaN,
      arr: [undefined, () => 1],
    }) as Record<string, any>;
    expect(out.cyclic).toEqual({ name: 'a', self: '[Circular]' });
    expect(JSON.stringify(out.deep)).toContain('[MaxDepth]');
    expect(out).not.toHaveProperty('fn');
    expect(out).not.toHaveProperty('sym');
    expect(out.nan).toBeNull();
    expect(out.arr).toEqual([null, null]);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('同一对象被引用两次不算循环', () => {
    const shared = { v: 1 };
    expect(sanitizeAuditValue({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('BigInt、Date、Buffer 转成可序列化的值', () => {
    expect(
      sanitizeAuditValue({ n: BigInt(5), d: new Date('2026-01-02T03:04:05Z'), b: Buffer.from('abc'), bad: new Date('x') }),
    ).toEqual({ n: '5', d: '2026-01-02T03:04:05.000Z', b: '[binary 3 bytes]', bad: null });
  });

  it('__proto__ 键作为普通数据保留，不改原型', () => {
    const input = JSON.parse('{"__proto__": {"token": "p"}, "x": 1}');
    const out = sanitizeAuditValue(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"token":"[REDACTED]"},"x":1}');
  });

  it('undefined 原样返回（列保持 NULL），null 保留', () => {
    expect(sanitizeAuditValue(undefined)).toBeUndefined();
    expect(sanitizeAuditValue(null)).toBeNull();
  });
});

describe('幂等：重复清洗结果不变（存量清洗脚本可重复执行）', () => {
  const fixtures: Record<string, unknown> = {
    password: { passwordHash: '$2b$10$x', nickname: 'n' },
    headers: { extraHeaders: { Authorization: 'Bearer a' } },
    longString: { body: 'b'.repeat(70000) },
    oversized: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'q'.repeat(1999)])),
    numbersUnderSecret: { token: 42, nested: { apiKey: [1, 2, { x: 3 }] } },
    deep: (() => {
      let d: Record<string, unknown> = { token: 'deep-secret' };
      for (let i = 0; i < 20; i++) d = { n: d };
      return d;
    })(),
  };

  it.each(Object.keys(fixtures))('%s', (name) => {
    const once = sanitizeAuditValue(fixtures[name]);
    // 模拟落库再读出（simple-json）后第二次清洗
    const reloaded = JSON.parse(JSON.stringify(once));
    const report = createAuditSanitizeReport();
    const twice = sanitizeAuditValue(reloaded, report);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(report).toEqual({ redacted: [], truncated: [], oversized: [], urls: [] });
  });

  it('采集源记录（所有字符串里的 URL 只留 host）重复清洗结果不变', () => {
    const legacy = {
      name: '飞速 https://a:b@res.example.com/x?key=K1',
      apiUrl: 'https://acct:hunter2@api.example.com:8443/api.php/provide/vod/?ac=list&key=K2',
      remark: `备用 http://mirror.example.net/api?token=K3 ${'备'.repeat(3000)} 末尾 https://tail.example.org/?k=K4`,
      extraHeaders: { Authorization: 'Bearer K5' },
    };
    const options = { urlsInText: true };
    const once = sanitizeAuditValue(legacy, undefined, '', options);
    const report = createAuditSanitizeReport();
    const twice = sanitizeAuditValue(JSON.parse(JSON.stringify(once)), report, '', options);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(report).toEqual({ redacted: [], truncated: [], oversized: [], urls: [] });
    expectNoSecrets(once, ['K1', 'K2', 'K3', 'K4', 'K5', 'hunter2', 'acct', 'a:b@']);
  });
});

describe('URL 只留 host（与写入路径 auditUrlHost 同一规则）', () => {
  const SECRET_URL = 'https://acct:hunter2@api.example.com:8443/api.php/provide/vod/?ac=list&key=SECRETKEY123#frag';

  it('apiUrl / url 键名判定（不分大小写，只认这两个名字）', () => {
    for (const key of ['apiUrl', 'api_url', 'api-url', 'APIURL', 'url', 'URL', 'Url']) {
      expect(isAuditUrlKey(key)).toBe(true);
    }
    for (const key of ['apiHost', 'posterUrl', 'coverUrl', 'urls', 'curl', 'urlPattern']) {
      expect(isAuditUrlKey(key)).toBe(false);
    }
  });

  it.each([
    [SECRET_URL, 'api.example.com:8443'],
    ['http://res.example.com/x?token=t', 'res.example.com'],
    ['HTTPS://Res.Example.COM/a', 'res.example.com'],
    ['https://[2001:db8::1]:8080/a?k=1', '[2001:db8::1]:8080'],
    ['https://例子.测试/api?key=K', 'xn--fsqu00a.xn--0zwm56d'],
    ['//cdn.example.com/a.m3u8?sign=S', 'cdn.example.com'],
    ['res.example.com/api.php?key=K', 'res.example.com'],
    ['acct:hunter2@res.example.com/api.php', 'res.example.com'],
    ['/uploads/2026/a.jpg?sig=S#x', '/uploads/2026/a.jpg'],
    ['res.example.com', 'res.example.com'],
    ['res.example.com:8080', 'res.example.com:8080'],
    ['[::1]:3000', '[::1]:3000'],
    ['', ''],
    [AUDIT_REDACTED, AUDIT_REDACTED],
    ['not a url with key=SECRET', AUDIT_REDACTED],
    ['http://', AUDIT_REDACTED],
  ])('sanitizeAuditUrl(%j) → %j', (input, expected) => {
    expect(sanitizeAuditUrl(input)).toBe(expected);
    // 幂等
    expect(sanitizeAuditUrl(sanitizeAuditUrl(input))).toBe(expected);
  });

  it('绝对 URL 的结果与写入路径 auditUrlHost 完全一致', () => {
    for (const url of [SECRET_URL, 'http://res.example.com/x?token=t', 'https://[2001:db8::1]:8080/a?k=1']) {
      expect(sanitizeAuditUrl(url)).toBe(auditUrlHost(url));
    }
  });

  it('任何资源类型里 apiUrl / url 键都只留 host，数组与嵌套对象同样处理；报告只记路径', () => {
    const report = createAuditSanitizeReport();
    const out = sanitizeAuditValue(
      {
        apiUrl: SECRET_URL,
        episodes: [{ url: 'https://play.example.com/a.m3u8?token=TOKEN1' }],
        url: ['https://u:p@x.example.com/?k=K2', { main: 'https://y.example.com/?k=K3' }],
        posterUrl: 'https://img.example.com/p.jpg?x=1',
      },
      report,
      'newValues',
    );
    expect(out).toEqual({
      apiUrl: 'api.example.com:8443',
      episodes: [{ url: 'play.example.com' }],
      url: ['x.example.com', { main: 'y.example.com' }],
      // 普通资源类型里其他键不动：封面等公开地址要留在审计里
      posterUrl: 'https://img.example.com/p.jpg?x=1',
    });
    expect(report.urls).toEqual([
      'newValues.apiUrl',
      'newValues.episodes.0.url',
      'newValues.url.0',
      'newValues.url.1.main',
    ]);
    expectNoSecrets(report, ['hunter2', 'SECRETKEY123', 'TOKEN1', 'K2', 'K3']);
  });

  it('敏感键优先于 URL 规则：apiKey 下的 URL 整体打码', () => {
    expect(sanitizeAuditValue({ apiKey: { url: 'https://h.example.com/?k=1' } })).toEqual({
      apiKey: { url: AUDIT_REDACTED },
    });
  });

  it('stripUrlsInAuditText：文本里每个 URL 换成 host，其余文字原样', () => {
    expect(
      stripUrlsInAuditText('主线 https://a:b@one.example.com/x?key=K1，备线 mysql://root:pw@db:3306/cms 完'),
    ).toBe('主线 one.example.com，备线 db:3306 完');
    expect(stripUrlsInAuditText('没有地址')).toBe('没有地址');
  });

  it('sanitizeAuditRecord：collect_source 记录里所有字符串的 URL 只留 host，其他资源类型不受影响', () => {
    const values = {
      name: '源 https://res.example.com/?key=K1',
      remark: '见 http://u:p@doc.example.com/a?token=K2',
      apiHost: 'res.example.com',
      extraHeaders: { 'X-Api-Key': 'K3' },
      changedFields: ['apiUrl', 'remark'],
    };
    const report = createAuditSanitizeReport();
    const collect = sanitizeAuditRecord(
      { action: 'UPDATE', resourceType: 'collect_source', oldValues: values, newValues: values },
      report,
    );
    const expected = {
      name: '源 res.example.com',
      remark: '见 doc.example.com',
      apiHost: 'res.example.com',
      extraHeaders: { 'X-Api-Key': AUDIT_REDACTED },
      changedFields: ['apiUrl', 'remark'],
    };
    expect(collect.newValues).toEqual(expected);
    expect(collect.oldValues).toEqual(expected);
    expect(report.urls).toEqual(['oldValues.name', 'oldValues.remark', 'newValues.name', 'newValues.remark']);

    const content = sanitizeAuditRecord({ action: 'CONTENT_UPDATE', resourceType: 'content', newValues: values });
    expect((content.newValues as typeof values).remark).toBe(values.remark);
  });

  it('写入路径当前的采集源记录形状（apiHost + 请求头名）清洗后不变', () => {
    const current = { name: '飞速资源', apiHost: 'api.example.com:8443', extraHeaders: { Authorization: AUDIT_REDACTED } };
    const report = createAuditSanitizeReport();
    expect(
      sanitizeAuditRecord({ action: 'CREATE', resourceType: 'collect_source', newValues: current }, report).newValues,
    ).toEqual(current);
    expect(report).toEqual({ redacted: [], truncated: [], oversized: [], urls: [] });
  });
});

describe('sanitizeAuditRecord', () => {
  it('普通列按表结构长度裁剪，值列脱敏', () => {
    const rec = sanitizeAuditRecord({
      userId: 'u1',
      action: 'A'.repeat(300),
      resourceType: 'R'.repeat(300),
      resourceId: 'r1',
      ipAddress: '1'.repeat(100),
      userAgent: 'M'.repeat(20000),
      oldValues: { password: 'old' },
      newValues: { token: 'new', title: 't' },
    });
    expect(rec.action).toHaveLength(AUDIT_COLUMN_LIMITS.action);
    expect(rec.resourceType).toHaveLength(AUDIT_COLUMN_LIMITS.resourceType);
    expect(rec.ipAddress).toHaveLength(AUDIT_COLUMN_LIMITS.ipAddress);
    expect(rec.userAgent).toHaveLength(AUDIT_COLUMN_LIMITS.userAgent);
    expect(rec.oldValues).toEqual({ password: AUDIT_REDACTED });
    expect(rec.newValues).toEqual({ token: AUDIT_REDACTED, title: 't' });
    expect(rec.userId).toBe('u1');
    expect(rec.resourceId).toBe('r1');
  });

  it('缺省的可选列保持 undefined', () => {
    const rec = sanitizeAuditRecord({ action: 'USER_LOGIN', resourceType: 'user' });
    expect(rec).toEqual({
      userId: undefined,
      action: 'USER_LOGIN',
      resourceType: 'user',
      resourceId: undefined,
      ipAddress: undefined,
      userAgent: undefined,
      oldValues: undefined,
      newValues: undefined,
    });
  });
});
