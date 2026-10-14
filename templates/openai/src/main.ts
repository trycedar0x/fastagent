import { createRuntime } from './server.js';
import { loadRuntimeConfig } from './config.js';

try {
  const config = await loadRuntimeConfig(process.env);
  const rawPort = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('Invalid PORT configuration.');
  const { server, abortAll, closeStore } = await createRuntime(config);
  server.on('error', () => { void closeStore(); process.stderr.write('Server failed to start. Check the port and configuration.\n'); process.exitCode = 1; });
  server.listen(Number(rawPort), config.localDev ? '127.0.0.1' : '0.0.0.0', () => {
    process.stdout.write('Chat server ready.\n');
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
    'Invalid fastagent.yaml configuration.', 'Invalid access protection configuration.',
    'Invalid session namespace configuration.', 'REDIS_URL must configure Redis with TLS in production.',
    'Session service unavailable. Please try again.',
    'Invalid APP_ORIGIN configuration.', 'Invalid local development configuration.', 'Invalid PORT configuration.',
    'APP_ORIGIN must be an HTTPS origin, or an HTTP localhost origin in explicit local development mode.',
    'IPv6 localhost APP_ORIGIN is not supported. Use http://localhost or http://127.0.0.1 with the configured port.',
    'Unsupported model provider or identifier. Use openai/<model> in fastagent.yaml.',
  ];
  process.stderr.write((error instanceof Error && allowed.includes(error.message) ? error.message : 'Server startup failed. Check runtime configuration.') + '\n');
  process.exitCode = 1;
}
