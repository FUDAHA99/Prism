import { parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  it('空值 / 纯空白 / 只有逗号 → 空数组', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
    expect(parseCorsOrigins(' , ,')).toEqual([]);
  });

  it('去空白、去末尾斜杠/路径、主机名转小写、省略默认端口、去重', () => {
    const warns: string[] = [];
    expect(
      parseCorsOrigins(
        'https://a.com/, https://B.com:443/admin , https://a.com,http://localhost:3002',
        (m) => warns.push(m),
      ),
    ).toEqual(['https://a.com', 'https://b.com', 'http://localhost:3002']);
    expect(warns).toHaveLength(2);
  });

  it('丢弃缺协议或非 http(s) 的项并告警', () => {
    const warns: string[] = [];
    expect(
      parseCorsOrigins('a.com,localhost:3000,ftp://a.com,https://ok.com', (m) =>
        warns.push(m),
      ),
    ).toEqual(['https://ok.com']);
    expect(warns).toHaveLength(3);
  });

  it('协议与非默认端口不同视为不同 origin', () => {
    expect(parseCorsOrigins('http://a.com,https://a.com:8443')).toEqual([
      'http://a.com',
      'https://a.com:8443',
    ]);
  });
});
