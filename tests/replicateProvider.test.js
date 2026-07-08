import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInputMap,
  scoreSchemaCompatibility,
  deriveOutputInfo,
  inferStaticInput,
} from '../modules/providers/replicate/server/schemaCompatibility.js';
import {
  isReplicateMappingExposed,
} from '../modules/providers/replicate/server/generatedCatalog.js';
import {
  mapStudioParamsToReplicateInput,
  normalizeReplicateOutput,
  runReplicatePrediction,
} from '../modules/providers/replicate/server/run.js';
import {
  buildStudioModelNameAliases,
  scoreCandidate,
  statusFromScore,
  stripStudioModeSuffix,
  computeNameScore,
  inferReplicateOutputMedia,
  expectedOutputMedia,
  variantMismatch,
} from '../modules/providers/replicate/server/scoring.js';
import {
  parseEnvFile,
  resolveReplicateApiToken,
} from '../modules/providers/replicate/server/env.js';
import {
  classifyMigrationReason,
} from '../modules/providers/replicate/server/migrationReason.js';
import {
  buildCandidateQueries,
  buildKnownOfficialModelReferences,
  discoverModelCandidates,
  getModelReferenceFromSearchResult,
  normalizeReplicateSearchResults,
  buildReplicateModelIndex,
  findLocalIndexCandidates,
} from '../modules/providers/replicate/server/discovery.js';
import {
  replicateRequest,
} from '../modules/providers/replicate/server/client.js';
import {
  normalizeStudioModel,
} from '../modules/studio/server/studioCatalog.js';
import {
  createObjectKey,
  createPresignedGetUrl,
  signS3Request,
} from '../modules/storage/server/s3.js';

test('Replicate schema compatibility maps direct and aliased Studio inputs', () => {
  const inputMap = buildInputMap(['prompt', 'image_url', 'aspect_ratio'], {
    prompt: { type: 'string' },
    image_input: { type: 'string' },
    aspect: { type: 'string' },
  });

  assert.deepEqual(inputMap, {
    prompt: 'prompt',
    image_url: 'image_input',
    aspect_ratio: 'aspect',
  });
});

test('Replicate schema compatibility maps effect name to prompt only when prompt is absent', () => {
  assert.deepEqual(
    buildInputMap(['name', 'image_url'], {
      prompt: { type: 'string' },
      image_input: { type: 'string' },
    }),
    {
      name: 'prompt',
      image_url: 'image_input',
    }
  );

  assert.deepEqual(
    buildInputMap(['prompt', 'name'], {
      prompt: { type: 'string' },
    }),
    {
      prompt: 'prompt',
    }
  );
});

test('Replicate schema compatibility maps text-to-speech prompt aliases', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: [],
      optionalInputs: ['prompt', 'voice_id', 'format'],
    },
    {
      required: ['text'],
      properties: {
        text: { type: 'string' },
        voice_id: { type: 'string' },
        audio_format: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.deepEqual(compatibility.inputMap, {
    prompt: 'text',
    voice_id: 'voice_id',
    format: 'audio_format',
  });
});

test('Replicate schema compatibility maps voice clone audio aliases', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: ['audio_url'],
      optionalInputs: ['model'],
    },
    {
      required: ['voice_file'],
      properties: {
        voice_file: { type: 'string' },
        model: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.deepEqual(compatibility.inputMap, {
    audio_url: 'voice_file',
    model: 'model',
  });
});

test('Replicate schema compatibility prefers single and multi image fields by schema shape', () => {
  assert.deepEqual(
    buildInputMap(['image_url', 'images_list'], {
      image: { type: 'string' },
      images: { type: 'array', items: { type: 'string' } },
      reference_images: { type: 'array', items: { type: 'string' } },
    }),
    {
      image_url: 'image',
      images_list: 'images',
    }
  );

  assert.deepEqual(
    buildInputMap(['image_url'], {
      reference_images: { type: 'array', items: { type: 'string' } },
    }),
    {
      image_url: 'reference_images',
    }
  );
});

test('Replicate schema compatibility can map reference image aliases', () => {
  assert.deepEqual(
    buildInputMap(['image_url', 'images_list'], {
      reference_image: { type: 'string' },
      reference_images: { type: 'array', items: { type: 'string' } },
    }),
    {
      image_url: 'reference_image',
      images_list: 'reference_images',
    }
  );
});

test('Replicate schema compatibility maps provider-specific image aliases', () => {
  assert.deepEqual(
    buildInputMap(['image_url'], {
      character_reference_image: { type: 'string' },
    }),
    {
      image_url: 'character_reference_image',
    }
  );

  assert.deepEqual(
    buildInputMap(['image_url'], {
      redux_image: { type: 'string' },
    }),
    {
      image_url: 'redux_image',
    }
  );
});

test('Replicate schema compatibility maps provider-specific option aliases', () => {
  assert.deepEqual(
    buildInputMap(['render_speed', 'style', 'scene_description'], {
      rendering_speed: { type: 'string' },
      style_type: { type: 'string' },
      prompt: { type: 'string' },
    }),
    {
      render_speed: 'rendering_speed',
      style: 'style_type',
      scene_description: 'prompt',
    }
  );
});

test('Replicate schema compatibility can map start image aliases', () => {
  assert.deepEqual(
    buildInputMap(['image_url'], {
      start_image: { type: 'string' },
    }),
    {
      image_url: 'start_image',
    }
  );

  assert.deepEqual(
    buildInputMap(['image_url'], {
      start_frame: { type: 'string' },
    }),
    {
      image_url: 'start_frame',
    }
  );
});

test('Replicate schema compatibility reports unsupported and required inputs', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: ['prompt'],
      optionalInputs: ['image_url', 'seed'],
    },
    {
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        image: { type: 'string' },
      },
    }
  );

  assert.equal(compatibility.missingRequired.length, 0);
  assert.deepEqual(compatibility.inputMap, {
    prompt: 'prompt',
    image_url: 'image',
  });
  assert.deepEqual(compatibility.unsupportedInputs, ['seed']);
});

