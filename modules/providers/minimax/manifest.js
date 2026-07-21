import { publicManifest } from '../core/publicManifest.js';

export const minimaxManifest = publicManifest({
  id: 'minimax',
  label: 'MiniMax',
  description: 'Run MiniMax language, image, video, speech, voice, and music models.',
  credential: {
    label: 'API key',
    placeholder: 'Enter your MiniMax API key',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    required: true,
  },
  features: {
    studio: true,
    workflow: true,
    workflowArchitect: false,
    agents: true,
    designAgent: true,
    clipping: false,
    vibeMotion: false,
    apps: false,
  },
  modes: ['t2t', 't2i', 'i2i', 't2v', 'i2v', 'audio'],
});
