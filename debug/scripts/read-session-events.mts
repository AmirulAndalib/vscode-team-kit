import install from '../../common/install-if-necessary.mts';

await install();

try {
  const { LIFECYCLE_REQUEST_TIMEOUT_MS, MAX_READ_LIMIT, parseOptionArguments, readSessionConfig } =
    await import('./log-server-impl.mts');
  const options = parseOptionArguments(
    process.argv.slice(2),
    new Set(['--config', '--offset', '--limit']),
  );
  if (!options['--config']) {
    throw new Error('--config is required');
  }
  const offset = options['--offset'] ?? '0';
  const limit = options['--limit'] ?? '100';
  if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_READ_LIMIT) {
    throw new Error(`--offset must be non-negative and --limit must be from 1 through ${MAX_READ_LIMIT}`);
  }
  const config = await readSessionConfig(options['--config']);
  const response = await fetch(
    `${config.controlUrl}/v1/events?offset=${offset}&limit=${limit}`,
    {
      headers: { authorization: `Bearer ${config.adminToken}` },
      signal: AbortSignal.timeout(LIFECYCLE_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`collector returned ${response.status}: ${await response.text()}`);
  }
  const body = await response.json() as {
    rejectedEvents?: unknown;
    storageFailures?: unknown;
    capacityReached?: unknown;
  };
  const rejectedEvents = body.rejectedEvents ?? 0;
  const storageFailures = body.storageFailures ?? 0;
  if (!Number.isInteger(rejectedEvents)
    || (rejectedEvents as number) < 0
    || !Number.isInteger(storageFailures)
    || (storageFailures as number) < 0
    || (body.capacityReached !== undefined
      && body.capacityReached !== ((rejectedEvents as number) > 0))) {
    throw new Error('collector returned invalid capacity metadata');
  }
  console.log((storageFailures as number) > 0
    ? 'RESULT: DEBUG_EVENT_STORAGE_FAILED'
    : (rejectedEvents as number) > 0
      ? 'RESULT: DEBUG_EVENT_CAPACITY_REACHED'
      : 'RESULT: DEBUG_EVENTS_READ');
  console.log(`REJECTED_EVENTS: ${rejectedEvents}`);
  console.log(`STORAGE_FAILURES: ${storageFailures}`);
  console.log(JSON.stringify(body, null, 2));
} catch (error) {
  console.error('RESULT: DEBUG_READ_ERROR');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
