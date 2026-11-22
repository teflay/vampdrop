import { equal } from './security.js';
import { getState, setState } from './sync-state.js';

function requireSync(req, res, next) {
  const auth = req.headers.authorization || '';
  const secret = req.app.locals.config?.syncSecret || '';
  if (!secret || !equal(auth, `Bearer ${secret}`))
    return res.status(401).json({ error: 'Unauthorized', code: 'sync_unauthorized' });
  next();
}

export function registerCloudSyncRoutes(app, store, config) {
  app.locals.config = config;

  app.post('/api/sync/heartbeat', requireSync, (req, res) => {
    const { pcUrl } = req.body || {};
    console.log('RECIBIDO:', JSON.stringify({ pcUrl, body: req.body }));
    
    if (typeof pcUrl !== 'string' || !/^https?:\/\//.test(pcUrl))
      return res.status(400).json({ 
        error: 'Invalid pcUrl', 
        code: 'invalid_pc_url',
        received: pcUrl
      });

    // ESTO FALTABA: Guardar la URL y la fecha en la base de datos
    setState(store.db, 'pc_url', pcUrl);
    setState(store.db, 'pc_last_seen', Date.now());
    res.json({ ok: true });
  });

  app.get('/api/status', (req, res) => {
    const pcUrl = getState(store.db, 'pc_url');
    const lastSeen = Number(getState(store.db, 'pc_last_seen') || 0);
    const pcOnline = !!pcUrl && Date.now() - lastSeen < config.pcOnlineTtlMs;
    const used = store.db
      .prepare("SELECT coalesce(sum(size),0) AS b FROM files WHERE origin = 'cloud_pending'")
      .get().b;
    res.json({
      pcOnline,
      pcUrl: pcOnline ? pcUrl : null,
      cloudMaxFileBytes: config.maxFileBytes,
      cloudMaxTotalBytes: config.maxTotalBytes,
      cloudUsedBytes: used,
    });
  });

  app.get('/api/sync/pending', requireSync, (req, res) => {
    const rows = store.db
      .prepare("SELECT * FROM files WHERE origin = 'cloud_pending' ORDER BY created_at ASC")
      .all();
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime: r.mime,
        size: r.size,
        sha256: r.sha256,
        created_at: r.created_at,
        expires_at: r.expires_at,
        password_hash: r.password_hash,
        delete_hash: r.delete_hash,
        one_time: r.one_time,
      })),
    });
  });

  app.get('/api/sync/files/:id', requireSync, async (req, res) => {
    const record = store.db
      .prepare("SELECT * FROM files WHERE id = ? AND origin = 'cloud_pending'")
      .get(req.params.id);
    if (!record)
      return res.status(404).json({ error: 'Not pending', code: 'not_pending' });
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const handle = await store.storage.open(record, controller.signal);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(record.size),
      'Cache-Control': 'no-store',
    });
    try {
      for await (const chunk of handle.stream) res.write(chunk);
      res.end();
    } catch (err) {
      res.destroy(err);
    } finally {
      await handle.close().catch(() => {});
    }
  });

  app.delete('/api/sync/files/:id', requireSync, async (req, res) => {
    const record = store.db
      .prepare("SELECT * FROM files WHERE id = ? AND origin = 'cloud_pending'")
      .get(req.params.id);
    if (!record)
      return res.status(404).json({ error: 'Not pending', code: 'not_pending' });
    store.db.prepare('DELETE FROM files WHERE id = ?').run(record.id);
    await store.storage.remove(record);
    res.json({ deleted: true });
  });
}