const MUAPI_BASE = 'https://api.muapi.ai';

export function cleanProxyHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('cookie');
  headers.delete('content-length');
  return headers;
}

export async function proxyMuapiV1Request({ request, path, apiKey, body }) {
  const { search } = new URL(request.url);
  const targetUrl = `${MUAPI_BASE}/api/v1/${path}${search}`;
  const headers = cleanProxyHeaders(request);

  if (apiKey) {
    headers.set('x-api-key', apiKey);
  }

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? body : undefined,
  });

  const contentType = response.headers.get('content-type') || 'application/json';
  const data = await response.arrayBuffer();

  return new Response(data, {
    status: response.status,
    headers: {
      'content-type': contentType,
    },
  });
}

async function muapiJsonRequest(apiKey, path, options = {}) {
  const response = await fetch(`${MUAPI_BASE}/api/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const detail = data?.detail || data?.error || response.statusText;
    const error = new Error(`MuAPI request failed: ${detail}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }

  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runMuapiPrediction({ apiKey, endpoint, params, maxAttempts = 900, interval = 2000 }) {
  const submitData = await muapiJsonRequest(apiKey, endpoint, {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const requestId = submitData.request_id || submitData.id;

  if (!requestId) {
    const outputs = submitData.outputs || (submitData.url ? [submitData.url] : []);
    return {
      ...submitData,
      url: submitData.url || outputs[0] || submitData.output?.url || null,
      outputs,
      provider: 'muapi',
    };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(interval);
    const result = await muapiJsonRequest(apiKey, `predictions/${requestId}/result`);
    const status = result.status?.toLowerCase();

    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const outputs = result.outputs || (result.url ? [result.url] : []);
      return {
        ...result,
        url: result.url || outputs[0] || result.output?.url || null,
        outputs,
        provider: 'muapi',
      };
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`MuAPI generation failed: ${result.error || 'Unknown error'}`);
    }
  }

  throw new Error('MuAPI generation timed out.');
}
