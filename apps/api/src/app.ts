import Fastify from 'fastify';

import type { HealthResponse } from '@serein/contracts';

const API_VERSION = 'v1' as const;

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', async (): Promise<HealthResponse> => ({
    service: 'serein-api',
    status: 'ok',
    version: API_VERSION,
  }));

  return app;
}
