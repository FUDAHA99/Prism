import {
  canonicalHostname,
  classifyDomainName,
  classifyHostname,
  classifyIp,
  describeReservedAddress,
  parseIPv6,
} from './address-policy';

/**
 * 出站地址策略：只放行公网单播地址。重点是各种「看起来不像内网」的写法都要被识别出来。
 */
describe('classifyIp', () => {
  it.each([
    ['0.0.0.0', 'this-network'],
    ['0.1.2.3', 'this-network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.100.100.200', 'cgnat'], // 阿里云元数据
    ['100.127.255.255', 'cgnat'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'], // AWS/GCP/Azure 元数据
    ['169.254.0.1', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.17.0.2', 'private'], // docker0
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'ietf-protocol'],
    ['192.0.2.10', 'documentation'],
    ['192.88.99.1', '6to4-relay'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('IPv4 %s 被拦截（%s）', (ip, label) => {
    expect(classifyIp(ip)).toBe(label);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255', // 10/8 的前一个
    '11.0.0.0', // 10/8 的后一个
    '100.63.255.255', // CGNAT 前
    '100.128.0.0', // CGNAT 后
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255', // 172.16/12 前
    '172.32.0.0', // 172.16/12 后
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255', // 组播前
    '93.184.216.34',
  ])('公网 IPv4 %s 放行', (ip) => {
    expect(classifyIp(ip)).toBeNull();
  });

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'ipv4-mapped:loopback'],
    ['::ffff:7f00:1', 'ipv4-mapped:loopback'], // 同一地址的十六进制写法
    ['::ffff:169.254.169.254', 'ipv4-mapped:link-local'],
    ['::ffff:a9fe:a9fe', 'ipv4-mapped:link-local'],
    ['::ffff:10.0.0.1', 'ipv4-mapped:private'],
    ['::ffff:192.168.0.1', 'ipv4-mapped:private'],
    ['::127.0.0.1', 'ipv4-compatible'],
    ['::8.8.8.8', 'ipv4-compatible'], // 已废弃的 IPv4-compatible，一律不放行
    ['::ffff:0:127.0.0.1', 'ipv4-translated'],
    ['64:ff9b::127.0.0.1', 'nat64:loopback'],
    ['64:ff9b::a9fe:a9fe', 'nat64:link-local'],
    ['64:ff9b:1::1', 'nat64-local'],
    ['2002:7f00:1::', '6to4:loopback'],
    ['2002:a9fe:a9fe::1', '6to4:link-local'],
    ['100::1', 'discard'],
    ['2001::1', 'ietf-special'], // Teredo
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['5f00::1', 'srv6-sid'],
    ['fc00::1', 'unique-local'],
    ['fd00:ec2::254', 'unique-local'], // AWS IMDS IPv6
    ['fdff:ffff::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['4000::1', 'reserved'], // 2000::/3 之外未分配
    ['1::1', 'reserved'],
  ])('IPv6 %s 被拦截（%s）', (ip, label) => {
    expect(classifyIp(ip)).toBe(label);
  });

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2400:cb00::1',
    '::ffff:8.8.8.8', // 内嵌公网 IPv4 的 mapped 地址
    '64:ff9b::808:808', // NAT64 到 8.8.8.8
    '2002:808:808::1', // 6to4 到 8.8.8.8
  ])('公网 IPv6 %s 放行', (ip) => {
    expect(classifyIp(ip)).toBeNull();
  });

  it.each(['', 'localhost', '0x7f.1', '2130706433', '127.1', '1.2.3', '::ffff:999.0.0.1', 'not-an-ip'])(
    '不是规范 IP 的输入 %p 一律拦截（规范化是 classifyHostname 的事）',
    (input) => {
      expect(classifyIp(input)).toBe('invalid-ip');
    },
  );

  it('接受带方括号的 IPv6', () => {
    expect(classifyIp('[::1]')).toBe('loopback');
  });
});

