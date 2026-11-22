import { createWriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable, Readable } from 'node:stream';
import { createHash } from 'node:crypto';

async function sha256File(path) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      new Writable({
        write(chunk, _enc, cb) {
          hash.update(chunk);
          cb();
        },
      })
    );
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export function startPcSync(store, config) {
  // AÑADIMOS LA CABECERA AQUÍ
  const headers = { 
    Authorization: `Bearer ${config.syncSecret}`,
    'X-Pinggy-No-Screen': '1',
    'User-Agent': 'Vampdrop-PC-Sync/1.0'
  };
  const timers = [];
  const state = { online: false };

  async function heartbeat() {
    try {
      const r = await fetch(`${config.syncPeer}/api/sync/heartbeat`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pcUrl: config.pcPublicUrl }),
      });
      state.online = r.ok;
      if (!r.ok) console.error('Heartbeat failed:', r.status);
    } catch (e) {
      state.online = false;
      console.error('Heartbeat error:', e.message);
    }
  }

  async function pullOne(item) {
    const tmp = join(store.partialDir, `sync-${item.id}`);
    // AÑADIMOS CABECERA AQUÍ
    const r = await fetch(`${config.syncPeer}/api/sync/files/${item.id}`, { headers });
    if (!r.ok) throw new Error(`download ${item.id}: HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp, { mode: 0o600 }));
    const st = await stat(tmp);
    if (st.size !== item.size) {
      await rm(tmp, { force: true });
      throw new Error(`size mismatch for ${item.id}: ${st.size} vs ${item.size}`);
    }
    const sum = await sha256File(tmp);
    if (sum !== item.sha256) {
      await rm(tmp, { force: true });
      throw new Error(`sha256 mismatch for ${item.id}`);
    }
    const dest = join(store.filesDir, item.id);
    await rename(tmp, dest);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db
        .prepare(
          'INSERT OR REPLACE INTO files(' +
            'id,name,mime,size,sha256,created_at,expires_at,password_hash,delete_hash,one_time,state,' +
            'storage_backend,storage_key,storage_bucket,origin' +
            ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          item.id,
          item.name,
          item.mime,
          item.size,
          item.sha256,
          item.created_at,
          item.expires_at,
          item.password_hash,
          item.delete_hash,
          item.one_time,
          'available',
          'local',
          null,
          null,
          'synced_from_pc'
        );
      store.db.exec('COMMIT');
    } catch (err) {
      store.db.exec('ROLLBACK');
      await rm(dest, { force: true }).catch(() => {});
      throw err;
    }
    // AÑADIMOS CABECERA AQUÍ
    await fetch(`${config.syncPeer}/api/sync/files/${item.id}`, { method: 'DELETE', headers });
  }

  async function syncFromCloud() {
    try {
      // AÑADIMOS CABECERA AQUÍ
      const r = await fetch(`${config.syncPeer}/api/sync/pending`, { headers });
      if (!r.ok) return;
      const { items } = await r.json();
      for (const item of items) {
        try {
          await pullOne(item);
          console.log(`Synced from cloud: ${item.id} (${item.name})`);
        } catch (err) {
          console.error(`Sync ${item.id} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('Sync cycle failed:', err.message);
    }
  }

  timers.push(setInterval(heartbeat, config.heartbeatIntervalMs));
  timers.push(setInterval(syncFromCloud, config.syncIntervalMs));
  heartbeat();
  setTimeout(syncFromCloud, 5_000);

  return {
    stop() {
      for (const t of timers) clearInterval(t);
    },
    isOnline: () => state.online,
  };
}