test('Replicate scoring promotes exact official model-name matches with required inputs', () => {
  const studioModel = {
    studioId: 'flux-schnell',
    studioName: 'Flux Schnell',
    muapiEndpoint: 'flux-schnell-image',
  };
  const compatibility = {
    score: 0.75,
    missingRequired: [],
  };
  const score = scoreCandidate({
    studioModel,
    replicateModel: {
      owner: 'black-forest-labs',
      name: 'flux-schnell',
    },
    schemaScore: compatibility.score,
  });

  assert.equal(score, 0.875);
  assert.equal(statusFromScore(score, compatibility), 'supported');
  assert.equal(statusFromScore(score, { missingRequired: ['prompt'] }), 'unsupported');
  assert.equal(statusFromScore(score, { missingRequiredStudioInputs: ['image_url'] }), 'unsupported');
});


test('Replicate discovery strips Studio mode suffixes for search queries', () => {
  assert.equal(stripStudioModeSuffix('flux-kontext-pro-t2i'), 'flux-kontext-pro');
  assert.equal(stripStudioModeSuffix('wan2.1-image-to-video'), 'wan2.1-image-to-video');

  const queries = buildCandidateQueries({
      studioId: 'flux-kontext-pro-t2i',
      studioName: 'Flux Kontext Pro',
      muapiEndpoint: 'flux-kontext-pro-t2i',
    });

  assert.ok(queries.includes('flux-kontext-pro-t2i'));
  assert.ok(queries.includes('flux-kontext-pro'));
  assert.ok(queries.includes('flux kontext pro'));
});

test('Replicate scoring compares stripped Studio mode suffixes', () => {
  const score = scoreCandidate({
    studioModel: {
      studioId: 'flux-kontext-pro-t2i',
      studioName: 'Flux Kontext Pro',
      muapiEndpoint: 'flux-kontext-pro-t2i',
    },
    replicateModel: {
      owner: 'black-forest-labs',
      name: 'flux-kontext-pro',
    },
    schemaScore: 1,
  });

  assert.equal(score, 1);
});

test('Replicate aliases strip known owner prefixes and version v markers', () => {
  const seedreamAliases = buildStudioModelNameAliases('bytedance-seedream-v3');
  assert.ok(seedreamAliases.includes('seedream-v3'));
  assert.ok(seedreamAliases.includes('seedream-3'));
  assert.ok(buildStudioModelNameAliases('seedream-5.0').includes('seedream-5'));
  assert.ok(buildStudioModelNameAliases('hidream-i1-fast').includes('hidream-l1-fast'));
  assert.ok(buildStudioModelNameAliases('minimax-voice-clone').includes('voice-cloning'));
  assert.ok(buildStudioModelNameAliases('runway-act-two-recast').includes('gen4-aleph'));

  const refs = buildKnownOfficialModelReferences({
    studioId: 'bytedance-seedream-v3',
    muapiEndpoint: 'bytedance-seedream-image',
  });
  assert.ok(refs.some((ref) => ref.owner === 'bytedance' && ref.name === 'seedream-v3'));
  assert.ok(refs.some((ref) => ref.owner === 'bytedance' && ref.name === 'seedream-3'));
  assert.ok(refs.some((ref) => ref.owner === 'bytedance' && ref.name === 'seedream-image'));
});

test('Replicate aliases split compact numeric model names and strip edit tasks', () => {
  assert.ok(buildStudioModelNameAliases('google-imagen4-ultra').includes('imagen-4-ultra'));
  assert.ok(buildStudioModelNameAliases('nano-banana-effects').includes('nano-banana'));
  assert.ok(buildStudioModelNameAliases('bytedance-seedream-edit-v4').includes('seedream-4'));
  assert.ok(buildStudioModelNameAliases('kling-v3.0-pro-text-to-video').includes('kling-v3'));
  assert.ok(buildStudioModelNameAliases('kling-v3.0-pro-text-to-video').includes('kling-v3-video'));
  assert.ok(buildStudioModelNameAliases('kling-v2.1-standard-i2v').includes('kling-v2.1'));
  assert.ok(buildStudioModelNameAliases('kling-v3.0-std-motion-control').includes('kling-v3-motion-control'));
  assert.ok(buildStudioModelNameAliases('kling-o1-reference-to-video').includes('kling-o1'));
  assert.ok(buildStudioModelNameAliases('ideogram-v3-t2i').includes('ideogram-3'));
});

test('Replicate scoring compares known-owner aliases', () => {
  const score = scoreCandidate({
    studioModel: {
      studioId: 'bytedance-seedream-v3',
      studioName: 'Seedream V3',
      muapiEndpoint: 'bytedance-seedream-image',
    },
    replicateModel: {
      owner: 'bytedance',
      name: 'seedream-3',
    },
    schemaScore: 1,
  });

  assert.equal(score, 1);
});

test('Replicate scoring compares compact numeric aliases', () => {
  const score = scoreCandidate({
    studioModel: {
      studioId: 'google-imagen4-ultra',
      studioName: 'Google Imagen4 Ultra',
      muapiEndpoint: 'google-imagen4-ultra',
    },
    replicateModel: {
      owner: 'google',
      name: 'imagen-4-ultra',
    },
    schemaScore: 1,
  });

  assert.equal(score, 1);
});

test('Replicate scoring compares provider variant aliases', () => {
  assert.equal(
    scoreCandidate({
      studioModel: {
        studioId: 'ideogram-v3-t2i',
        studioName: 'Ideogram v3 T2I',
        muapiEndpoint: 'ideogram-v3-t2i',
      },
      replicateModel: {
        owner: 'ideogram-ai',
        name: 'ideogram-v3-turbo',
      },
      schemaScore: 0.85,
    }),
    0.925
  );

  assert.equal(
    scoreCandidate({
      studioModel: {
        studioId: 'kling-v3.0-pro-text-to-video',
        studioName: 'Kling v3.0 Pro',
        muapiEndpoint: 'kling-v3.0-pro-text-to-video',
      },
      replicateModel: {
        owner: 'kwaivgi',
        name: 'kling-v3-video',
      },
      schemaScore: 1,
    }),
    1
  );
});

