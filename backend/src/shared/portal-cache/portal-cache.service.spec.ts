import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, IncomingHttpHeaders, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { PortalCacheService, PortalCacheTag } from './portal-cache.service';

const SECRET = 'a1'.repeat(32);
const PRIVATE_BODY = 'private-portal-response-body';
const TAGS: readonly PortalCacheTag[] = [
  'portal:contents', 'portal:movies', 'portal:novels', 'portal:comics',
];

interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('PortalCacheService (loopback HTTP)', () => {
  const servers = new Set<Server>();
  let warn: jest.SpyInstance;
  let logs: jest.SpyInstance[];

  async function fixture(respond: (response: ServerResponse) => void) {
    const requests: ReceivedRequest[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        respond(response);
      });
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, origin, requests };
  }

  async function close(server: Server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    servers.delete(server);
  }

  function service(origin?: string) {
    return new PortalCacheService(new ConfigService({
      app: { portalCache: origin ? { url: origin, secret: SECRET } : undefined },
    }));
  }

  function expectSanitizedWarning(category: string) {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`category=${category}`));
    const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PRIVATE_BODY);
    expect(logged).not.toContain('127.0.0.1');
    expect(logged).not.toContain('Bearer');
  }

  beforeEach(() => {
    logs = (['warn', 'error', 'log', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    warn = logs[0];
  });

  afterEach(async () => {
    try {
      await Promise.all([...servers].map(close));
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('POSTs the four fixed tags with the secret only in the authorization header', async () => {
    const portal = await fixture((response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"revalidated":true}');
    });

    await expect(service(portal.origin).invalidate(TAGS)).resolves.toBeUndefined();

    expect(portal.requests).toHaveLength(1);
    const request = portal.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/revalidate');
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({ tags: TAGS });
    expect(request.body).not.toContain(SECRET);
    expect(warn).not.toHaveBeenCalled();
  });

  it('coalesces duplicate tags within one notification', async () => {
    const portal = await fixture((response) => { response.writeHead(204); response.end(); });
    await service(portal.origin).invalidate(['portal:movies', 'portal:novels', 'portal:movies']);
    expect(portal.requests).toHaveLength(1);
    expect(JSON.parse(portal.requests[0].body)).toEqual({ tags: ['portal:movies', 'portal:novels'] });
  });

  it('does not fetch when notifications are disabled', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(service().invalidate(TAGS)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not fetch for an empty tag set', async () => {
    const portal = await fixture((response) => response.end());
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(service(portal.origin).invalidate([])).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(portal.requests).toHaveLength(0);
  });

  it.each([401, 503])('preserves the successful write when the portal returns %s', async (status) => {
    const portal = await fixture((response) => {
      response.writeHead(status);
      response.end(`${PRIVATE_BODY}:${SECRET}`);
    });
    await expect(service(portal.origin).invalidate(TAGS)).resolves.toBeUndefined();
    expect(portal.requests).toHaveLength(1);
    expectSanitizedWarning('http');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`status=${status}`));
  });

  it.each([302, 307])('rejects a %s redirect without contacting its destination', async (status) => {
    const destination = await fixture((response) => response.end('must not be requested'));
    const portal = await fixture((response) => {
      response.writeHead(status, { Location: `${destination.origin}/api/revalidate` });
      response.end(`${PRIVATE_BODY}:${SECRET}`);
    });
    await expect(service(portal.origin).invalidate(TAGS)).resolves.toBeUndefined();
    expect(portal.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);
    expectSanitizedWarning('network');
  });

  it('times out a real unresponsive portal without rejecting the successful write', async () => {
    const portal = await fixture(() => { /* Keep the response open until the client aborts. */ });
    await expect(service(portal.origin).invalidate(TAGS)).resolves.toBeUndefined();
    expect(portal.requests).toHaveLength(1);
    expectSanitizedWarning('timeout');
  });

  it('does not reject when the portal connection is refused', async () => {
    const portal = await fixture((response) => response.end());
    await close(portal.server);
    await expect(service(portal.origin).invalidate(TAGS)).resolves.toBeUndefined();
    expect(portal.requests).toHaveLength(0);
    expectSanitizedWarning('network');
  });

  it('never logs the original fetch exception or credentials', async () => {
    const exception = new Error(`${PRIVATE_BODY}: Bearer ${SECRET} http://127.0.0.1:12345/api/revalidate`);
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(exception);
    await expect(service('http://127.0.0.1:12345').invalidate(TAGS)).resolves.toBeUndefined();
    expectSanitizedWarning('network');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(warn.mock.calls[0][0]).not.toBe(exception);
  });
});
