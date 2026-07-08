/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['studio', 'ai-agent', 'workflow-builder', 'design-agent'],
  // Keep Node-only DB drivers out of the webpack bundle (they use `fs`, `net`,
  // etc.). Next will `require()` them at runtime instead.
  serverExternalPackages: ['pg', 'pg-connection-string'],
};

export default nextConfig;