test('Replicate discovery builds known owner references from Studio owner aliases', () => {
  assert.deepEqual(
    buildKnownOfficialModelReferences({
      studioId: 'topaz-image-upscale',
      muapiEndpoint: 'topaz-image-upscale',
    }).slice(0, 1),
    [
      { owner: 'topazlabs', name: 'image-upscale' },
    ]
  );

  assert.ok(
    buildKnownOfficialModelReferences({
      studioId: 'kling-v3.0-pro-text-to-video',
      muapiEndpoint: 'kling-v3.0-pro-text-to-video',
    }).some((ref) => ref.owner === 'kwaivgi' && ref.name === 'kling-v3')
  );

  assert.ok(
    buildKnownOfficialModelReferences({
      studioId: 'kling-v2.1-standard-i2v',
      muapiEndpoint: 'kling-v2.1-standard-i2v',
    }).some((ref) => ref.owner === 'kwaivgi' && ref.name === 'kling-v2.1')
  );

  assert.ok(
    buildKnownOfficialModelReferences({
      studioId: 'kling-v3.0-std-motion-control',
      muapiEndpoint: 'kling-v3.0-std-motion-control',
    }).some((ref) => ref.owner === 'kwaivgi' && ref.name === 'kling-v3-motion-control')
  );

  assert.ok(
    buildKnownOfficialModelReferences({
      studioId: 'kling-o1-reference-to-video',
      muapiEndpoint: 'kling-o1-reference-to-video',
    }).some((ref) => ref.owner === 'kwaivgi' && ref.name === 'kling-o1')
  );
});

test('Replicate migration reasons distinguish lookup and mapping failures', () => {
  assert.equal(classifyMigrationReason(null, 0.85), 'no-candidates');
  assert.equal(
    classifyMigrationReason(
      {
        confidence: 0.95,
        status: 'unsupported',
        compatibility: { missingRequired: ['image'], unsupportedInputs: [] },
      },
      0.85
    ),
    'missing-required:image'
  );
  assert.equal(
    classifyMigrationReason(
      {
        confidence: 0.82,
        status: 'partial',
        compatibility: { missingRequired: [], unsupportedInputs: [] },
      },
      0.85
    ),
    'low-confidence'
  );
});

test('Studio catalog normalization infers package media fields for i2i schema matching', () => {
  const normalized = normalizeStudioModel('i2i', {
    id: 'nano-banana-edit',
    name: 'Nano Banana Edit',
    imageField: 'image_url',
    inputs: {
      prompt: { type: 'string' },
    },
  });

  assert.deepEqual(normalized.requiredInputs, ['image_url']);
  assert.deepEqual(normalized.optionalInputs, ['prompt']);
  assert.equal(normalized.inputTypes.image_url, 'string');
});

test('Studio catalog normalization infers swap media fields for i2i schema matching', () => {
  const normalized = normalizeStudioModel('i2i', {
    id: 'face-swap',
    name: 'Face Swap',
    imageField: 'image_url',
    swapField: 'swap_url',
    inputs: {},
  });

  assert.deepEqual(normalized.requiredInputs, ['image_url', 'swap_url']);
  assert.equal(normalized.inputTypes.swap_url, 'string');
});

test('Studio catalog normalization infers lipsync media fields from category', () => {
  assert.deepEqual(
    normalizeStudioModel('lipsync', {
      id: 'sync-lipsync',
      name: 'Sync Lipsync',
      category: 'video',
    }).requiredInputs,
    ['audio_url', 'video_url']
  );

  assert.deepEqual(
    normalizeStudioModel('lipsync', {
      id: 'portrait-lipsync',
      name: 'Portrait Lipsync',
      category: 'image',
    }).requiredInputs,
    ['audio_url', 'image_url']
  );
});

test('Studio catalog normalization respects model required input metadata', () => {
  const normalized = normalizeStudioModel('audio', {
    id: 'voice-clone',
    name: 'Voice Clone',
    required: ['audio_url'],
    inputs: {
      audio_url: { type: 'string' },
      prompt: { type: 'string' },
    },
  });

  assert.deepEqual(normalized.requiredInputs, ['audio_url']);
  assert.deepEqual(normalized.optionalInputs, ['prompt']);
});

test('Studio catalog normalization infers v2v image, video, and prompt fields', () => {
  const normalized = normalizeStudioModel('v2v', {
    id: 'kling-v3.0-pro-motion-control',
    name: 'Kling 3.0 Pro Motion Control',
    imageField: 'image_url',
    videoField: 'video_url',
    hasPrompt: true,
  });

  assert.deepEqual(normalized.requiredInputs, ['image_url', 'video_url']);
  assert.deepEqual(normalized.optionalInputs, ['prompt']);
  assert.equal(normalized.inputTypes.image_url, 'string');
  assert.equal(normalized.inputTypes.video_url, 'string');
  assert.equal(normalized.inputTypes.prompt, 'string');
});

test('Replicate schema compatibility maps inferred i2i image fields', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: ['image_url'],
      optionalInputs: ['prompt'],
    },
    {
      required: ['prompt', 'image'],
      properties: {
        prompt: { type: 'string' },
        image: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.deepEqual(compatibility.inputMap, {
    image_url: 'image',
    prompt: 'prompt',
  });
  assert.equal(compatibility.score, 1);
});

test('Replicate schema compatibility infers static mode selectors', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      studioId: 'kling-v3.0-pro-motion-control',
      muapiEndpoint: 'kling-v3.0-pro-motion-control',
      requiredInputs: ['image_url', 'video_url'],
      optionalInputs: ['prompt'],
    },
    {
      required: ['image', 'video'],
      properties: {
        image: { type: 'string' },
        video: { type: 'string' },
        prompt: { type: 'string' },
        mode: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.deepEqual(compatibility.inputMap, {
    image_url: 'image',
    video_url: 'video',
    prompt: 'prompt',
  });
  assert.deepEqual(compatibility.staticInput, { mode: 'pro' });
});

