import { createRuntime } from './server.js';
import { loadRuntimeConfig, OPENROUTER_KEY_REQUIRED, OPENAI_KEY_REQUIRED, EPHEMERAL_HISTORY_VALUE_ERROR, EPHEMERAL_HISTORY_CONFLICT_ERROR, EPHEMERAL_HISTORY_LOCAL_ERROR } from './config.js';

try {
  const config = await loadRuntimeConfig(process.env);
  const rawPort = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('Invalid PORT configuration.');
  const { server, abortAll, closeStore } = await createRuntime(config);
  server.on('error', () => { void closeStore(); process.stderr.write('Server failed to start. Check the port and configuration.\n'); process.exitCode = 1; });
  server.listen(Number(rawPort), config.localDev ? '127.0.0.1' : '0.0.0.0', () => {
    if (config.localDev && !config.redisUrl) process.stderr.write('History is in memory and disappears on restart.\n');
    // A coding agent needs one parseable readiness line; humans get a sentence instead.
    process.stdout.write(process.env.FASTAGENT_DEV_JSON === '1'
      ? JSON.stringify({ ok: true, command: 'dev', url: config.origin }) + '\n'
      : 'Headless chat service ready.\n');
  });
  const shutdown = () => {
    abortAll();
    server.close(() => { void closeStore(); });
    server.closeIdleConnections();
    const timer = setTimeout(() => { server.closeAllConnections(); }, 5000);
    timer.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  // Only known local configuration messages are exposed; never provider errors or secret values.
  const allowed = [
    'maxOutputTokens must be an integer from 1 to 16384 in fastagent.yaml.',
    'Invalid fastagent.yaml configuration.', 'Invalid bearer token configuration.',
    'Invalid history namespace configuration.', 'REDIS_URL must configure Redis with TLS in production.',
    'Conversation service unavailable. Please try again.',
    'Invalid APP_ORIGIN configuration.', 'Invalid local development configuration.', 'Invalid PORT configuration.',
    EPHEMERAL_HISTORY_VALUE_ERROR, EPHEMERAL_HISTORY_CONFLICT_ERROR, EPHEMERAL_HISTORY_LOCAL_ERROR,
    'APP_ORIGIN must be an HTTPS origin, or an HTTP localhost origin in explicit local development mode.',
    'IPv6 localhost APP_ORIGIN is not supported. Use http://localhost or http://127.0.0.1 with the configured port.',
    'Unsupported model provider or identifier. Use openrouter/<vendor>/<model> or openai/<model> in fastagent.yaml.',
  ];
  const missingKey = error instanceof Error && [OPENROUTER_KEY_REQUIRED, OPENAI_KEY_REQUIRED].includes(error.message);
  const message = error instanceof Error && (missingKey || allowed.includes(error.message)) ? error.message : 'Server startup failed. Check runtime configuration.';
  if (missingKey && process.env.FASTAGENT_DEV_JSON === '1') {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'MODEL_API_KEY_MISSING', message } }) + '\n');
  } else {
    process.stderr.write(message + '\n');
  }
  process.exitCode = 1;
}
