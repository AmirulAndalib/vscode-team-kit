import install from '../../common/install-if-necessary.mts';

await install();

try {
  const {
    getCollectorStatus,
    manualProcessInspectionGuidance,
    parseOptionArguments,
    readSessionConfig,
  } =
    await import('./log-server-impl.mts');
  const options = parseOptionArguments(process.argv.slice(2), new Set(['--config']));
  if (!options['--config']) {
    throw new Error('--config is required');
  }
  const config = await readSessionConfig(options['--config']);
  const status = await getCollectorStatus(config);
  console.log(status.state === 'running'
    ? 'RESULT: DEBUG_SERVER_RUNNING'
    : 'RESULT: DEBUG_SERVER_UNREACHABLE');
  console.log(`SESSION_ID: ${config.sessionId}`);
  console.log(`PID: ${status.processId}`);
  console.log(`PID_ALIVE: ${status.processAlive}`);
  if (status.eventCount !== undefined) {
    console.log(`EVENT_COUNT: ${status.eventCount}`);
  }
  if (status.rejectedEvents !== undefined) {
    console.log(`REJECTED_EVENTS: ${status.rejectedEvents}`);
    console.log(`CAPACITY_REACHED: ${status.capacityReached === true}`);
  }
  if (status.storageFailures !== undefined) {
    console.log(`STORAGE_FAILURES: ${status.storageFailures}`);
  }
  if (status.state === 'unreachable' && status.processAlive) {
    console.log('RECOVERY: authenticated shutdown is unavailable.');
    for (const line of manualProcessInspectionGuidance(status.processId)) {
      console.log(line);
    }
  }
} catch (error) {
  console.error('RESULT: DEBUG_STATUS_ERROR');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