test('Replicate schema compatibility infers static model type selectors', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      studioId: 'hidream-i1-full',
      muapiEndpoint: 'hidream-i1-full',
      requiredInputs: ['prompt'],
      optionalInputs: [],
    },
    {
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        model_type: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.staticInput, { model_type: 'full' });
});

test('Replicate schema compatibility uses static recast prompts for required Replicate prompts', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      studioId: 'runway-act-two-recast',
      muapiEndpoint: 'runway-act-two-i2v',
      mode: 'recast',
      requiredInputs: ['image_url', 'video_url'],
      optionalInputs: ['aspect_ratio'],
    },
    {
      required: ['prompt', 'video'],
      properties: {
        prompt: { type: 'string' },
        video: { type: 'string' },
        reference_image: { type: 'string' },
        aspect_ratio: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.equal(compatibility.staticInput.prompt.includes('Recast'), true);
});

test('Replicate schema compatibility weights required inputs above optional controls', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: ['prompt'],
      optionalInputs: ['width', 'height', 'num_images'],
    },
    {
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
      },
    }
  );

  assert.equal(compatibility.score, 0.75);
  assert.deepEqual(compatibility.inputMap, { prompt: 'prompt' });
  assert.deepEqual(compatibility.unsupportedInputs, ['width', 'height', 'num_images']);
});

test('Replicate schema compatibility gates missing required Studio inputs', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: ['image_url'],
      optionalInputs: ['prompt'],
    },
    {
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.deepEqual(compatibility.missingRequiredStudioInputs, ['image_url']);
  assert.equal(statusFromScore(0.875, compatibility), 'unsupported');
});

test('Replicate generated catalog exposure does not require manual approval', () => {
  assert.equal(
    isReplicateMappingExposed({
      status: 'supported',
      reviewed: false,
    }),
    true
  );

  assert.equal(
    isReplicateMappingExposed({
      status: 'unsupported',
      reviewed: true,
    }),
    false
  );
});

test('Replicate runner maps only declared input keys and rejects missing required input', () => {
  const mapping = {
    inputMap: {
      prompt: 'prompt',
      image_url: 'image',
    },
    requiredReplicateInputs: ['prompt'],
  };

  assert.deepEqual(
    mapStudioParamsToReplicateInput(mapping, {
      prompt: 'A test',
      image_url: 'https://example.test/image.png',
      seed: 123,
    }),
    {
      prompt: 'A test',
      image: 'https://example.test/image.png',
    }
  );

  assert.throws(
    () => mapStudioParamsToReplicateInput(mapping, { image_url: 'https://example.test/image.png' }),
    (error) => {
      assert.equal(error.code, 'missing_replicate_input');
      assert.equal(error.status, 400);
      assert.match(error.message, /required mapped input "prompt" is missing/);
      return true;
    }
  );
});

test('Replicate runner includes static input values in predictions', () => {
  assert.deepEqual(
    mapStudioParamsToReplicateInput(
      {
        staticInput: { mode: 'pro' },
        inputMap: {
          image_url: 'image',
          video_url: 'video',
        },
        requiredReplicateInputs: ['image', 'video'],
      },
      {
        image_url: 'https://example.test/image.png',
        video_url: 'https://example.test/video.mp4',
      }
    ),
    {
      mode: 'pro',
      image: 'https://example.test/image.png',
      video: 'https://example.test/video.mp4',
    }
  );
});

test('Replicate runner wraps scalar Studio media values for array Replicate inputs', () => {
  assert.deepEqual(
    mapStudioParamsToReplicateInput(
      {
        inputMap: {
          image_url: 'reference_images',
          prompt: 'prompt',
        },
        replicateInputTypes: {
          reference_images: 'array',
          prompt: 'string',
        },
        requiredReplicateInputs: ['reference_images'],
      },
      {
        image_url: 'https://example.test/image.png',
        prompt: 'edit this',
      }
    ),
    {
      reference_images: ['https://example.test/image.png'],
      prompt: 'edit this',
    }
  );
});

test('Replicate output normalization handles arrays and object URL fields', () => {
  const mapping = {
    studio: { id: 'flux-schnell' },
    replicate: { owner: 'black-forest-labs', name: 'flux-schnell' },
  };

  assert.deepEqual(
    normalizeReplicateOutput(
      {
        status: 'succeeded',
        output: [{ url: 'https://example.test/a.png' }, 'https://example.test/b.png'],
      },
      mapping
    ),
    {
      url: 'https://example.test/a.png',
      outputs: ['https://example.test/a.png', 'https://example.test/b.png'],
      provider: 'replicate',
      model: 'flux-schnell',
      providerModel: 'black-forest-labs/flux-schnell',
      status: 'succeeded',
      error: null,
    }
  );
});

test('Replicate output normalization ignores non-URL scalar objects', () => {
  const mapping = {
    studio: { id: 'audio-test' },
    replicate: { owner: 'owner', name: 'model' },
  };

  assert.deepEqual(
    normalizeReplicateOutput({ status: 'succeeded', output: { text: 'not a url' } }, mapping),
    {
      url: null,
      outputs: [],
      provider: 'replicate',
      model: 'audio-test',
      providerModel: 'owner/model',
      status: 'succeeded',
      error: null,
    }
  );
});

