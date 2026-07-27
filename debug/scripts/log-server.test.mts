import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EVENT_PAYLOAD_LIMIT,
  MAX_READ_LIMIT,
  REQUEST_BODY_LIMIT,
  STRING_VALUE_LIMIT,
  authorizeCollectorRequest,
  createLogServer,
  discoverPrivateIpv4Hosts,
  getCollectorStatus,
  isLoopbackAddress,
  manualProcessInspectionGuidance,
  parseCommandArguments,
  parseOptionArguments,
  readSessionConfig,
  startLogServer,
  validateAdvertiseHost,
  validateAndNormalizeEvent,
  type LogServer,
} from './log-server-impl.mts';

const servers: LogServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function start(options: Parameters<typeof createLogServer>[0] = {}): Promise<LogServer> {
  const root = await mkdtemp(join(tmpdir(), 'debug-test-'));
  temporaryDirectories.push(root);
  const server = await createLogServer({
    sessionDirectory: join(root, 'session'),
    ...options,
  });
  servers.push(server);
  return server;
}

function headers(server: LogServer): Record<string, string> {
  return { authorization: `Bearer ${server.config.adminToken}` };
}

function ingestHeaders(server: LogServer): Record<string, string> {
  return { authorization: `Bearer ${server.config.ingestToken}` };
}

function url(server: LogServer, path: string): string {
  return `${server.config.controlUrl}${path}`;
}

