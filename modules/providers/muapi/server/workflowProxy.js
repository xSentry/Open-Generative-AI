// Extracted 1:1 from the original app/api/workflow/[[...path]]/route.js so that
// MuAPI users keep the exact same behaviour after the local-engine dispatch was
// introduced. This is a pure passthrough proxy to https://api.muapi.ai/workflow.
const MUAPI_BASE = 'https://api.muapi.ai';

function cleanHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  // CRITICAL: Stop forwarding browser cookies to MuAPI to avoid auth conflicts.
  headers.delete('cookie');
  headers.delete('content-length');
  return headers;
}

// Proxy an incoming workflow request to MuAPI. `apiKey` is resolved upstream via
// The authenticated route resolves the user's database credential and passes it
// explicitly; browser headers and cookies are never credential sources.
export async function proxyToMuapi(request, { params }, method, apiKey) {
  const slug = await params;
  const pathSegments = slug?.path || [];
  const path = pathSegments.join('/');

  const { search } = new URL(request.url);
  const targetUrl = `${MUAPI_BASE}/workflow/${path}${search}`;

  const headers = cleanHeaders(request);
  if (apiKey) headers.set('x-api-key', apiKey);

  try {
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE';
    const response = await fetch(targetUrl, {
      method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
    });
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

