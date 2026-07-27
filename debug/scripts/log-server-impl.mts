import { timingSafeEqual, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces, tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { join, resolve } from 'node:path';

export const EVENT_SCHEMA_VERSION = 1;
export const CONFIG_VERSION = 1;
export const LIFECYCLE_REQUEST_TIMEOUT_MS = 5_000;
export const REQUEST_BODY_LIMIT = 64 * 1024;
export const EVENT_PAYLOAD_LIMIT = 16 * 1024;
export const STRING_VALUE_LIMIT = 4 * 1024;
export const DEFAULT_MAX_EVENTS = 10_000;
export const DEFAULT_MAX_EVENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_READ_LIMIT = 500;
export const EVENT_KINDS = ['probe', 'branch', 'error', 'lifecycle', 'note'] as const;

type EventKind = (typeof EVENT_KINDS)[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SessionConfig {
  configVersion: 1;
  eventSchemaVersion: 1;
  sessionId: string;
  adminToken: string;
  ingestToken: string;
  bindAddress: '127.0.0.1' | '0.0.0.0';
  controlUrl: string;
  ingestUrls: string[];
  port: number;
  processId: number;
  sessionDirectory: string;
  eventsFile: string;
}

export interface DebugEvent {
  schemaVersion: 1;
  sessionId: string;
  kind: EventKind;
  label: string;
  timestamp: string;
  location?: {
    file: string;
    line?: number;
    function?: string;
  };
  hypothesisIds?: string[];
  data?: JsonValue;
}

export interface StoredDebugEvent extends DebugEvent {
  sequence: number;
  receivedTimestamp: string;
}

export interface CreateLogServerOptions {
  port?: number;
  allowRemote?: boolean;
  advertiseHost?: string;
  networkInterfaceProvider?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  sessionDirectory?: string;
  sessionId?: string;
  adminToken?: string;
  ingestToken?: string;
  maxEvents?: number;
  maxEventFileBytes?: number;
}

export interface LogServer {
  readonly config: SessionConfig;
  readonly configFile: string;
  readonly events: readonly StoredDebugEvent[];
  readonly server: Server;
  close(): Promise<boolean>;
}

export interface CollectorStatus {
  state: 'running' | 'unreachable';
  processId: number;
  processAlive: boolean;
  eventCount?: number;
  rejectedEvents?: number;
  storageFailures?: number;
  capacityReached?: boolean;
}

export interface ParsedCommandArguments {
  readonly values: Readonly<Record<string, string>>;
  readonly flags: ReadonlySet<string>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class DebugServerStartupError extends Error {
  readonly priorConfig: SessionConfig | undefined;

  constructor(
    message: string,
    priorConfig?: SessionConfig,
  ) {
    super(message);
    this.name = 'DebugServerStartupError';
    this.priorConfig = priorConfig;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > STRING_VALUE_LIMIT) {
    throw new HttpError(400, `${field} must be a non-empty string no longer than ${STRING_VALUE_LIMIT} characters`);
  }
  return value;
}

function normalizeJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 20) {
    throw new HttpError(400, 'data nesting exceeds 20 levels');
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HttpError(400, 'data numbers must be finite');
    }
    return value;
  }
  if (typeof value === 'string') {
    return value.slice(0, STRING_VALUE_LIMIT);
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key.slice(0, STRING_VALUE_LIMIT),
      normalizeJsonValue(item, depth + 1),
    ]));
  }
  throw new HttpError(400, 'data must contain only JSON values');
}

