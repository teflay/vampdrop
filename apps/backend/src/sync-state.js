export function getState(db, key) {
  return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value;
}

export function setState(db, key, value) {
  db.prepare(
    'INSERT INTO sync_state(key,value,updated_at) VALUES(?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, String(value), Date.now());
}