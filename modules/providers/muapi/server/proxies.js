function cleanHeaders(request) {
  const headers = new Headers(request.headers);
  for (const name of ['host', 'connection', 'cookie', 'content-length', 'authorization', 'x-api-key']) {
    headers.delete(name);
  }
  return headers;
}

async function proxy(request, params, apiKey, prefix) {
  const slug = await params;
  const path = (slug?.path || []).join('/');
  const { search } = new URL(request.url);
  const headers = cleanHeaders(request);
  if (apiKey) headers.set('x-api-key', apiKey);
  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.arrayBuffer()
    : undefined;
  const response = await fetch(`${prefix}${path ? `/${path}` : ''}${search}`, {
    method: request.method, headers, body,
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
  });
}

export const proxyMuapiAgents = (request, { params, apiKey }) =>
  proxy(request, params, apiKey, 'https://api.muapi.ai/agents');

export const proxyMuapiDesignAgent = (request, { params, apiKey }) =>
  proxy(request, params, apiKey, 'https://api.muapi.ai/api/v1/creative-agent');

export const proxyMuapiApp = (request, { params, apiKey }) =>
  proxy(request, params, apiKey, 'https://api.muapi.ai/app');
