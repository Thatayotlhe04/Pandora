import { serve } from '@hono/node-server';
import { getEnv, logger } from '@pandora/core';
import { app } from './server.js';

const { PORT } = getEnv();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(`pandora ingestion listening on :${info.port}`);
});
