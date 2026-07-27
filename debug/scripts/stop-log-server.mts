import install from '../../common/install-if-necessary.mts';

await install();

try {
  const {
    LIFECYCLE_REQUEST_TIMEOUT_MS,
    getCollectorStatus,
    parseOptionArguments,
    readSessionConfig,
  } = await import('./log-server-impl.mts');
  const options = parseOptionArguments(process.argv.slice(2), new Set(['--config']));
  if (!options['--config']) {
    throw new Error('--config is required');
  }
  const config = await readSessionConfig(options['--config']);
  const status = await getCollectorStatus(config);
  if (status.state === 'unreachable') {
    console.log('RESULT: DEBUG_SERVER_ALREADY_STOPPED');
    process.exitCode = 2;
  } else {
    const response = await fetch(`${config.controlUrl}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.adminToken}` },
      signal: AbortSignal.timeout(LIFECYCLE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`collector returned ${response.status}: ${await response.text()}`);
    }
    const body = await response.json() as { stopped?: unknown; sessionId?: unknown };
    if (body.stopped !== true || body.sessionId !== config.sessionId) {
      throw new Error('collector returned an invalid shutdown acknowledgement');
    }
    console.log('RESULT: DEBUG_SERVER_STOPPED');
  }
} catch (error) {
  console.error('RESULT: DEBUG_SHUTDOWN_ERROR');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