function event(server: LogServer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId: server.config.sessionId,
    kind: 'probe',
    label: 'test-probe',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function postEvent(server: LogServer, value = event(server)): Promise<Response> {
  return fetch(url(server, '/v1/events'), {
    method: 'POST',
    headers: { ...ingestHeaders(server), 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

async function runScript(path: string, args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [path, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

describe('binding and configuration', () => {
  it('binds to IPv4 loopback and resolves an ephemeral port', async () => {
    const server = await start({ port: 0 });
    strictEqual(server.config.bindAddress, '127.0.0.1');
    strictEqual(server.config.controlUrl, `http://127.0.0.1:${server.config.port}`);
    deepStrictEqual(server.config.ingestUrls, [server.config.controlUrl]);
    ok(server.config.port > 0);
    strictEqual((server.server.address() as { address: string }).address, '127.0.0.1');
  });

  it('binds all IPv4 interfaces only after explicit remote opt-in', async () => {
    const server = await start({
      allowRemote: true,
      advertiseHost: 'host.docker.internal',
    });
    strictEqual(server.config.bindAddress, '0.0.0.0');
    strictEqual((server.server.address() as { address: string }).address, '0.0.0.0');
    deepStrictEqual(server.config.ingestUrls, [
      `http://host.docker.internal:${server.config.port}`,
      server.config.controlUrl,
    ]);
  });

  it('discovers and sorts unique private IPv4 hosts', () => {
    deepStrictEqual(discoverPrivateIpv4Hosts({
      en0: [
        {
          address: '192.168.1.20',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.1.20/24',
        },
      ],
      bridge0: [
        {
          address: '172.20.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:01',
          internal: false,
          cidr: '172.20.0.1/16',
        },
        {
          address: '192.168.1.20',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:02',
          internal: false,
          cidr: '192.168.1.20/24',
        },
      ],
      lo0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    }), ['172.20.0.1', '192.168.1.20']);
  });

  it('writes complete restrictive configuration and session files', async () => {
    const server = await start();
    const config = await readSessionConfig(server.configFile);
    deepStrictEqual(config, server.config);
    strictEqual(config.eventsFile, join(config.sessionDirectory, 'events.jsonl'));
    strictEqual(config.processId, process.pid);
    deepStrictEqual((await readdir(config.sessionDirectory)).sort(), ['config.json', 'events.jsonl']);

    if (process.platform !== 'win32') {
      strictEqual((await stat(config.sessionDirectory)).mode & 0o777, 0o700);
      strictEqual((await stat(server.configFile)).mode & 0o777, 0o600);
      strictEqual((await stat(config.eventsFile)).mode & 0o777, 0o600);
    }
  });

  it('accepts an explicit default HTTP port in current config URLs', async () => {
    const server = await start();
    const configFile = join(server.config.sessionDirectory, 'port-80-config.json');
    await writeFile(configFile, JSON.stringify({
      ...server.config,
      port: 80,
      controlUrl: 'http://127.0.0.1:80',
      ingestUrls: ['http://127.0.0.1:80'],
    }), { mode: 0o600 });
    const config = await readSessionConfig(configFile);
    strictEqual(config.port, 80);
    strictEqual(config.controlUrl, 'http://127.0.0.1:80');
  });

  it('requires remote opt-in and a usable advertised host', async () => {
    await rejects(
      start({ advertiseHost: 'host.docker.internal' }),
      /requires --allow-remote/,
    );
    await rejects(
      start({
        allowRemote: true,
        networkInterfaceProvider: () => ({}),
      }),
      /no private IPv4 address/,
    );
    for (const host of ['0.0.0.0', '127.0.0.1', 'localhost']) {
      await rejects(
        start({ allowRemote: true, advertiseHost: host }),
        /reachable from the remote debug target/,
      );
    }
  });

  it('removes a newly created session directory after bind failure', async () => {
    const running = await start();
    const root = await mkdtemp(join(tmpdir(), 'debug-bind-failure-'));
    temporaryDirectories.push(root);
    const sessionDirectory = join(root, 'failed-session');

    await rejects(
      createLogServer({
        port: running.config.port,
        sessionDirectory,
      }),
      error => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE',
    );
    await rejects(stat(sessionDirectory), /ENOENT/);
  });
});

describe('collector diagnostics', () => {
  it('requires manual identity inspection without emitting a kill command', () => {
    const guidance = manualProcessInspectionGuidance(1234);
    ok(guidance.some(line => line.includes('1234')));
    ok(guidance.some(line => line === 'PID_IDENTITY: UNVERIFIED'));
    ok(guidance.every(line => !/\bkill\b/.test(line)));
  });

  it('reports a healthy authenticated collector and its recorded process', async () => {
    const server = await start();
    deepStrictEqual(await getCollectorStatus(server.config), {
      state: 'running',
      processId: process.pid,
      processAlive: true,
      eventCount: 0,
      rejectedEvents: 0,
      storageFailures: 0,
      capacityReached: false,
    });
  });

  it('reports an unreachable collector without treating its process as stopped', async () => {
    const server = await start();
    const config = server.config;
    await server.close();

    deepStrictEqual(await getCollectorStatus(config), {
      state: 'unreachable',
      processId: process.pid,
      processAlive: true,
    });
  });

  it('rejects a health response from a different collector session', async () => {
    const first = await start({ adminToken: 'shared-admin-token' });
    const second = await start({ adminToken: 'shared-admin-token' });
    await rejects(
      getCollectorStatus({
        ...second.config,
        controlUrl: first.config.controlUrl,
      }),
      /invalid health response/,
    );
  });

  it('reports an existing session directory as a recoverable startup error', async () => {
    const server = await start();
    await rejects(
      startLogServer(['--session-directory', server.config.sessionDirectory]),
      error => error instanceof Error
        && error.name === 'DebugServerStartupError'
        && error.message.includes(server.config.sessionId),
    );
  });
});

describe('authentication', () => {
  it('rejects missing and incorrect tokens and accepts a valid token', async () => {
    const server = await start();
    strictEqual((await fetch(url(server, '/health'))).status, 401);
    strictEqual((await fetch(url(server, '/health'), {
      headers: { authorization: 'Bearer incorrect' },
    })).status, 401);
    strictEqual((await fetch(url(server, '/health'), { headers: headers(server) })).status, 200);
  });

  it('keeps ingest and admin tokens distinct and scoped', async () => {
    const server = await start();
    ok(server.config.adminToken !== server.config.ingestToken);
    strictEqual((await postEvent(server)).status, 202);
    strictEqual((await fetch(url(server, '/v1/events'), {
      method: 'POST',
      headers: { ...headers(server), 'content-type': 'application/json' },
      body: JSON.stringify(event(server)),
    })).status, 401);
    strictEqual((await fetch(url(server, '/health'), {
      headers: ingestHeaders(server),
    })).status, 401);
  });

  it('classifies loopback peers and rejects remote administration', () => {
    const credentials = { adminToken: 'admin-token', ingestToken: 'ingest-token' };
    ok(isLoopbackAddress('127.0.0.1'));
    ok(isLoopbackAddress('::1'));
    ok(isLoopbackAddress('::ffff:127.0.0.1'));
    strictEqual(isLoopbackAddress('192.168.1.20'), false);
    strictEqual(authorizeCollectorRequest(
      'GET',
      '/health',
      '192.168.1.20',
      'Bearer admin-token',
      credentials,
    ), undefined);
    strictEqual(authorizeCollectorRequest(
      'POST',
      '/v1/events',
      '192.168.1.20',
      'Bearer ingest-token',
      credentials,
    ), 'ingest');
    strictEqual(authorizeCollectorRequest(
      'GET',
      '/v1/events',
      '192.168.1.20',
      'Bearer ingest-token',
      credentials,
    ), undefined);
  });

  it('requires authentication for every endpoint', async () => {
    const server = await start();
    const requests = [
      fetch(url(server, '/health')),
      fetch(url(server, '/v1/events')),
      fetch(url(server, '/v1/events'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      fetch(url(server, '/shutdown'), { method: 'POST' }),
      fetch(url(server, '/unknown')),
    ];
    for (const response of await Promise.all(requests)) {
      strictEqual(response.status, 401);
    }
  });
});

describe('request validation', () => {
  it('rejects incorrect content type, malformed JSON, arrays, and primitives', async () => {
    const server = await start();
    strictEqual((await fetch(url(server, '/v1/events'), {
      method: 'POST',
      headers: ingestHeaders(server),
      body: '{}',
    })).status, 415);
    strictEqual((await fetch(url(server, '/v1/events'), {
      method: 'POST',
      headers: { ...ingestHeaders(server), 'content-type': 'application/json' },
      body: '{',
    })).status, 400);
    strictEqual((await postEvent(server, [])).status, 400);
    strictEqual((await postEvent(server, 42)).status, 400);
  });

  it('rejects unsupported schemas, sessions, kinds, labels, and timestamps', async () => {
    const server = await start();
    const invalidEvents = [
      event(server, { schemaVersion: 2 }),
      event(server, { sessionId: 'another-session' }),
      event(server, { kind: 'metric' }),
      event(server, { label: 12 }),
      event(server, { timestamp: 'not-a-date' }),
    ];
    for (const value of invalidEvents) {
      strictEqual((await postEvent(server, value)).status, 400);
    }
  });

  it('rejects invalid location and hypothesis fields', async () => {
    const server = await start();
    const invalidEvents = [
      event(server, { location: 'src/file.ts' }),
      event(server, { location: { file: 'src/file.ts', line: 0 } }),
      event(server, { location: { file: 42 } }),
      event(server, { location: { file: 'src/file.ts', function: false } }),
      event(server, { hypothesisIds: 'H1' }),
      event(server, { hypothesisIds: ['H1', 2] }),
    ];
    for (const value of invalidEvents) {
      strictEqual((await postEvent(server, value)).status, 400);
    }
  });

  it('rejects requests over the body limit', async () => {
    const server = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const client = request(url(server, '/v1/events'), {
        method: 'POST',
        headers: {
          ...ingestHeaders(server),
          'content-type': 'application/json',
          'content-length': REQUEST_BODY_LIMIT + 1,
        },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      client.once('error', reject);
      client.end('x');
    });
    strictEqual(status, 413);
  });

  it('rejects normalized events over the event payload limit', async () => {
    const server = await start();
    const largeData = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`field${index}`, 'x'.repeat(STRING_VALUE_LIMIT)]),
    );
    const response = await postEvent(server, event(server, { data: largeData }));
    strictEqual(response.status, 413);
    match((await response.json() as { error: string }).error, new RegExp(String(EVENT_PAYLOAD_LIMIT)));
  });
});

describe('event behavior', () => {
  it('assigns increasing sequences, preserves order, and records receive timestamps', async () => {
    const server = await start();
    strictEqual((await postEvent(server, event(server, { label: 'first' }))).status, 202);
    strictEqual((await postEvent(server, event(server, { label: 'second' }))).status, 202);

    const response = await fetch(url(server, '/v1/events'), { headers: headers(server) });
    const body = await response.json() as {
      total: number;
      events: Array<{ sequence: number; label: string; receivedTimestamp: string }>;
    };
    strictEqual(body.total, 2);
    deepStrictEqual(body.events.map(item => item.sequence), [1, 2]);
    deepStrictEqual(body.events.map(item => item.label), ['first', 'second']);
    ok(body.events.every(item => !Number.isNaN(Date.parse(item.receivedTimestamp))));

    const persisted = (await readFile(server.config.eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
    deepStrictEqual(persisted.map(item => item.sequence), [1, 2]);
  });

  it('serializes concurrent event writes with unique monotonic sequences', async () => {
    const server = await start();
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        postEvent(server, event(server, { label: `event-${index}` }))),
    );
    ok(responses.every(response => response.status === 202));
    deepStrictEqual(
      server.events.map(item => item.sequence),
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    const persisted = (await readFile(server.config.eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
    deepStrictEqual(
      persisted.map(item => item.sequence),
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it('truncates individual data strings without changing control fields', async () => {
    const server = await start();
    const response = await postEvent(server, event(server, {
      data: { value: 'x'.repeat(STRING_VALUE_LIMIT + 100) },
    }));
    strictEqual(response.status, 202);
    const stored = server.events[0].data as { value: string };
    strictEqual(stored.value.length, STRING_VALUE_LIMIT);
  });

  it('reports event-count capacity explicitly', async () => {
    const server = await start({ maxEvents: 1 });
    strictEqual((await postEvent(server)).status, 202);
    const response = await postEvent(server);
    strictEqual(response.status, 507);
    match((await response.json() as { error: string }).error, /capacity/);
    const status = await getCollectorStatus(server.config);
    strictEqual(status.rejectedEvents, 1);
    strictEqual(status.capacityReached, true);
    const eventsResponse = await fetch(url(server, '/v1/events'), { headers: headers(server) });
    const eventsBody = await eventsResponse.json() as {
      rejectedEvents: number;
      capacityReached: boolean;
    };
    strictEqual(eventsBody.rejectedEvents, 1);
    strictEqual(eventsBody.capacityReached, true);

    const script = fileURLToPath(new URL('./read-session-events.mts', import.meta.url));
    const result = await runScript(script, ['--config', server.configFile]);
    strictEqual(result.code, 0);
    match(result.stdout, /RESULT: DEBUG_EVENT_CAPACITY_REACHED/);
    match(result.stdout, /REJECTED_EVENTS: 1/);
  });

  it('reports file capacity explicitly without accepting the event', async () => {
    const server = await start({ maxEventFileBytes: 1 });
    const response = await postEvent(server);
    strictEqual(response.status, 507);
    strictEqual(server.events.length, 0);
    strictEqual(await readFile(server.config.eventsFile, 'utf8'), '');
  });

  it('reports persistence failures as incomplete evidence', async () => {
    const server = await start();
    await rm(server.config.eventsFile);
    await mkdir(server.config.eventsFile);

    strictEqual((await postEvent(server)).status, 500);
    const status = await getCollectorStatus(server.config);
    strictEqual(status.eventCount, 0);
    strictEqual(status.storageFailures, 1);

    const response = await fetch(url(server, '/v1/events'), { headers: headers(server) });
    const body = await response.json() as { storageFailures: number };
    strictEqual(body.storageFailures, 1);
  });

  it('honors pagination and clamps excessive limits', async () => {
    const server = await start();
    for (const label of ['zero', 'one', 'two']) {
      strictEqual((await postEvent(server, event(server, { label }))).status, 202);
    }
    const response = await fetch(url(server, `/v1/events?offset=1&limit=${MAX_READ_LIMIT + 100}`), {
      headers: headers(server),
    });
    const body = await response.json() as { offset: number; limit: number; events: Array<{ label: string }> };
    strictEqual(body.offset, 1);
    strictEqual(body.limit, MAX_READ_LIMIT);
    deepStrictEqual(body.events.map(item => item.label), ['one', 'two']);
  });

  it('rejects invalid pagination', async () => {
    const server = await start();
    strictEqual((await fetch(url(server, '/v1/events?offset=-1'), { headers: headers(server) })).status, 400);
    strictEqual((await fetch(url(server, '/v1/events?limit=0'), { headers: headers(server) })).status, 400);
  });
});

describe('shutdown', () => {
  it('acknowledges authenticated shutdown and closes the server', async () => {
    const server = await start();
    const closed = new Promise<void>(resolve => server.server.once('close', resolve));
    const response = await fetch(url(server, '/shutdown'), {
      method: 'POST',
      headers: headers(server),
    });
    strictEqual(response.status, 200);
    deepStrictEqual(await response.json(), { stopped: true, sessionId: server.config.sessionId });
    await closed;
    await rejects(fetch(url(server, '/health'), { headers: headers(server) }));
    strictEqual(await server.close(), false);
  });

  it('rejects unauthenticated shutdown without closing', async () => {
    const server = await start();
    strictEqual((await fetch(url(server, '/shutdown'), { method: 'POST' })).status, 401);
    strictEqual((await fetch(url(server, '/health'), { headers: headers(server) })).status, 200);
  });

  it('returns non-zero when the CLI cannot verify graceful shutdown', async () => {
    const server = await start();
    const script = fileURLToPath(new URL('./stop-log-server.mts', import.meta.url));
    const first = await runScript(script, ['--config', server.configFile]);
    strictEqual(first.code, 0, first.stderr);
    match(first.stdout, /RESULT: DEBUG_SERVER_STOPPED/);

    const second = await runScript(script, ['--config', server.configFile]);
    strictEqual(second.code, 2, second.stderr);
    match(second.stdout, /RESULT: DEBUG_SERVER_ALREADY_STOPPED/);
  });

  it('rejects a shutdown acknowledgement for a different collector session', async () => {
    const collector = await start();
    const fakeServer = createHttpServer((request, response) => {
      const body = request.url === '/health'
        ? {
            status: 'ok',
            schemaVersion: 1,
            sessionId: collector.config.sessionId,
            eventCount: 0,
            rejectedEvents: 0,
            capacityReached: false,
          }
        : { stopped: true, sessionId: 'different-session' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve, reject) => {
      fakeServer.once('error', reject);
      fakeServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = fakeServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('fake server did not expose an IPv4 port');
      }
      const configFile = join(collector.config.sessionDirectory, 'mismatched-shutdown-config.json');
      await writeFile(configFile, JSON.stringify({
        ...collector.config,
        port: address.port,
        controlUrl: `http://127.0.0.1:${address.port}`,
        ingestUrls: [`http://127.0.0.1:${address.port}`],
      }), { mode: 0o600 });
      const script = fileURLToPath(new URL('./stop-log-server.mts', import.meta.url));
      const result = await runScript(script, ['--config', configFile]);
      strictEqual(result.code, 1);
      match(result.stderr, /invalid shutdown acknowledgement/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fakeServer.close(error => error ? reject(error) : resolve()));
    }
  });

  it('closes stalled probe connections during shutdown', async () => {
    const server = await start();
    const stalledClient = request(url(server, '/v1/events'), {
      method: 'POST',
      headers: {
        ...ingestHeaders(server),
        'content-type': 'application/json',
        'content-length': 100,
      },
    });
    stalledClient.on('error', () => {});
    stalledClient.write('{');
    const closed = new Promise<void>(resolve => server.server.once('close', resolve));

    const response = await fetch(url(server, '/shutdown'), {
      method: 'POST',
      headers: headers(server),
    });
    strictEqual(response.status, 200);
    await response.json();
    await closed;
    strictEqual(server.server.listening, false);
    stalledClient.destroy();
  });
});

describe('pure CLI helpers', () => {
  it('parses known options', () => {
    deepStrictEqual(
      parseOptionArguments(['--config', '/tmp/config.json', '--limit', '10'], new Set(['--config', '--limit'])),
      { '--config': '/tmp/config.json', '--limit': '10' },
    );
  });

  it('parses valued and boolean startup options', () => {
    const parsed = parseCommandArguments(
      ['--allow-remote', '--port', '0', '--advertise-host', 'host.docker.internal'],
      new Set(['--port', '--advertise-host']),
      new Set(['--allow-remote']),
    );
    deepStrictEqual(parsed.values, {
      '--port': '0',
      '--advertise-host': 'host.docker.internal',
    });
    deepStrictEqual([...parsed.flags], ['--allow-remote']);
  });

  it('validates advertised hosts without accepting URLs or ports', () => {
    strictEqual(validateAdvertiseHost('host.docker.internal'), 'host.docker.internal');
    strictEqual(validateAdvertiseHost('192.168.1.20'), '192.168.1.20');
    for (const host of ['http://192.168.1.20', 'host:3000', 'bad host', '-bad.example', 'localhost']) {
      strictEqual((() => {
        try {
          validateAdvertiseHost(host);
          return false;
        } catch {
          return true;
        }
      })(), true);
    }
  });

  it('rejects unknown, incomplete, and duplicate options', () => {
    for (const args of [
      ['--unknown', 'value'],
      ['--config'],
      ['--config', '--limit'],
      ['--config', 'a', '--config', 'b'],
    ]) {
      strictEqual(
        (() => {
          try {
            parseOptionArguments(args, new Set(['--config', '--limit']));
            return false;
          } catch {
            return true;
          }
        })(),
        true,
      );
    }
  });

  it('validates events directly', () => {
    const normalized = validateAndNormalizeEvent({
      schemaVersion: 1,
      sessionId: 'session',
      kind: 'branch',
      label: 'decision',
      timestamp: '2026-07-22T23:56:38.017Z',
      location: { file: 'src/file.ts', line: 10, function: 'run' },
      hypothesisIds: ['H1'],
      data: { taken: true },
    }, 'session');
    strictEqual(normalized.kind, 'branch');
    deepStrictEqual(normalized.hypothesisIds, ['H1']);
  });
});