test('Replicate runner polls successful predictions', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/predictions')) {
      return Response.json({ id: 'prediction-1', status: 'starting' });
    }
    return Response.json({
      id: 'prediction-1',
      status: 'succeeded',
      output: 'https://example.test/out.png',
    });
  };

  try {
    const result = await runReplicatePrediction({
      apiKey: 'r8_test',
      mapping: {
        studio: { id: 'flux-test' },
        replicate: { owner: 'owner', name: 'model' },
        inputMap: { prompt: 'prompt' },
        requiredReplicateInputs: ['prompt'],
      },
      params: { prompt: 'hello' },
      maxAttempts: 2,
      interval: 0,
    });

    assert.equal(result.url, 'https://example.test/out.png');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith('/models/owner/model/predictions'));
    assert.match(calls[0].options.body, /"input":\{"prompt":"hello"\}/);
    assert.doesNotMatch(calls[0].options.body, /"version"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate runner reports failed and timed-out predictions', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/predictions')) {
      return Response.json({ id: 'prediction-1', status: 'processing' });
    }
    return Response.json({ id: 'prediction-1', status: 'failed', error: 'bad input' });
  };

  const mapping = {
    studio: { id: 'flux-test' },
    replicate: { owner: 'owner', name: 'model', version: 'version-1' },
    inputMap: { prompt: 'prompt' },
    requiredReplicateInputs: ['prompt'],
  };

  try {
    await assert.rejects(
      () => runReplicatePrediction({ apiKey: 'r8_test', mapping, params: { prompt: 'hello' }, maxAttempts: 2, interval: 0 }),
      (error) => {
        assert.equal(error.code, 'provider_prediction_failed');
        assert.equal(error.status, 502);
        assert.match(error.message, /bad input/);
        assert.match(error.message, /owner\/model/);
        return true;
      }
    );

    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/predictions')) {
        return Response.json({ id: 'prediction-2', status: 'processing' });
      }
      return Response.json({ id: 'prediction-2', status: 'processing' });
    };

    await assert.rejects(
      () => runReplicatePrediction({ apiKey: 'r8_test', mapping, params: { prompt: 'hello' }, maxAttempts: 1, interval: 0 }),
      (error) => {
        assert.equal(error.code, 'provider_prediction_timeout');
        assert.equal(error.status, 504);
        assert.match(error.message, /timed out/);
        assert.match(error.message, /owner\/model/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate env parser loads token values without comments', () => {
  assert.deepEqual(
    parseEnvFile(`
      # ignored
      REPLICATE_API_TOKEN=r8_testtoken # local comment
      export OTHER_VALUE="quoted value"
    `),
    {
      REPLICATE_API_TOKEN: 'r8_testtoken',
      OTHER_VALUE: 'quoted value',
    }
  );
});

test('Replicate token resolver rejects missing, placeholder, and malformed values', () => {
  assert.throws(() => resolveReplicateApiToken({}), /required/);
  assert.throws(
    () => resolveReplicateApiToken({ REPLICATE_API_TOKEN: 'r8_replace-with-your-replicate-api-token' }),
    /example value/
  );
  assert.throws(() => resolveReplicateApiToken({ REPLICATE_API_TOKEN: 'not-a-token' }), /invalid format/);
  assert.equal(resolveReplicateApiToken({ REPLICATE_API_TOKEN: ' r8_validToken_123 ' }), 'r8_validToken_123');
});

test('Replicate discovery extracts model refs from multiple search result shapes', () => {
  assert.deepEqual(
    getModelReferenceFromSearchResult({
      type: 'model',
      object: { owner: 'black-forest-labs', name: 'flux-schnell' },
    }),
    { owner: 'black-forest-labs', name: 'flux-schnell' }
  );

  assert.deepEqual(
    getModelReferenceFromSearchResult({
      type: 'model',
      url: 'https://replicate.com/stability-ai/sdxl',
    }),
    { owner: 'stability-ai', name: 'sdxl' }
  );

  assert.deepEqual(
    getModelReferenceFromSearchResult({
      type: 'model',
      identifier: 'replicate/hello-world',
    }),
    { owner: 'replicate', name: 'hello-world' }
  );
});

test('Replicate discovery normalizes paginated and array search responses', () => {
  assert.deepEqual(
    normalizeReplicateSearchResults({
      results: [
        { type: 'collection', url: 'https://replicate.com/collections/image' },
        { type: 'model', model: { owner: 'owner-a', name: 'model-a' } },
        { type: 'model', model: { owner: 'owner-a', name: 'model-a' } },
        { owner: 'owner-b', name: 'model-b' },
      ],
    }),
    [
      { owner: 'owner-a', name: 'model-a' },
      { owner: 'owner-b', name: 'model-b' },
    ]
  );

  assert.deepEqual(
    normalizeReplicateSearchResults([
      { full_name: 'owner-c/model-c' },
    ]),
    [{ owner: 'owner-c', name: 'model-c' }]
  );
});

test('Replicate discovery includes community search hits', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);

    if (value.includes('/search?')) {
      return Response.json({
        results: [
          { type: 'model', model: { owner: 'community-user', name: 'aurora-diffuse' } },
          { type: 'model', model: { owner: 'acme-labs', name: 'aurora-diffuse' } },
        ],
      });
    }

    if (value.endsWith('/models/community-user/aurora-diffuse')) {
      return Response.json({
        owner: 'community-user',
        name: 'aurora-diffuse',
        latest_version: {
          openapi_schema: {
            components: {
              schemas: {
                Input: {
                  required: ['prompt'],
                  properties: { prompt: { type: 'string' } },
                },
              },
            },
          },
        },
      });
    }

    return Response.json({
      owner: 'acme-labs',
      name: 'aurora-diffuse',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                required: ['prompt'],
                properties: { prompt: { type: 'string' } },
              },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'aurora-diffuse',
        studioName: 'Aurora Diffuse',
        muapiEndpoint: 'aurora-diffuse',
        requiredInputs: ['prompt'],
        optionalInputs: ['width'],
      }
    );

    const owners = candidates.map((candidate) => candidate.model.owner);
    assert.equal(candidates.length, 2);
    assert.ok(owners.includes('acme-labs'));
    assert.ok(owners.includes('community-user'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery reuses an in-run model cache across Studio models', async () => {
  const originalFetch = globalThis.fetch;
  const modelFetches = [];
  globalThis.fetch = async (url) => {
    const value = String(url);

    if (value.includes('/search?')) {
      return Response.json({
        results: [{ type: 'model', model: { owner: 'google', name: 'shared-model' } }],
      });
    }

    modelFetches.push(value);
    return Response.json({
      owner: 'google',
      name: 'shared-model',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                required: ['prompt'],
                properties: { prompt: { type: 'string' } },
              },
            },
          },
        },
      },
    });
  };

  try {
    const modelCache = new Map();
    const studioModel = {
      studioId: 'shared-model',
      studioName: 'Shared Model',
      muapiEndpoint: 'shared-model',
      requiredInputs: ['prompt'],
      optionalInputs: [],
    };

    const first = await discoverModelCandidates('r8_test', studioModel, { modelCache });
    const second = await discoverModelCandidates(
      'r8_test',
      { ...studioModel, studioId: 'shared-model-2' },
      { modelCache }
    );

    assert.equal(modelFetches.length, 1);
    assert.equal(first.stats.fetches, 1);
    assert.equal(second.stats.fetches, 0);
    assert.equal(second.stats.cacheHits, 1);
    assert.equal(second[0].model.owner, 'google');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery tries inferred official owner model refs', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);

    if (value.includes('/search?')) {
      return Response.json({ results: [] });
    }

    if (value.endsWith('/models/bytedance/seedream-v3')) {
      return Response.json({ detail: 'not found' }, { status: 404 });
    }

    return Response.json({
      owner: 'bytedance',
      name: 'seedream-3',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                required: ['prompt'],
                properties: { prompt: { type: 'string' } },
              },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'bytedance-seedream-v3',
        studioName: 'Seedream V3',
        muapiEndpoint: 'bytedance-seedream-image',
        requiredInputs: ['prompt'],
        optionalInputs: [],
      }
    );

    assert.equal(candidates[0].model.owner, 'bytedance');
    assert.equal(candidates[0].model.name, 'seedream-3');
    assert.ok(requested.some((url) => url.endsWith('/models/bytedance/seedream-3')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery short-circuits supported direct refs before search', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);

    if (value.includes('/search?')) {
      throw new Error('Search should not run after a supported direct ref.');
    }

    return Response.json({
      owner: 'topazlabs',
      name: 'image-upscale',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                required: ['image'],
                properties: {
                  image: { type: 'string' },
                  upscale_factor: { type: 'string' },
                },
              },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'topaz-image-upscale',
        studioName: 'Topaz Image Upscale',
        muapiEndpoint: 'topaz-image-upscale',
        requiredInputs: ['image_url'],
        optionalInputs: ['upscale_factor'],
      }
    );

    assert.equal(candidates[0].model.owner, 'topazlabs');
    assert.equal(candidates[0].model.name, 'image-upscale');
    assert.equal(candidates.stats.searches, 0);
    assert.equal(candidates.stats.shortCircuited, true);
    assert.ok(requested.some((url) => url.endsWith('/models/topazlabs/image-upscale')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery honors candidate limits for search refs', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (url) => {
    const value = String(url);

    if (value.includes('/search?')) {
      return Response.json({
        results: [
          { type: 'model', model: { owner: 'google', name: 'model-a' } },
          { type: 'model', model: { owner: 'google', name: 'model-b' } },
          { type: 'model', model: { owner: 'google', name: 'model-c' } },
        ],
      });
    }

    requestedModels.push(value);
    return Response.json({
      owner: 'google',
      name: value.split('/').pop(),
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                required: ['prompt'],
                properties: { prompt: { type: 'string' } },
              },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'unknown-test-model',
        studioName: 'Unknown Test Model',
        muapiEndpoint: 'unknown-test-model',
        requiredInputs: ['prompt'],
        optionalInputs: [],
      },
      { candidateLimit: 2, strongMatchConfidence: 2 }
    );

    assert.equal(candidates.stats.fetches, 2);
    assert.equal(requestedModels.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery stops when search budget is reached', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);

    if (value.includes('/search?')) {
      return Response.json({
        results: [
          { type: 'model', model: { owner: 'google', name: 'bad-model' } },
        ],
      });
    }

    return Response.json({
      owner: 'google',
      name: 'bad-model',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                required: ['not_prompt'],
                properties: { not_prompt: { type: 'string' } },
              },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'unknown-budget-model',
        studioName: 'Unknown Budget Model',
        muapiEndpoint: 'unknown-budget-model',
        requiredInputs: ['prompt'],
        optionalInputs: [],
      },
      { maxSearches: 1, candidateLimit: 1 }
    );

    assert.equal(candidates.stats.searches, 1);
    assert.equal(candidates.stats.budgetStopped, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate client retries retriable status codes and honors Retry-After', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response('{"detail":"rate limited"}', {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }
    return Response.json({ ok: true });
  };

  try {
    const result = await replicateRequest('r8_test', '/models/owner/name');
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate client stops retrying after maxRetries and surfaces the error', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"detail":"boom"}', {
      status: 503,
      headers: { 'retry-after': '0' },
    });
  };

  try {
    await assert.rejects(
      () => replicateRequest('r8_test', '/models/owner/name', { maxRetries: 2 }),
      (error) => {
        assert.equal(error.status, 503);
        assert.match(error.message, /boom/);
        return true;
      }
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate client does not retry non-retriable client errors', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"detail":"not found"}', { status: 404 });
  };

  try {
    await assert.rejects(() => replicateRequest('r8_test', '/models/owner/missing'));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery runs candidate queries in parallel batches', async () => {
  const originalFetch = globalThis.fetch;
  let inFlightSearches = 0;
  let maxConcurrentSearches = 0;
  globalThis.fetch = async () => {
    inFlightSearches += 1;
    maxConcurrentSearches = Math.max(maxConcurrentSearches, inFlightSearches);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlightSearches -= 1;
    return Response.json({ results: [] });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'unknown-parallel-model',
        studioName: 'Unknown Parallel Model',
        muapiEndpoint: 'unknown-parallel-model',
        requiredInputs: ['prompt'],
        optionalInputs: [],
      },
      { queryConcurrency: 3, maxSearches: 3, candidateLimit: 1 }
    );

    assert.equal(candidates.length, 0);
    assert.ok(maxConcurrentSearches > 1, 'expected overlapping search requests');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate scoring gates supported status behind a minimum name similarity', () => {
  const compatibility = { missingRequired: [], missingRequiredStudioInputs: [] };

  // High combined score but a weak name match must not be promoted to supported (#2).
  assert.equal(statusFromScore(0.9, compatibility, { nameScore: 0.2 }), 'partial');
  assert.equal(statusFromScore(0.9, compatibility, { nameScore: 0.9 }), 'supported');
  // Backwards-compatible 2-arg form keeps the previous behaviour.
  assert.equal(statusFromScore(0.9, compatibility), 'supported');
});

