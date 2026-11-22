import compression from 'compression';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, store, close, ready } = createApp(config);

app.use(compression());

await ready;

let pcSync;
if (config.role === 'pc') {
  const { startPcSync } = await import('./pc-sync.js');
  pcSync = startPcSync(store, config);
}

const server = app.listen(config.port, config.host);
server.once('listening', () => {
  console.log(`Vampdrop (${config.role}) listening on http://${config.host}:${server.address().port}`);
  if (config.role === 'pc' && config.pcPublicUrl)
    console.log(`PC public URL: ${config.pcPublicUrl}`);
});
server.once('error', (err) => {
  console.error(`Could not start Vampdrop: ${err.message}`);
  pcSync?.stop();
  close();
  process.exit(1);
});
server.requestTimeout = 15 * 60_000;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    pcSync?.stop();
    server.close(async () => {
      await close();
      process.exit(0);
    });
  });
}