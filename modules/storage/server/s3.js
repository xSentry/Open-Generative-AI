import crypto from 'node:crypto';

const ISO_BASIC_DATE_LENGTH = 8;

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key) {
  return key.split('/').map(encodePathSegment).join('/');
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function normalizeEndpoint(endpoint) {
  if (!endpoint) {
    throw new Error('S3_ENDPOINT is required for provider-neutral uploads.');
  }
  return new URL(endpoint);
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function dateStamp(date) {
  return amzDate(date).slice(0, ISO_BASIC_DATE_LENGTH);
}

function signingKey(secretAccessKey, stamp, region) {
  const kDate = hmac(`AWS4${secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function canonicalQuery(params) {
  return [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function buildObjectUrl({ endpoint, bucket, key, forcePathStyle }) {
  const base = normalizeEndpoint(endpoint);
  const encodedKey = encodeKeyPath(key);

  if (forcePathStyle) {
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodePathSegment(bucket)}/${encodedKey}`;
    return base;
  }

  base.hostname = `${bucket}.${base.hostname}`;
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodedKey}`;
  return base;
}

export function getS3Config(env = process.env) {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: normalizeBoolean(env.S3_FORCE_PATH_STYLE, false),
    publicBaseUrl: env.S3_PUBLIC_BASE_URL || '',
    signedUrlTtlSeconds: Number(env.S3_SIGNED_URL_TTL_SECONDS || 86400),
  };
}

export function assertS3Config(config) {
  const missing = [];
  for (const key of ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey']) {
    if (!config[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`Missing S3 upload configuration: ${missing.join(', ')}`);
  }
}

export function createObjectKey({ userId, filename, date = new Date() }) {
  const safeName = String(filename || 'upload')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120) || 'upload';
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const id = crypto.randomUUID();
  return `studio-uploads/${userId}/${yyyy}/${mm}/${dd}/${id}-${safeName}`;
}

export function createOutputObjectKey({ userId, generationId, ext, date = new Date() }) {
  const safeExt = String(ext || 'bin')
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12) || 'bin';
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `studio-outputs/${userId}/${yyyy}/${mm}/${dd}/${generationId}.${safeExt}`;
}

// Object key for a media output produced by a workflow node run. Scoped by user
// and workflow so a whole workflow's outputs share a prefix (handy for auditing)
// and each run/node-run/output index is unique.
export function createWorkflowOutputObjectKey({ userId, workflowId, runId, nodeRunId, index = 0, ext, date = new Date() }) {
  const safeExt = String(ext || 'bin')
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12) || 'bin';
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `workflow-outputs/${userId}/${workflowId}/${yyyy}/${mm}/${dd}/${runId}/${nodeRunId}-${index}.${safeExt}`;
}

export function signS3Request({ method, url, region, accessKeyId, secretAccessKey, headers = {}, payloadHash, date = new Date() }) {
  const parsedUrl = new URL(url);
  const now = amzDate(date);
  const stamp = dateStamp(date);
  const lowerHeaders = {
    host: parsedUrl.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now,
  };

  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = String(value).trim();
  }

  const signedHeaders = Object.keys(lowerHeaders).sort().join(';');
  const canonicalHeaders = Object.keys(lowerHeaders)
    .sort()
    .map((key) => `${key}:${lowerHeaders[key]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    parsedUrl.pathname,
    canonicalQuery(parsedUrl.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${stamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    now,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  const signature = hmac(signingKey(secretAccessKey, stamp, region), stringToSign, 'hex');

  return {
    ...headers,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createPresignedGetUrl({ config, key, date = new Date() }) {
  const endpoint = config.publicBaseUrl || config.endpoint;
  const url = buildObjectUrl({
    endpoint,
    bucket: config.bucket,
    key,
    forcePathStyle: config.forcePathStyle || Boolean(config.publicBaseUrl),
  });
  const now = amzDate(date);
  const stamp = dateStamp(date);
  const credentialScope = `${stamp}/${config.region}/s3/aws4_request`;
  const params = url.searchParams;

  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', `${config.accessKeyId}/${credentialScope}`);
  params.set('X-Amz-Date', now);
  params.set('X-Amz-Expires', String(config.signedUrlTtlSeconds));
  params.set('X-Amz-SignedHeaders', 'host');

  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery(params),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    now,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  params.set('X-Amz-Signature', hmac(signingKey(config.secretAccessKey, stamp, config.region), stringToSign, 'hex'));

  return url.toString();
}

export async function uploadObject({ config, key, body, contentType }) {
  assertS3Config(config);
  const url = buildObjectUrl({
    endpoint: config.endpoint,
    bucket: config.bucket,
    key,
    forcePathStyle: config.forcePathStyle,
  });
  const payloadHash = sha256(Buffer.from(body));
  const headers = signS3Request({
    method: 'PUT',
    url,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    payloadHash,
    headers: {
      'content-type': contentType || 'application/octet-stream',
    },
  });

  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`S3 upload failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  return createPresignedGetUrl({ config, key });
}

export async function deleteObject({ config, key }) {
  assertS3Config(config);
  const url = buildObjectUrl({
    endpoint: config.endpoint,
    bucket: config.bucket,
    key,
    forcePathStyle: config.forcePathStyle,
  });
  const payloadHash = sha256(Buffer.from(''));
  const headers = signS3Request({
    method: 'DELETE',
    url,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    payloadHash,
  });

  const response = await fetch(url, {
    method: 'DELETE',
    headers,
  });

  // S3/MinIO return 204 on delete; 404 means already gone which we treat as success.
  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    throw new Error(`S3 delete failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  return true;
}