export function validateAndNormalizeEvent(value: unknown, expectedSessionId: string): DebugEvent {
  if (!isRecord(value)) {
    throw new HttpError(400, 'event must be a JSON object');
  }
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new HttpError(400, `unsupported schemaVersion; expected ${EVENT_SCHEMA_VERSION}`);
  }
  if (value.sessionId !== expectedSessionId) {
    throw new HttpError(400, 'sessionId does not match this collector session');
  }
  if (typeof value.kind !== 'string' || !EVENT_KINDS.includes(value.kind as EventKind)) {
    throw new HttpError(400, `kind must be one of: ${EVENT_KINDS.join(', ')}`);
  }

  const timestamp = assertString(value.timestamp, 'timestamp')!;
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new HttpError(400, 'timestamp must be an ISO-compatible date string');
  }

  let location: DebugEvent['location'];
  if (value.location !== undefined) {
    if (!isRecord(value.location)) {
      throw new HttpError(400, 'location must be an object');
    }
    const file = assertString(value.location.file, 'location.file')!;
    const line = value.location.line;
    if (line !== undefined && (!Number.isSafeInteger(line) || (line as number) < 1)) {
      throw new HttpError(400, 'location.line must be a positive integer');
    }
    location = {
      file,
      ...(line === undefined ? {} : { line: line as number }),
      ...(value.location.function === undefined ? {} : {
        function: assertString(value.location.function, 'location.function')!,
      }),
    };
  }

  let hypothesisIds: string[] | undefined;
  if (value.hypothesisIds !== undefined) {
    if (!Array.isArray(value.hypothesisIds) || value.hypothesisIds.length > 50) {
      throw new HttpError(400, 'hypothesisIds must be an array with at most 50 entries');
    }
    hypothesisIds = value.hypothesisIds.map((item, index) =>
      assertString(item, `hypothesisIds[${index}]`)!);
  }

  const event: DebugEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    sessionId: expectedSessionId,
    kind: value.kind as EventKind,
    label: assertString(value.label, 'label')!,
    timestamp,
    ...(location ? { location } : {}),
    ...(hypothesisIds ? { hypothesisIds } : {}),
    ...(value.data === undefined ? {} : { data: normalizeJsonValue(value.data) }),
  };
  if (Buffer.byteLength(JSON.stringify(event)) > EVENT_PAYLOAD_LIMIT) {
    throw new HttpError(413, `normalized event exceeds ${EVENT_PAYLOAD_LIMIT} bytes`);
  }
  return event;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  response.end(json);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === '::1') {
    return true;
  }
  const ipv4 = address?.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (!ipv4 || isIP(ipv4) !== 4) {
    return false;
  }
  return Number(ipv4.split('.')[0]) === 127;
}

export function authorizeCollectorRequest(
  method: string | undefined,
  pathname: string,
  remoteAddress: string | undefined,
  authorizationHeader: string | undefined,
  config: Pick<SessionConfig, 'adminToken' | 'ingestToken'>,
): 'admin' | 'ingest' | undefined {
  if (method === 'POST' && pathname === '/v1/events') {
    return tokenMatches(authorizationHeader, config.ingestToken) ? 'ingest' : undefined;
  }
  if (isLoopbackAddress(remoteAddress) && tokenMatches(authorizationHeader, config.adminToken)) {
    return 'admin';
  }
  return undefined;
}

