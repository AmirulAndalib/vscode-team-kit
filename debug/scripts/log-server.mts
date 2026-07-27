import install from '../../common/install-if-necessary.mts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

await install();

const {
  DebugServerStartupError,
  manualProcessInspectionGuidance,
  startLogServer,
} = await import('./log-server-impl.mts');

try {
  const collector = await startLogServer(process.argv.slice(2));
  console.log('RESULT: DEBUG_SERVER_READY');
  console.log(`SESSION_ID: ${collector.config.sessionId}`);
  console.log(`BIND_ADDRESS: ${collector.config.bindAddress}`);
  console.log(`PORT: ${collector.config.port}`);
  console.log(`CONTROL_URL: ${collector.config.controlUrl}`);
  for (const url of collector.config.ingestUrls) {
    console.log(`INGEST_URL: ${url}`);
  }
  if (collector.config.bindAddress !== '127.0.0.1') {
    console.log('SECURITY: remote ingestion uses unencrypted HTTP; use only on a trusted development network');
  }
  console.log(`PID: ${collector.config.processId}`);
  console.log(`CONFIG_FILE: ${collector.configFile}`);
  collector.server.on('error', error => {
    console.error('RESULT: DEBUG_SERVER_ERROR');
    console.error(error.message);
    process.exitCode = 1;
  });
  collector.server.once('close', () => {
    console.log('RESULT: DEBUG_SERVER_STOPPED');
  });
} catch (error) {
  console.error('RESULT: DEBUG_SERVER_ERROR');
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof DebugServerStartupError && error.priorConfig) {
    console.error(`PRIOR_SESSION_ID: ${error.priorConfig.sessionId}`);
    console.error(`PRIOR_PID: ${error.priorConfig.processId}`);
    console.error('RECOVERY: run the status script with the prior config file after safely quoting both paths for the current shell');
    console.error(`STATUS_SCRIPT: ${fileURLToPath(new URL('./debug-server-status.mts', import.meta.url))}`);
    console.error(`PRIOR_CONFIG_FILE: ${join(error.priorConfig.sessionDirectory, 'config.json')}`);
    for (const line of manualProcessInspectionGuidance(error.priorConfig.processId)) {
      console.error(line);
    }
  }
  process.exitCode = 1;
}
