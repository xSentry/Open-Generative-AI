import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: projectRoot,
  transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
  // Keep Node-only DB drivers out of the webpack bundle (they use `fs`, `net`,
  // etc.). Next will `require()` them at runtime instead.
  serverExternalPackages: ['pg', 'pg-connection-string'],
};

export default nextConfig;