export function validateAdvertiseHost(value: string): string {
  if (value.length === 0 || value.length > 253 || value !== value.trim() || /[\s/:?#@\[\]\\]/.test(value)) {
    throw new Error('--advertise-host must be a hostname or IPv4 address without a scheme, port, or path');
  }
  if (isIP(value) === 4) {
    if (value === '0.0.0.0' || isLoopbackAddress(value)) {
      throw new Error('--advertise-host must be reachable from the remote debug target');
    }
    return value;
  }
  if (isIP(value) !== 0 || !value.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('--advertise-host must be a valid hostname or IPv4 address');
  }
  if (value.toLowerCase() === 'localhost') {
    throw new Error('--advertise-host must be reachable from the remote debug target');
  }
  return value;
}

export function isPrivateIpv4Address(value: string): boolean {
  if (isIP(value) !== 4) {
    return false;
  }
  const [first, second] = value.split('.').map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function discoverPrivateIpv4Hosts(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  return [...new Set(Object.values(interfaces)
    .flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4Address(entry.address))
    .map(entry => entry.address))]
    .sort();
}

function collectorUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function isValidIngestUrl(value: unknown, port: number): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    const effectivePort = url.port === '' ? 80 : Number(url.port);
    return url.protocol === 'http:'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && effectivePort === port;
  } catch {
    return false;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BODY_LIMIT) {
    throw new HttpError(413, `request body exceeds ${REQUEST_BODY_LIMIT} bytes`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > REQUEST_BODY_LIMIT) {
      throw new HttpError(413, `request body exceeds ${REQUEST_BODY_LIMIT} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parsePagination(url: URL): { offset: number; limit: number } {
  const parse = (name: string, fallback: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null) {
      return fallback;
    }
    if (!/^\d+$/.test(raw)) {
      throw new HttpError(400, `${name} must be a non-negative integer`);
    }
    return Number(raw);
  };
  const offset = parse('offset', 0);
  const requestedLimit = parse('limit', 100);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new HttpError(400, 'offset and limit are outside the supported range');
  }
  return { offset, limit: Math.min(requestedLimit, MAX_READ_LIMIT) };
}

export async function createLogServer(options: CreateLogServerOptions = {}): Promise<LogServer> {
  const sessionId = options.sessionId ?? randomBytes(16).toString('hex');
  const adminToken = options.adminToken ?? randomBytes(32).toString('base64url');
  const ingestToken = options.ingestToken ?? randomBytes(32).toString('base64url');
  if (adminToken === ingestToken) {
    throw new Error('admin and ingest tokens must be distinct');
  }
  const bindAddress = options.allowRemote ? '0.0.0.0' : '127.0.0.1';
  if (options.advertiseHost && !options.allowRemote) {
    throw new Error('--advertise-host requires --allow-remote');
  }
  const advertisedHosts = options.allowRemote
    ? (options.advertiseHost
        ? [validateAdvertiseHost(options.advertiseHost)]
        : discoverPrivateIpv4Hosts(options.networkInterfaceProvider?.()))
    : ['127.0.0.1'];
  if (advertisedHosts.length === 0) {
    throw new Error(
      'no private IPv4 address was found; pass --advertise-host with a target-reachable host or address',
    );
  }
  const sessionDirectory = resolve(options.sessionDirectory ?? join(tmpdir(), `debug-${sessionId}`));
  const eventsFile = join(sessionDirectory, 'events.jsonl');
  const configFile = join(sessionDirectory, 'config.json');
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxEventFileBytes = options.maxEventFileBytes ?? DEFAULT_MAX_EVENT_FILE_BYTES;
  const events: StoredDebugEvent[] = [];
  let eventFileBytes = 0;
  let rejectedEvents = 0;
  let storageFailures = 0;
  let writeQueue = Promise.resolve();
  let closing = false;
  let closed = false;

  await mkdir(sessionDirectory, { recursive: false, mode: 0o700 });
  await writeFile(eventsFile, '', { mode: 0o600, flag: 'wx' });

  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!authorizeCollectorRequest(
        request.method,
        url.pathname,
        request.socket.remoteAddress,
        request.headers.authorization,
        { adminToken, ingestToken },
      )) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      if (closing) {
        sendJson(response, 503, { error: 'collector is shutting down' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          status: 'ok',
          schemaVersion: EVENT_SCHEMA_VERSION,
          sessionId,
          eventCount: events.length,
          rejectedEvents,
          storageFailures,
          capacityReached: rejectedEvents > 0,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        const { offset, limit } = parsePagination(url);
        sendJson(response, 200, {
          total: events.length,
          offset,
          limit,
          rejectedEvents,
          storageFailures,
          capacityReached: rejectedEvents > 0,
          events: events.slice(offset, offset + limit),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/events') {
        if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new HttpError(415, 'content-type must be application/json');
        }
        const body = await readRequestBody(request);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'request body is not valid JSON');
        }
        const event = validateAndNormalizeEvent(parsed, sessionId);
        if (closing) {
          throw new HttpError(503, 'collector is shutting down');
        }
        const storeOperation = writeQueue.then(async () => {
          if (events.length >= maxEvents) {
            rejectedEvents += 1;
            throw new HttpError(507, 'event capacity reached');
          }
          const storedEvent: StoredDebugEvent = {
            ...event,
            sequence: events.length + 1,
            receivedTimestamp: new Date().toISOString(),
          };
          const line = JSON.stringify(storedEvent) + '\n';
          const lineBytes = Buffer.byteLength(line);
          if (eventFileBytes + lineBytes > maxEventFileBytes) {
            rejectedEvents += 1;
            throw new HttpError(507, 'event file capacity reached');
          }
          try {
            await appendFile(eventsFile, line, { encoding: 'utf8', mode: 0o600 });
          } catch {
            storageFailures += 1;
            throw new HttpError(500, 'event persistence failed');
          }
          eventFileBytes += lineBytes;
          events.push(storedEvent);
          return storedEvent;
        });
        writeQueue = storeOperation.then(() => undefined, () => undefined);
        const storedEvent = await storeOperation;
        sendJson(response, 202, { accepted: true, sequence: storedEvent.sequence });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        closing = true;
        await writeQueue;
        sendJson(response, 200, { stopped: true, sessionId });
        response.once('finish', () => {
          server.close();
          server.closeAllConnections();
        });
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, {
          ...(error.status === 507 ? { result: 'DEBUG_EVENT_CAPACITY_REACHED' } : {}),
          error: error.message,
        });
        return;
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on('close', () => {
    closed = true;
    resolveClosed();
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, bindAddress, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== bindAddress) {
      throw new Error(`collector did not bind to ${bindAddress}`);
    }
    const config: SessionConfig = {
      configVersion: CONFIG_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      sessionId,
      adminToken,
      ingestToken,
      bindAddress,
      controlUrl: collectorUrl('127.0.0.1', address.port),
      ingestUrls: [
        ...advertisedHosts
          .filter(host => host !== '127.0.0.1')
          .map(host => collectorUrl(host, address.port)),
        collectorUrl('127.0.0.1', address.port),
      ],
      port: address.port,
      processId: process.pid,
      sessionDirectory,
      eventsFile,
    };
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await Promise.all([
      chmod(sessionDirectory, 0o700),
      chmod(configFile, 0o600),
      chmod(eventsFile, 0o600),
    ]);

    return {
      config,
      configFile,
      events,
      server,
      async close(): Promise<boolean> {
        if (closed) {
          return false;
        }
        closing = true;
        await writeQueue;
        server.close();
        server.closeAllConnections();
        await closedPromise;
        return true;
      },
    };
  } catch (error) {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    await rm(sessionDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function readSessionConfig(path: string): Promise<SessionConfig> {
  const absolutePath = resolve(path);
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new Error('configuration path is not a file');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('configuration file permissions must not grant group or other access');
  }
  const value: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
  if (!isRecord(value)) {
    throw new Error('configuration file is invalid');
  }
  const validCommonFields = typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && Number.isInteger(value.port)
    && (value.port as number) >= 1
    && (value.port as number) <= 65535
    && Number.isInteger(value.processId)
    && (value.processId as number) >= 1
    && typeof value.sessionDirectory === 'string'
    && typeof value.eventsFile === 'string';
  if (!validCommonFields) {
    throw new Error('configuration file is invalid');
  }
  const port = value.port as number;
  const validCurrentConfig = value.configVersion === CONFIG_VERSION
    && value.eventSchemaVersion === EVENT_SCHEMA_VERSION
    && typeof value.adminToken === 'string'
    && value.adminToken.length > 0
    && typeof value.ingestToken === 'string'
    && value.ingestToken.length > 0
    && value.adminToken !== value.ingestToken
    && (value.bindAddress === '127.0.0.1' || value.bindAddress === '0.0.0.0')
    && value.controlUrl === collectorUrl('127.0.0.1', port)
    && Array.isArray(value.ingestUrls)
    && value.ingestUrls.length > 0
    && value.ingestUrls.every(url => isValidIngestUrl(url, port));
  if (!validCurrentConfig) {
    throw new Error('configuration file is invalid');
  }
  return {
    configVersion: CONFIG_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    sessionId: value.sessionId as string,
    adminToken: value.adminToken as string,
    ingestToken: value.ingestToken as string,
    bindAddress: value.bindAddress as SessionConfig['bindAddress'],
    controlUrl: value.controlUrl as string,
    ingestUrls: value.ingestUrls as string[],
    port,
    processId: value.processId as number,
    sessionDirectory: value.sessionDirectory,
    eventsFile: value.eventsFile,
  };
}

export function parseOptionArguments(
  args: string[],
  allowed: ReadonlySet<string>,
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.has(option) || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid or incomplete option: ${option ?? '<missing>'}`);
    }
    if (parsed[option] !== undefined) {
      throw new Error(`duplicate option: ${option}`);
    }
    parsed[option] = value;
  }
  return parsed;
}

