const env = require('./config/env');
const { pool } = require('./config/db');
const { createApp } = require('./app');
const { ensureMarketingRunsTable } = require('./services/marketingStore');

async function start() {
  await ensureMarketingRunsTable();
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`API listening on port ${env.port}`);
  });

  async function shutdown() {
    server.close();
    await pool.end();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