test('Replicate scoring rejects a variant/tier mismatch and prefers the matching tier', () => {
  const studioModel = {
    studioId: 'flux-2-dev',
    studioName: 'Flux 2 Dev',
    muapiEndpoint: 'flux-2-dev',
  };

  // Dev Studio model vs Pro Replicate model is a different product.
  assert.equal(variantMismatch(studioModel, { owner: 'black-forest-labs', name: 'flux-2-pro' }), true);
  // Dev Studio model vs Dev Replicate model matches.
  assert.equal(variantMismatch(studioModel, { owner: 'black-forest-labs', name: 'flux-2-dev' }), false);
  // A tier-less Replicate base model is never treated as a conflict.
  assert.equal(variantMismatch(studioModel, { owner: 'black-forest-labs', name: 'flux-2' }), false);

  // The mismatched tier can never be promoted to `supported` even with a perfect score.
  assert.equal(
    statusFromScore(1, { missingRequired: [], missingRequiredStudioInputs: [] }, {
      nameScore: 1,
      variantConflict: true,
    }),
    'unsupported'
  );

  // The mismatched tier is penalised so the correctly-tiered candidate outranks it.
  const proScore = scoreCandidate({
    studioModel,
    replicateModel: { owner: 'black-forest-labs', name: 'flux-2-pro' },
    schemaScore: 1,
  });
  const devScore = scoreCandidate({
    studioModel,
    replicateModel: { owner: 'black-forest-labs', name: 'flux-2-dev' },
    schemaScore: 1,
  });
  assert.ok(devScore > proScore);
});