export function parseCommandArguments(
  args: string[],
  valueOptions: ReadonlySet<string>,
  flagOptions: ReadonlySet<string>,
): ParsedCommandArguments {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (flagOptions.has(option)) {
      if (flags.has(option)) {
        throw new Error(`duplicate option: ${option}`);
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Error(`invalid option: ${option ?? '<missing>'}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`invalid or incomplete option: ${option}`);
    }
    if (values[option] !== undefined) {
      throw new Error(`duplicate option: ${option}`);
    }
    values[option] = value;
    index += 1;
  }
  return { values, flags };
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function isUnreachableRequestError(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

export function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error, 'ESRCH')) {
      return false;
    }
    if (isErrnoException(error, 'EPERM')) {
      return true;
    }
    throw error;
  }
}

export function manualProcessInspectionGuidance(processId: number): string[] {
  return [
    'PID_IDENTITY: UNVERIFIED',
    `RECOVERY: inspect process ${processId} manually before deciding whether to terminate it`,
  ];
}

export async function getCollectorStatus(config: SessionConfig): Promise<CollectorStatus> {
  const processAlive = isProcessAlive(config.processId);
  let response: Response;
  try {
    response = await fetch(`${config.controlUrl}/health`, {
      headers: { authorization: `Bearer ${config.adminToken}` },
      signal: AbortSignal.timeout(LIFECYCLE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isUnreachableRequestError(error)) {
      return { state: 'unreachable', processId: config.processId, processAlive };
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`collector returned ${response.status}: ${await response.text()}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)
    || body.status !== 'ok'
    || body.schemaVersion !== EVENT_SCHEMA_VERSION
    || body.sessionId !== config.sessionId
    || !Number.isInteger(body.eventCount)
    || (body.rejectedEvents !== undefined
      && (!Number.isInteger(body.rejectedEvents) || (body.rejectedEvents as number) < 0))
    || (body.storageFailures !== undefined
      && (!Number.isInteger(body.storageFailures) || (body.storageFailures as number) < 0))
    || (body.capacityReached !== undefined
      && (typeof body.capacityReached !== 'boolean'
        || body.capacityReached !== (((body.rejectedEvents as number | undefined) ?? 0) > 0)))) {
    throw new Error('collector returned an invalid health response');
  }
  const rejectedEvents = (body.rejectedEvents as number | undefined) ?? 0;
  const storageFailures = (body.storageFailures as number | undefined) ?? 0;
  return {
    state: 'running',
    processId: config.processId,
    processAlive,
    eventCount: body.eventCount as number,
    rejectedEvents,
    storageFailures,
    capacityReached: rejectedEvents > 0,
  };
}

export async function startLogServer(args: string[]): Promise<LogServer> {
  const options = parseCommandArguments(
    args,
    new Set(['--port', '--session-directory', '--advertise-host']),
    new Set(['--allow-remote']),
  );
  const port = options.values['--port'] === undefined ? 0 : Number(options.values['--port']);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer from 0 through 65535');
  }
  const sessionDirectory = options.values['--session-directory'];
  if (sessionDirectory) {
    const configPath = join(resolve(sessionDirectory), 'config.json');
    try {
      const priorConfig = await readSessionConfig(configPath);
      throw new DebugServerStartupError(
        `session directory already belongs to debug collector ${priorConfig.sessionId}`,
        priorConfig,
      );
    } catch (error) {
      if (error instanceof DebugServerStartupError || !isErrnoException(error, 'ENOENT')) {
        throw error;
      }
    }
  }
  return createLogServer({
    port,
    allowRemote: options.flags.has('--allow-remote'),
    ...(options.values['--advertise-host']
      ? { advertiseHost: options.values['--advertise-host'] }
      : {}),
    ...(sessionDirectory ? { sessionDirectory } : {}),
  });
}
