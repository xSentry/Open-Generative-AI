import { publicManifest } from '../core/publicManifest.js';

export const replicateManifest = publicManifest({
  id: 'replicate',
  label: 'Replicate',
  description: 'Run open models through Replicate.',
  credential: { label: 'API token', placeholder: 'r8_...', helpUrl: 'https://replicate.com/account/api-tokens', required: true },
  features: { studio: true, workflow: true, workflowArchitect: true, agents: true, designAgent: true, clipping: false, vibeMotion: false, apps: false },
  modes: ['t2i', 'i2i', 't2v', 'i2v', 'v2v', 'lipsync', 'recast', 'audio', 'cinema', 'marketing', 't2t'],
});

