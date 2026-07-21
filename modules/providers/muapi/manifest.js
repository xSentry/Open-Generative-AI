import { publicManifest } from '../core/publicManifest.js';

export const muapiManifest = publicManifest({
  id: 'muapi',
  label: 'MuAPI',
  description: 'Use MuAPI generation and legacy proxy transports.',
  credential: { label: 'API key', placeholder: 'mu_...', helpUrl: 'https://muapi.ai/access-keys', required: true },
  features: { studio: true, workflow: true, workflowArchitect: false, agents: true, designAgent: true, clipping: true, vibeMotion: true, apps: true },
  modes: ['t2i', 'i2i', 't2v', 'i2v', 'v2v', 'lipsync', 'recast', 'audio', 'cinema', 'marketing'],
});

