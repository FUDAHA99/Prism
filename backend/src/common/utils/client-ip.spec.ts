import * as express from 'express';
import * as request from 'supertest';
import { clientIp } from './client-ip';

describe('clientIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:10.0.0.1', '10.0.0.1'],
    ['::1', '127.0.0.1'],
    ['2001:db8::1', '2001:db8::1'],
  ])('req.ip=%s → %s', (ip, expected) => {
    expect(clientIp({ ip })).toBe(expected);
  });

  it('没有 req.ip 时返回 unknown', () => {
    expect(clientIp({})).toBe('unknown');
    expect(clientIp(undefined)).toBe('unknown');
  });

  it('只读 req.ip，不看任何请求头', () => {
    const req = { ip: '198.51.100.1', headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7' } };
    expect(clientIp(req)).toBe('198.51.100.1');
  });

  describe('配合 trust proxy = 1（与 main.ts 相同）', () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ ip: clientIp(req) }));

    it('取 X-Forwarded-For 最右一跳（nginx 追加的 $remote_addr）', async () => {
      const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7');
      expect(res.body.ip).toBe('203.0.113.7');
    });

    it('客户端自己塞的最左值无效：伪造 IP 不能冒充或换桶', async () => {
      const res = await request(app).get('/ip').set('X-Forwarded-For', '6.6.6.6, 1.1.1.1, 203.0.113.7');
      expect(res.body.ip).toBe('203.0.113.7');
    });

    it('没有代理头时是直连对端地址', async () => {
      const res = await request(app).get('/ip');
      expect(res.body.ip).toBe('127.0.0.1');
    });
  });
});
