import { refreshProviderDiagnostics } from '../modules/providers/server/registry.js';

const diagnostics = await refreshProviderDiagnostics();
const unhealthy = diagnostics.filter((entry) => !entry.configurationAvailable || !entry.catalogLoaded);

for (const entry of diagnostics) {
  const state = entry.catalogLoaded ? 'ready' : `unavailable (${entry.catalogErrorCode || 'unknown'})`;
  console.log(`${entry.provider}: catalog ${state}, ${entry.catalogModelCount ?? 0} models`);
}

if (unhealthy.length > 0) process.exitCode = 1;
