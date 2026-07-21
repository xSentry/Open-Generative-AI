import { minimaxTextModelIds } from './generatedTextModels.js';

const stringInput = (description, options = {}) => ({ type: 'string', description, ...options });
const numberInput = (description, options = {}) => ({ type: 'number', description, ...options });
const integerInput = (description, options = {}) => ({ type: 'integer', description, ...options });
const booleanInput = (description, options = {}) => ({ type: 'boolean', description, ...options });

const prompt = stringInput('Generation prompt.', { required: true });
const imageUrl = stringInput('Public HTTPS image URL.', { field: 'image_url', mediaKind: 'image', required: true });
const audioUrl = stringInput('Public HTTPS audio URL.', { field: 'audio_url', mediaKind: 'audio', required: true });

const textDescriptions = {
  'MiniMax-M3': 'Latest agentic language model with text, image, and video input.',
  'MiniMax-M2.7': 'Agentic reasoning and coding model.',
  'MiniMax-M2.7-highspeed': 'Faster MiniMax M2.7 variant.',
  'MiniMax-M2.5': 'Complex reasoning and coding model.',
  'MiniMax-M2.5-highspeed': 'Faster MiniMax M2.5 variant.',
  'MiniMax-M2.1': 'Multilingual programming and reasoning model.',
  'MiniMax-M2.1-highspeed': 'Faster MiniMax M2.1 variant.',
  'MiniMax-M2': 'Agentic language model with advanced reasoning.',
};

export function createTextModel(nativeId) {
  const supportsMedia = nativeId === 'MiniMax-M3';
  return {
    id: nativeId.toLowerCase(),
    name: nativeId,
    description: textDescriptions[nativeId] || 'MiniMax language model.',
    endpoint: nativeId,
    outputKind: 'text',
    metadata: { nativeId, operation: 'anthropic-messages' },
    inputs: {
      prompt,
      system: stringInput('Optional system instruction.'),
      max_tokens: integerInput('Maximum output tokens.', { default: 4096, minimum: 1, maximum: 204800 }),
      temperature: numberInput('Sampling temperature.', { default: 1, minimum: 0, maximum: 2 }),
      top_p: numberInput('Nucleus sampling probability.', { default: 0.95, minimum: 0, maximum: 1 }),
      thinking: booleanInput('Enable adaptive thinking where supported.', { default: false }),
      ...(supportsMedia ? {
        image_url: stringInput('Optional image URL for visual understanding.', { field: 'image_url', mediaKind: 'image' }),
        video_url: stringInput('Optional video URL for visual understanding.', { field: 'video_url', mediaKind: 'video' }),
      } : {}),
    },
    required: ['prompt'],
  };
}

