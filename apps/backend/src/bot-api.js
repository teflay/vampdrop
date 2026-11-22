// apps/backend/src/bot-api.js
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { httpError } from './security.js';
import { publicFile } from './files.js';
import { deleteFile } from './lifecycle.js';

export function registerBotRoutes(app, store, config, runCleanup) {
  // Middleware de seguridad para el bot
  const requireBot = (req, res, next) => {
    if (!config.botApiToken) return next(httpError(503, 'Bot API is disabled.', 'bot_disabled'));
    if (req.headers['authorization'] !== `Bearer ${config.botApiToken}`) {
      return next(httpError(401, 'Unauthorized.', 'unauthorized'));
    }
    next();
  };

  // 1. Obtener estadísticas
  app.get('/api/bot/stats', requireBot, async (req, res) => {
    const count = store.db.prepare('SELECT count(*) AS count FROM files').get().count;
    const externalCount = store.db.prepare("SELECT count(*) AS count FROM files WHERE storage_backend = 'external'").get().count;
    const externalBytes = store.db.prepare("SELECT coalesce(sum(size), 0) AS bytes FROM files WHERE storage_backend = 'external'").get().bytes;

    async function diskBytes(directory) {
      let bytes = 0;
      try {
        for (const name of await readdir(directory)) {
          try { bytes += (await stat(join(directory, name))).size; } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
      } catch (e) { /* Ignorar si el directorio no existe */ }
      return bytes;
    }

    res.json({
      count,
      storedBytes: (await diskBytes(store.filesDir)) + store.db.prepare("SELECT coalesce(sum(size), 0) AS bytes FROM files WHERE storage_backend = 's3'").get().bytes,
      partialBytes: await diskBytes(store.partialDir),
      externalCount,
      externalBytes,
    });
  });

  // 2. Buscar y listar archivos
  app.get('/api/bot/files', requireBot, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 50);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    let where = '1 = 1', values = [];
    
    if (search) {
      where = "name LIKE ? ESCAPE '\\'";
      values = [`%${search.replace(/[\\%_]/g, (c) => '\\' + c)}%`];
    }

    const records = store.db.prepare(`SELECT * FROM files WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit);
    res.json({
      items: records.map((record) => ({
        ...publicFile(record),
        sha256: record.sha256,
        createdAt: record.created_at,
        state: record.expires_at <= Date.now() ? 'expired' : record.state,
      })),
    });
  });

  // 3. Borrar un archivo
  app.delete('/api/bot/files/:id', requireBot, async (req, res) => {
    if (!store.db.prepare('SELECT id FROM files WHERE id = ?').get(req.params.id)) {
      throw httpError(404, 'File not found.', 'file_unavailable');
    }
    await deleteFile(store, req.params.id);
    res.json({ deleted: true });
  });

  // 4. Forzar limpieza
  app.post('/api/bot/cleanup', requireBot, async (req, res) => {
    res.json(await runCleanup());
  });
}