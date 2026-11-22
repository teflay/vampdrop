import { resolve } from 'node:path';
import { isIP } from 'node:net';

function integer(value, fallback, name, minimum = 1) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`Invalid ${name}`);
  return result;
}

export function loadConfig(env = process.env) {
  const role = env.NODE_ROLE || 'standalone';
  if (!['pc', 'cloud', 'standalone'].includes(role))
    throw new Error('NODE_ROLE must be pc, cloud or standalone');

  const syncSecret = env.SYNC_SECRET || '';
  if (role !== 'standalone' && syncSecret.length < 32)
    throw new Error('SYNC_SECRET must be at least 32 characters when NODE_ROLE is pc or cloud');

  let syncPeer = null;
  if (role === 'pc') {
    if (!env.CLOUD_URL) throw new Error('NODE_ROLE=pc requires CLOUD_URL');
    try {
      const u = new URL(env.CLOUD_URL);
      if (!['http:', 'https:'].includes(u.protocol) || u.pathname !== '/')
        throw new Error('CLOUD_URL must be an HTTP(S) origin');
      syncPeer = u.origin;
    } catch {
      throw new Error('Invalid CLOUD_URL');
    }
  }

  const storageBackend = env.STORAGE_BACKEND || 'local';
  if (!['local', 's3', 'external'].includes(storageBackend))
    throw new Error('Invalid STORAGE_BACKEND');

  const externalUploadEnabled = env.EXTERNAL_UPLOAD_ENABLED === 'true';
  let externalRoot;
  if (externalUploadEnabled) {
    if (!env.EXTERNAL_ROOT)
      throw new Error('EXTERNAL_ROOT is required when EXTERNAL_UPLOAD_ENABLED=true');
    externalRoot = resolve(env.EXTERNAL_ROOT);
  } else if (storageBackend === 'external') {
    throw new Error('STORAGE_BACKEND=external requires EXTERNAL_UPLOAD_ENABLED=true');
  }

  let s3;
  if (storageBackend === 's3') {
    if (!env.S3_BUCKET || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET))
      throw new Error('Set a valid S3_BUCKET');
    if (!!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY)
      throw new Error('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
    if (env.S3_ENDPOINT) {
      const endpoint = new URL(env.S3_ENDPOINT);
      if (
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/'
      )
        throw new Error('S3_ENDPOINT must be an HTTP(S) origin');
    }
    const prefix = env.S3_PREFIX || 'ghostdrop/';
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/.test(prefix))
      throw new Error('S3_PREFIX must be a nonempty path ending in /');
    if (env.S3_FORCE_PATH_STYLE && !['true', 'false'].includes(env.S3_FORCE_PATH_STYLE))
      throw new Error('Invalid S3_FORCE_PATH_STYLE');
    s3 = {
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || 'us-east-1',
      prefix,
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: env.S3_ACCESS_KEY_ID
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
          }
        : undefined,
    };
  }

  if (
    env.ADMIN_PASSWORD_HASH &&
    !/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(env.ADMIN_PASSWORD_HASH)
  )
    throw new Error('Invalid ADMIN_PASSWORD_HASH. Generate it with npm run hash-password');
  if (
    env.UPLOAD_PASSWORD_HASH &&
    !/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(env.UPLOAD_PASSWORD_HASH)
  )
    throw new Error('Invalid UPLOAD_PASSWORD_HASH. Generate it with npm run hash-password');

  const uploadAllowedIps = (env.UPLOAD_ALLOWED_IPS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of uploadAllowedIps) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address);
    if (
      !version ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error(`Invalid UPLOAD_ALLOWED_IPS entry: ${entry}`);
  }

  const trustProxy = (env.TRUST_PROXY || '').trim();
  if (trustProxy === 'true')
    throw new Error('TRUST_PROXY=true is unsafe. Use a hop count such as 1 or proxy addresses');

  const origin = new URL(env.PUBLIC_ORIGIN || 'http://localhost:3000');
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin');
  }

  return {
    role,
    syncSecret,
    syncPeer,
    pcPublicUrl: env.PC_PUBLIC_URL || '',
    heartbeatIntervalMs: integer(env.HEARTBEAT_INTERVAL_MS, 60_000, 'HEARTBEAT_INTERVAL_MS'),
    syncIntervalMs: integer(env.SYNC_INTERVAL_MS, 60_000, 'SYNC_INTERVAL_MS'),
    pcOnlineTtlMs: integer(env.PC_ONLINE_TTL_MS, 120_000, 'PC_ONLINE_TTL_MS'),

    storageBackend,
    s3,
    externalUploadEnabled,
    externalRoot,
    externalHash: env.EXTERNAL_HASH === 'true',
    externalUploadToken: env.EXTERNAL_UPLOAD_TOKEN || '',
    port: integer(env.PORT, 3000, 'PORT', 0),
    host: env.HOST || '127.0.0.1',
    dataDir: resolve(env.DATA_DIR || './data'),
    maxFileBytes: integer(env.MAX_FILE_BYTES, 100 * 1024 * 1024, 'MAX_FILE_BYTES'),
    maxTotalBytes: env.MAX_TOTAL_BYTES
      ? integer(env.MAX_TOTAL_BYTES, 0, 'MAX_TOTAL_BYTES')
      : 0,
    origin: origin.origin,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
    uploadPasswordHash: env.UPLOAD_PASSWORD_HASH || '',
    uploadAllowedIps,
    trustProxy: /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy || false,
    cookieSecure: env.COOKIE_SECURE === 'true',
    cleanupIntervalMs: integer(env.CLEANUP_INTERVAL_MS, 60_000, 'CLEANUP_INTERVAL_MS'),
	botApiToken: env.BOT_API_TOKEN || '',
  };
}