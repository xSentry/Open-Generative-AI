export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const PROVIDER_FEATURES = Object.freeze([
  'studio', 'workflow', 'workflowArchitect', 'agents', 'designAgent',
  'clipping', 'vibeMotion', 'apps',
]);

export const PROVIDER_MODES = Object.freeze([
  't2i', 'i2i', 't2v', 'i2v', 'v2v', 'lipsync', 'recast',
  'audio', 'cinema', 'marketing', 't2t',
]);

export const SERVER_FEATURE_OPERATIONS = Object.freeze({
  studio: ['catalog', 'predictions'],
  workflow: ['catalog', 'predictions'],
  workflowArchitect: ['catalog', 'workflowArchitect'],
  agents: ['catalog', 'predictions'],
  designAgent: ['catalog', 'predictions'],
});