const imageInputs = {
  prompt,
  aspect_ratio: stringInput('Output aspect ratio.', { default: '1:1', enum: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'] }),
  width: integerInput('Custom width; set with height.', { minimum: 512, maximum: 2048 }),
  height: integerInput('Custom height; set with width.', { minimum: 512, maximum: 2048 }),
  seed: integerInput('Optional random seed.'),
  n: integerInput('Number of images.', { default: 1, minimum: 1, maximum: 9 }),
  prompt_optimizer: booleanInput('Optimize the prompt automatically.', { default: false }),
};

function imageModel(mode, nativeId = 'image-01') {
  return {
    id: mode === 't2i' ? nativeId : `${nativeId}-subject-reference`,
    name: mode === 't2i' ? `${nativeId} Text to Image` : `${nativeId} Subject Reference`,
    description: mode === 't2i' ? 'Generate images from text.' : 'Generate images while preserving a referenced character.',
    endpoint: '/v1/image_generation',
    outputKind: 'image',
    metadata: { nativeId, operation: 'image-generation' },
    inputs: mode === 't2i' ? imageInputs : { ...imageInputs, image_url: imageUrl },
    required: mode === 't2i' ? ['prompt'] : ['prompt', 'image_url'],
  };
}

const videoInputs = {
  prompt,
  duration: integerInput('Video duration in seconds.', { default: 6, enum: [6, 10] }),
  resolution: stringInput('Output resolution.', { default: '1080P', enum: ['512P', '768P', '1080P'] }),
  prompt_optimizer: booleanInput('Optimize the prompt automatically.', { default: true }),
};

function videoModel(mode, nativeId, options = {}) {
  return {
    id: options.appId || `${nativeId.toLowerCase()}-${mode}`,
    name: `${nativeId} ${mode.toUpperCase()}`,
    description: options.description || (mode === 't2v' ? 'Generate video from text.' : 'Generate video from an image.'),
    endpoint: '/v1/video_generation',
    outputKind: 'video',
    metadata: { nativeId, operation: 'video-generation', subjectReference: options.subjectReference === true },
    inputs: {
      ...videoInputs,
      ...(mode === 'i2v' ? { image_url: imageUrl } : {}),
      ...(options.lastFrame ? { last_image: stringInput('Public HTTPS final-frame image URL.', { field: 'image_url', mediaKind: 'image' }) } : {}),
    },
    required: mode === 't2v' ? ['prompt'] : ['image_url'],
  };
}

const ttsModels = [
  'speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo',
  'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo',
].map((nativeId) => ({
  id: nativeId,
  name: nativeId,
  description: 'Convert text to speech with a system or custom voice.',
  endpoint: '/v1/t2a_v2',
  outputKind: 'audio',
  metadata: { nativeId, operation: 'text-to-speech' },
  inputs: {
    text: stringInput('Text to synthesize (up to 10,000 characters).', { required: true }),
    voice_id: stringInput('System, cloned, or designed voice ID.', { default: 'English_expressive_narrator', required: true }),
    speed: numberInput('Speech speed.', { default: 1, minimum: 0.5, maximum: 2 }),
    volume: numberInput('Speech volume.', { default: 1, minimum: 0.1, maximum: 10 }),
    pitch: integerInput('Voice pitch adjustment.', { default: 0, minimum: -12, maximum: 12 }),
    language_boost: stringInput('Language recognition boost.', { default: 'auto' }),
    format: stringInput('Audio format.', { default: 'mp3', enum: ['mp3', 'wav', 'flac'] }),
    sample_rate: integerInput('Audio sample rate.', { default: 32000, enum: [16000, 24000, 32000, 44100] }),
    bitrate: integerInput('Audio bitrate.', { default: 128000, enum: [32000, 64000, 128000, 256000] }),
    channel: integerInput('Audio channels.', { default: 1, enum: [1, 2] }),
  },
  required: ['text', 'voice_id'],
}));

const voiceOperations = [
  {
    id: 'voice-clone', name: 'Voice Clone', description: 'Clone a voice from reference audio.', endpoint: '/v1/voice_clone',
    metadata: { nativeId: 'voice-clone', operation: 'voice-clone' }, outputKind: 'audio',
    inputs: {
      audio_url: audioUrl,
      voice_id: stringInput('New custom voice ID.', { required: true }),
      model: stringInput('Speech model used for the optional preview.', { default: 'speech-2.8-hd', enum: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'] }),
      text: stringInput('Optional preview text (charged as TTS).'),
      prompt_audio_url: stringInput('Optional short prompt-audio URL.', { mediaKind: 'audio' }),
      prompt_text: stringInput('Transcript for prompt audio.'),
      need_noise_reduction: booleanInput('Reduce noise in the source.', { default: false }),
      need_volume_normalization: booleanInput('Normalize source volume.', { default: false }),
    }, required: ['audio_url', 'voice_id'],
  },
  {
    id: 'voice-design', name: 'Voice Design', description: 'Design a voice from a natural-language description.', endpoint: '/v1/voice_design',
    metadata: { nativeId: 'voice-design', operation: 'voice-design' }, outputKind: 'audio',
    inputs: { prompt: stringInput('Voice description.', { required: true }), preview_text: stringInput('Preview text (up to 500 characters).', { required: true }) },
    required: ['prompt', 'preview_text'],
  },
  {
    id: 'voice-list', name: 'List Voices', description: 'List voices available to the current MiniMax account.', endpoint: '/v1/get_voice',
    metadata: { nativeId: 'voice-list', operation: 'voice-list' }, outputKind: 'text',
    inputs: { voice_type: stringInput('Voice category.', { default: 'all', enum: ['system', 'voice_cloning', 'voice_generation', 'music_generation', 'all'] }) }, required: [],
  },
  {
    id: 'voice-delete', name: 'Delete Voice', description: 'Delete a cloned or designed voice.', endpoint: '/v1/delete_voice',
    metadata: { nativeId: 'voice-delete', operation: 'voice-delete' }, outputKind: 'text',
    inputs: { voice_type: stringInput('Voice category.', { required: true, enum: ['voice_cloning', 'voice_generation'] }), voice_id: stringInput('Voice ID to delete.', { required: true }) },
    required: ['voice_type', 'voice_id'],
  },
];

const musicModels = ['music-3.0', 'music-3.0-free', 'music-2.6', 'music-2.6-free', 'music-cover', 'music-cover-free'].map((nativeId) => {
  const cover = nativeId.includes('cover');
  return {
    id: nativeId,
    name: nativeId,
    description: cover ? 'Generate a cover from reference audio.' : 'Generate vocal or instrumental music.',
    endpoint: '/v1/music_generation',
    outputKind: 'audio',
    metadata: { nativeId, operation: 'music-generation' },
    inputs: {
      prompt: stringInput('Style, mood, and scenario.', { required: true }),
      lyrics: stringInput('Structured song lyrics.'),
      ...(cover ? { audio_url: audioUrl, cover_feature_id: stringInput('Optional feature ID from cover preprocessing.') } : {
        lyrics_optimizer: booleanInput('Generate lyrics from the prompt.', { default: false }),
        is_instrumental: booleanInput('Generate without vocals.', { default: false }),
      }),
      format: stringInput('Audio format.', { default: 'mp3', enum: ['mp3', 'wav', 'pcm'] }),
      sample_rate: integerInput('Audio sample rate.', { default: 44100, enum: [16000, 24000, 32000, 44100] }),
      bitrate: integerInput('Audio bitrate.', { default: 256000, enum: [32000, 64000, 128000, 256000] }),
    },
    required: cover ? ['prompt', 'audio_url'] : ['prompt'],
  };
});

export const minimaxModelLists = Object.freeze({
  t2t: minimaxTextModelIds.map(createTextModel),
  t2i: [imageModel('t2i')],
  i2i: [imageModel('i2i'), imageModel('i2i', 'image-01-live')],
  t2v: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'T2V-01'].map((id) => videoModel('t2v', id)),
  i2v: [
    ...['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02', 'I2V-01-Director', 'I2V-01-live', 'I2V-01'].map((id) => videoModel('i2v', id)),
    videoModel('i2v', 'MiniMax-Hailuo-02', { appId: 'minimax-hailuo-02-first-last-frame', lastFrame: true, description: 'Generate video between first and last frames.' }),
    videoModel('i2v', 'S2V-01', { subjectReference: true, description: 'Generate video with a consistent referenced character.' }),
  ],
  audio: [...ttsModels, ...voiceOperations, ...musicModels],
});
