import { resolve, basename } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { httpError, token, digest, hashPassword } from './security.js';
import { lifetimes, detectType } from './upload.js';
import { createHmac } from 'node:crypto';

const deletionToken = (secret, id) =>
  createHmac('sha256', secret).update(`ghostdrop-delete:${id}`).digest('base64url');

export function registerExternalRoutes(app, store, config, requireAdmin) {
  const authorize = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (config.externalUploadToken && authHeader === `Bearer ${config.externalUploadToken}`) {
      return next();
    }
    requireAdmin(req, res, next);
  };

  app.post('/api/uploads/external', authorize, async (req, res) => {
    const { path: inputPath, expiration, oneTime, password } = req.body;

    if (!inputPath || typeof inputPath !== 'string') {
      throw httpError(400, 'Path is required.', 'missing_path');
    }

    // Resuelve cualquier ruta absoluta de cualquier disco (C:\, D:\, etc.)
    let real;
    try {
      real = await realpath(resolve(inputPath));
    } catch {
      throw httpError(400, 'File not found or invalid path.', 'invalid_external_path');
    }

    const st = await stat(real);
    if (!st.isFile()) {
      throw httpError(400, 'Not a regular file.', 'invalid_external_file');
    }

    const exp = Object.hasOwn(lifetimes, expiration) ? expiration : 'day';
    const isOneTime = !!oneTime;
    const pass = typeof password === 'string' ? password : '';

    let passwordHash = null;
    if (pass) {
      passwordHash = await hashPassword(pass);
    }

    const id = token();
    const secret = token();
    const now = Date.now();
    const name = basename(real).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'file';
    const mime = await detectType(real, name);

    // Guardamos la ruta absoluta real directamente
    const storageKey = real;

    store.db
      .prepare(
        'INSERT INTO files(id,name,mime,size,sha256,created_at,expires_at,password_hash,delete_hash,one_time,storage_backend,storage_key,storage_bucket,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        name,
        mime,
        st.size,
        '',
        now,
        now + lifetimes[exp],
        passwordHash,
        digest(deletionToken(secret, id)),
        isOneTime ? 1 : 0,
        'external',
        storageKey,
        null,
        'local'
      );

    res.json({
      id,
      name,
      size: st.size,
      mime,
      expiresAt: now + lifetimes[exp],
      oneTime: isOneTime,
      passwordProtected: !!passwordHash,
      deletionToken: deletionToken(secret, id),
      storageBackend: 'external',
    });
  });
}