test('Replicate discovery builds direct official refs for owner-less families', () => {
  const refs = buildKnownOfficialModelReferences({
    studioId: 'flux-kontext-pro-i2i',
    muapiEndpoint: 'flux-kontext-pro-i2i',
  });

  assert.ok(refs.some((ref) => ref.owner === 'black-forest-labs' && ref.name === 'flux-kontext-pro'));

  const fluxDevRefs = buildKnownOfficialModelReferences({
    studioId: 'flux-2-dev',
    muapiEndpoint: 'flux-2-dev',
  });
  assert.ok(fluxDevRefs.some((ref) => ref.owner === 'black-forest-labs' && ref.name === 'flux-2-dev'));
});

test('Replicate scoring rejects candidates with a confident output-media conflict', () => {
  const compatibility = { missingRequired: [], missingRequiredStudioInputs: [] };

  // A video-mode Studio model matched against an image model is disqualified (#4).
  assert.equal(statusFromScore(0.95, compatibility, { nameScore: 1, mediaConflict: true }), 'unsupported');
  assert.equal(statusFromScore(0.95, compatibility, { nameScore: 1, mediaConflict: false }), 'supported');
});

test('Replicate media inference only fires on unambiguous signals', () => {
  assert.equal(expectedOutputMedia('t2v'), 'video');
  assert.equal(expectedOutputMedia('t2i'), 'image');
  assert.equal(expectedOutputMedia('audio'), 'audio');
  assert.equal(inferReplicateOutputMedia({ owner: 'x', name: 'photo-maker', description: 'Generate images' }), 'image');
  assert.equal(inferReplicateOutputMedia({ owner: 'x', name: 'wan-video', description: 'text to video' }), 'video');
  // Ambiguous ("image-to-video" mentions both) returns null so no false conflict is raised.
  assert.equal(inferReplicateOutputMedia({ owner: 'x', name: 'svd', description: 'image-to-video model' }), null);
});

test('Replicate discovery downgrades an image model for a video-mode Studio model', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/search?')) {
      return Response.json({ results: [{ type: 'model', model: { owner: 'acme', name: 'photo-maker' } }] });
    }
    return Response.json({
      owner: 'acme',
      name: 'photo-maker',
      description: 'Generate beautiful images from text',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: { required: ['prompt'], properties: { prompt: { type: 'string' } } },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'photo-maker',
        studioName: 'Photo Maker',
        muapiEndpoint: 'photo-maker',
        mode: 't2v',
        requiredInputs: ['prompt'],
        optionalInputs: [],
      },
      { strongMatchConfidence: 2 }
    );

    assert.equal(candidates[0].status, 'unsupported');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate schema compatibility fills required selectors from schema defaults and enums', () => {
  const compatibility = scoreSchemaCompatibility(
    {
      requiredInputs: ['prompt'],
      optionalInputs: [],
    },
    {
      required: ['prompt', 'aspect_ratio', 'output_format'],
      properties: {
        prompt: { type: 'string' },
        aspect_ratio: { type: 'string', default: '16:9' },
        output_format: { type: 'string', enum: ['png', 'jpg'] },
      },
    }
  );

  assert.deepEqual(compatibility.missingRequired, []);
  assert.equal(compatibility.staticInput.aspect_ratio, '16:9');
  assert.equal(compatibility.staticInput.output_format, 'png');
});

test('Replicate static input inference never fabricates mapped or media inputs', () => {
  const staticInput = inferStaticInput(
    { requiredInputs: [], optionalInputs: [] },
    {
      required: ['prompt', 'image'],
      properties: {
        prompt: { type: 'string', default: 'hello' },
        image: { type: 'string', format: 'uri' },
      },
    },
    new Set(['prompt'])
  );

  // prompt is already mapped -> skipped; image has no default/enum -> not fabricated.
  assert.equal(staticInput.prompt, undefined);
  assert.equal(staticInput.image, undefined);
});

