// Tiny Express server — exists so the bot can run as a Render "web service"
// (Render requires a bound $PORT) and so an external uptime pinger
// (UptimeRobot / cron-job.org) can hit GET /health every ~10 min to keep the
// free instance awake. On a normal VM this is harmless/optional (only starts
// when PORT is set).

import { dbEnabled, dbPing } from './db.js';

// express is imported LAZILY (only when a PORT is set) so a VM that doesn't run
// the HTTP server doesn't need the dependency installed.
export async function startHealthServer({ port, getStatus } = {}) {
  if (!port) return null;
  const { default: express } = await import('express');
  const app = express();
  const bootAt = Date.now();

  app.get('/health', async (req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - bootAt) / 1000),
      db: dbEnabled() ? (await dbPing() ? 'up' : 'down') : 'file',
      ...(getStatus?.() ?? {})
    });
  });
  app.get('/', (req, res) => res.type('text').send('tradeAlertBot is running'));

  const server = app.listen(port, () => {
    console.log(`[health] HTTP server on :${port} — GET /health for keep-alive pings`);
  });
  server.on('error', (err) => console.warn(`[health] server error: ${err.message}`));
  return server;
}
