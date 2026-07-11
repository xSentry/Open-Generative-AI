import { generateWorkflowDef } from './architect.js';
import * as architectRepo from './architectRepo.js';

export async function processArchitectRequest(requestId, options = {}) {
  const deps = {
    ...architectRepo,
    generateWorkflowDef,
    ...(options.deps || {}),
  };
  const req = await deps.getArchitectRequest(requestId);
  if (!req || req.status !== 'processing') return null;

  try {
    const result = await deps.generateWorkflowDef({
      prompt: req.prompt,
      history: options.history || [],
      provider: req.provider,
    });
    await deps.updateArchitectRequest(req.id, { status: 'completed', result, error: null });
    return { status: 'completed', result };
  } catch (error) {
    const message = error?.message || 'Workflow architect failed.';
    await deps.updateArchitectRequest(req.id, { status: 'failed', error: message });
    return { status: 'failed', error: message };
  }
}