test('Replicate output info derivation reads path and shape from the Output schema', () => {
  assert.deepEqual(deriveOutputInfo({ type: 'array', items: { type: 'string' } }), { path: '$', shape: 'array' });
  assert.deepEqual(deriveOutputInfo({ type: 'string', format: 'uri' }), { path: '$', shape: 'scalar' });
  assert.deepEqual(
    deriveOutputInfo({ type: 'object', properties: { video: { type: 'string', format: 'uri' } } }),
    { path: '$.video', shape: 'object' }
  );
  assert.deepEqual(deriveOutputInfo(null), { path: '$', shape: 'unknown' });
});

test('Replicate runner extracts nested output values via the schema-derived path', () => {
  const mapping = {
    studio: { id: 'kling' },
    replicate: { owner: 'kwaivgi', name: 'kling' },
    output: { type: 'video', path: '$.video' },
  };

  assert.deepEqual(
    normalizeReplicateOutput({ status: 'succeeded', output: { video: 'https://example.test/out.mp4' } }, mapping),
    {
      url: 'https://example.test/out.mp4',
      outputs: ['https://example.test/out.mp4'],
      provider: 'replicate',
      model: 'kling',
      providerModel: 'kwaivgi/kling',
      status: 'succeeded',
      error: null,
    }
  );

  // Falls back to the whole output when the path does not resolve.
  assert.equal(
    normalizeReplicateOutput(
      { status: 'succeeded', output: 'https://example.test/plain.mp4' },
      mapping
    ).url,
    'https://example.test/plain.mp4'
  );
});

test('Replicate discovery caps candidate queries to a top-N set', () => {
  const queries = buildCandidateQueries(
    {
      studioId: 'kling-v3.0-pro-text-to-video',
      studioName: 'Kling v3.0 Pro',
      muapiEndpoint: 'kling-v3.0-pro-text-to-video',
    },
    { maxQueries: 5 }
  );

  assert.equal(queries.length, 5);
  assert.equal(queries[0], 'kling-v3.0-pro-text-to-video');
});

test('Replicate bulk index paginates and matches candidates locally', async () => {
  const originalFetch = globalThis.fetch;
  const pages = [
    {
      results: [{ owner: 'black-forest-labs', name: 'flux-schnell', description: 'fast image model' }],
      next: 'https://api.replicate.com/v1/models?cursor=2',
    },
    {
      results: [{ owner: 'stability-ai', name: 'sdxl', description: 'image model' }],
      next: null,
    },
  ];
  let call = 0;
  globalThis.fetch = async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return Response.json(page);
  };

  try {
    const index = await buildReplicateModelIndex('r8_test', { maxPages: 5 });
    assert.equal(index.length, 2);
    assert.equal(call, 2);

    const refs = findLocalIndexCandidates(
      { studioId: 'flux-schnell', studioName: 'Flux Schnell', muapiEndpoint: 'flux-schnell-image' },
      index,
      3
    );
    assert.equal(refs[0].owner, 'black-forest-labs');
    assert.equal(refs[0].name, 'flux-schnell');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate discovery uses the official index before spending search calls', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);
    if (value.includes('/search?')) {
      throw new Error('Search should not run when an indexed supported match exists.');
    }
    return Response.json({
      owner: 'acme-labs',
      name: 'aurora-diffuse',
      latest_version: {
        openapi_schema: {
          components: {
            schemas: {
              Input: { required: ['prompt'], properties: { prompt: { type: 'string' } } },
            },
          },
        },
      },
    });
  };

  try {
    const candidates = await discoverModelCandidates(
      'r8_test',
      {
        studioId: 'aurora-diffuse',
        studioName: 'Aurora Diffuse',
        muapiEndpoint: 'aurora-diffuse',
        requiredInputs: ['prompt'],
        optionalInputs: [],
      },
      {
        officialIndex: [{ owner: 'acme-labs', name: 'aurora-diffuse', description: '' }],
      }
    );

    assert.equal(candidates[0].model.owner, 'acme-labs');
    assert.equal(candidates.stats.searches, 0);
    assert.equal(candidates.stats.shortCircuited, true);
    assert.ok(candidates.stats.indexMatches >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate name score computation exposes reusable name similarity', () => {
  assert.equal(
    computeNameScore(
      { studioId: 'flux-schnell', studioName: 'Flux Schnell', muapiEndpoint: 'flux-schnell-image' },
      { owner: 'black-forest-labs', name: 'flux-schnell' }
    ),
    1
  );
  assert.equal(
    computeNameScore(
      { studioId: 'flux-schnell', studioName: 'Flux Schnell', muapiEndpoint: 'flux-schnell-image' },
      { owner: 'zzz', name: 'totally-different' }
    ),
    0
  );
});

test('S3 upload helpers create safe object keys and signed URLs', () => {
  const key = createObjectKey({
    userId: 'user-1',
    filename: '../bad name.png',
    date: new Date('2026-07-02T12:00:00.000Z'),
  });

  assert.match(key, /^studio-uploads\/user-1\/2026\/07\/02\/[0-9a-f-]+-bad-name\.png$/);

  const config = {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'aistudio',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    forcePathStyle: true,
    signedUrlTtlSeconds: 60,
  };

  const url = createPresignedGetUrl({
    config,
    key: 'studio-uploads/user-1/file.png',
    date: new Date('2026-07-02T12:00:00.000Z'),
  });

  assert.match(url, /^http:\/\/localhost:9000\/aistudio\/studio-uploads\/user-1\/file\.png\?/);
  assert.match(url, /X-Amz-Signature=/);

  const headers = signS3Request({
    method: 'PUT',
    url: new URL('http://localhost:9000/aistudio/studio-uploads/user-1/file.png'),
    region: 'us-east-1',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    payloadHash: 'abc123',
    headers: { 'content-type': 'image/png' },
    date: new Date('2026-07-02T12:00:00.000Z'),
  });

  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=minioadmin\/20260702\/us-east-1\/s3\/aws4_request/);
  assert.equal(headers['x-amz-date'], '20260702T120000Z');
});