describe('describeReservedAddress（给运维看的网段说明）', () => {
  it.each([
    ['198.18.0.68', '198.18.0.0/15 基准测试保留段'], // fake-IP 代理（Clash 等）的默认地址池
    ['198.20.0.68', null], // 198.18.0.0/15 之外
    ['10.1.2.3', '10.0.0.0/8 私有网段'],
    ['172.17.0.2', '172.16.0.0/12 私有网段'],
    ['127.0.0.1', '127.0.0.0/8 本机回环'],
    ['169.254.169.254', '169.254.0.0/16 链路本地（含云元数据地址）'],
    ['100.100.100.200', '100.64.0.0/10 运营商级 NAT 共享地址段'],
    ['::', '::/128 未指定地址'],
    ['::1', '::1/128 本机回环'],
    ['fc00::43', 'fc00::/7 唯一本地地址（ULA）'],
    ['::ffff:10.0.0.5', 'IPv4 映射地址 ::ffff:0:0/96 内嵌 10.0.0.0/8 私有网段'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 64:ff9b::/96 内嵌 169.254.0.0/16 链路本地（含云元数据地址）'],
    ['2002:7f00:1::', '6to4 2002::/16 内嵌 127.0.0.0/8 本机回环'],
    ['4000::1', '2000::/3 以外的未分配段'],
    ['[fe80::1]', 'fe80::/10 链路本地（含云元数据地址）'],
    ['8.8.8.8', null],
    ['2606:4700:4700::1111', null],
  ])('%s → %p', (ip, expected) => {
    expect(describeReservedAddress(ip)).toBe(expected);
  });

  it('与 classifyIp 同一套判定：拦截的地址都有网段说明，放行的都没有；说明里不含原始 IP', () => {
    const samples = [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.0.0.1', '192.0.2.1',
      '192.88.99.1', '192.168.1.1', '198.18.5.6', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1',
      '1.1.1.1', '93.184.216.34', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::8.8.8.8', '::ffff:0:127.0.0.1',
      '64:ff9b::127.0.0.1', '64:ff9b::808:808', '64:ff9b:1::1', '2002:a9fe:a9fe::1', '2002:808:808::1', '100::1',
      '2001::1', '2001:db8::1', '3fff::1', '5f00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '4000::1',
      '2400:cb00::1',
    ];
    for (const ip of samples) {
      const blocked = classifyIp(ip) !== null;
      const range = describeReservedAddress(ip);
      expect({ ip, hasRange: range !== null }).toEqual({ ip, hasRange: blocked });
      // 网段起始地址本身（0.0.0.0、::、::1）除外：说明里出现的是网段，不是被解析到的那个地址
      if (range && !range.startsWith(`${ip}/`)) expect(range).not.toContain(ip);
    }
  });
});

describe('parseIPv6', () => {
  it.each([
    ['::', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['::1', [0, 0, 0, 0, 0, 0, 0, 1]],
    ['1::', [1, 0, 0, 0, 0, 0, 0, 0]],
    ['1:2:3:4:5:6:7:8', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['1:2:3:4:5:6:7::', [1, 2, 3, 4, 5, 6, 7, 0]],
    ['::2:3:4:5:6:7:8', [0, 2, 3, 4, 5, 6, 7, 8]],
    ['::ffff:127.0.0.1', [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]],
    ['::127.0.0.1', [0, 0, 0, 0, 0, 0, 0x7f00, 1]],
    ['1:2:3:4:5:6:1.2.3.4', [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]],
  ])('%s', (ip, groups) => {
    expect(parseIPv6(ip)).toEqual(groups);
  });

  it('非法输入返回 null', () => {
    expect(parseIPv6('1:2:3')).toBeNull();
    expect(parseIPv6('127.0.0.1')).toBeNull();
    expect(parseIPv6('::g')).toBeNull();
  });
});

describe('classifyHostname（按 WHATWG URL 规范化后再判定）', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['0x7f.1', 'loopback'], // 十六进制 + 简写
    ['0x7f000001', 'loopback'],
    ['2130706433', 'loopback'], // 整数写法
    ['017700000001', 'loopback'], // 八进制
    ['0177.0.0.1', 'loopback'],
    ['127.1', 'loopback'],
    ['127.0.0.1.', 'loopback'], // 末尾点
    ['%31%32%37.0.0.1', 'loopback'], // 百分号编码
    ['0', 'this-network'],
    ['0.0.0.0', 'this-network'],
    ['169.254.169.254', 'link-local'],
    ['0xa9fea9fe', 'link-local'], // 169.254.169.254 的整数十六进制
    ['2852039166', 'link-local'], // 169.254.169.254 的十进制整数
    ['[::1]', 'loopback'],
    ['::1', 'loopback'],
    ['[::ffff:127.0.0.1]', 'ipv4-mapped:loopback'],
    ['::ffff:127.0.0.1', 'ipv4-mapped:loopback'],
    ['[::ffff:169.254.169.254]', 'ipv4-mapped:link-local'],
    ['[0:0:0:0:0:ffff:7f00:1]', 'ipv4-mapped:loopback'],
    ['[fd00:ec2::254]', 'unique-local'],
    ['10.1.2.3', 'private'],
    ['0x0a.0x01.0x02.0x03', 'private'],
  ])('%s → %s', (host, label) => {
    expect(classifyHostname(host)).toBe(label);
  });

  it.each([
    ['localhost', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['localhost.', 'localhost'],
    ['api.localhost', 'reserved-name:localhost'],
    ['foo.bar.localhost', 'reserved-name:localhost'],
    ['mysql', 'single-label'], // Docker 服务名
    ['redis', 'single-label'],
    ['backend', 'single-label'],
    ['metadata', 'single-label'],
    ['metadata.google.internal', 'reserved-name:internal'],
    ['printer.local', 'reserved-name:local'],
    ['router.home.arpa', 'reserved-name:home.arpa'],
    ['nas.lan', 'reserved-name:lan'],
    ['host.localdomain', 'reserved-name:localdomain'],
    ['foo.test', 'reserved-name:test'],
  ])('保留/内部域名 %s → %s', (host, label) => {
    expect(classifyHostname(host)).toBe(label);
  });

  it.each(['example.com', 'api.resource-site.com', 'www.example.co.uk', 'xn--fiqs8s.com', '中国.com', 'a_b.example.com'])(
    '公网域名 %s 交给建连时的 DNS 检查（这里放行）',
    (host) => {
      expect(classifyHostname(host)).toBeNull();
    },
  );

  it.each(['', '   ', 'a b.com', 'example.com:80', 'user@example.com', 'example.com/path', '[::1', 'fe80::1%eth0'])(
    '无法当作主机名的输入 %p 一律拦截',
    (host) => {
      expect(classifyHostname(host)).toBe('invalid-host');
    },
  );
});

describe('canonicalHostname', () => {
  it('与 Node 发请求时看到的主机名一致', () => {
    expect(canonicalHostname('0x7f.1')).toBe('127.0.0.1');
    expect(canonicalHostname('2130706433')).toBe('127.0.0.1');
    expect(canonicalHostname('EXAMPLE.com')).toBe('example.com');
    expect(canonicalHostname('[::ffff:127.0.0.1]')).toBe('::ffff:7f00:1');
    expect(canonicalHostname('中国.com')).toBe('xn--fiqs8s.com');
  });
});

describe('classifyDomainName', () => {
  it('只看名字，不做 DNS', () => {
    expect(classifyDomainName('example.com')).toBeNull();
    expect(classifyDomainName('example.com.')).toBeNull();
    expect(classifyDomainName('localhost')).toBe('localhost');
    expect(classifyDomainName('a.internal')).toBe('reserved-name:internal');
    expect(classifyDomainName('internalexample.com')).toBeNull(); // 只匹配完整标签
  });
});
