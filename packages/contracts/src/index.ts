export const API_VERSION = 'v1' as const;

export interface HealthResponse {
  service: 'serein-api';
  version: typeof API_VERSION;
  status: 'ok';
}
