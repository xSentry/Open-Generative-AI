// Server-side Replicate prediction runner.
//
// Mirrors modules/providers/muapi/server/run.js (runMuapiPrediction): it takes
// a resolved model from replicateModels.js plus the raw params the Studio UI
// submits, runs a synchronous prediction against the Replicate API and returns
// a normalized { url, outputs, provider } result.
//
// The result intentionally omits `id` / `request_id` so the muapi.js client
// helper (submitAndPoll) treats it as an already-completed response and does
// not attempt to poll the muapi predictions endpoint.

const REPLICATE_API = 'https://api.replicate.com/v1';

// System instruction injected for Replicate "recast" (Body Swap) generations.
// Unlike MuAPI — where a dedicated endpoint (e.g. runway-act-two-i2v) encodes
// the swap task server-side — Replicate exposes general prompt-driven video
// models under the recast mode. When such a model accepts a prompt, it has no
// inherent notion of "swap the character", so we prepend a task instruction.
// The user's own prompt is appended afterwards so they can still steer the
// result (e.g. pick which person to replace when several appear, or fine-tune
// the swap).
const RECAST_SYSTEM_PROMPT =
  'Body swap task: take the character from the reference image and map them onto the person in the source video. ' +
  "Replace that person's appearance and identity with the reference character while preserving the original motion, " +
  'body pose, timing, camera movement, lighting, and overall scene.';

// Generic keys the Studio components post for media, mapped onto the model's
// actual Replicate input field via model.imageField/swapField/etc.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Locate the model's free-text prompt input. Models name it inconsistently
// (e.g. "prompt" or "instruction_prompt"), so fall back to any string-typed
// field whose key contains "prompt". Returns null when the model has none.
function findPromptField(model) {
  const inputs = model?.inputs || {};
  if (inputs.prompt) return 'prompt';
  for (const [key, input] of Object.entries(inputs)) {
    if (input?.type === 'string' && /prompt/i.test(key)) return key;
  }
  return null;
}

// For recast (Body Swap) generations only: compose the task system prompt with
// any user-supplied prompt so the model understands it should map the reference
// character onto the person in the source video. No-op unless the mode is
// "recast" and the model actually accepts a prompt (model.hasPrompt).
function applyRecastSystemPrompt(model, input, mode) {
  if (mode !== 'recast') return;
  if (!model?.hasPrompt) return;
  const field = findPromptField(model);
  if (!field) return;
  const userPrompt = typeof input[field] === 'string' ? input[field].trim() : '';
  input[field] = userPrompt
    ? `${RECAST_SYSTEM_PROMPT} Additional user direction: ${userPrompt}`
    : RECAST_SYSTEM_PROMPT;
}

function firstOf(value) {
  return Array.isArray(value) && value.length > 0 ? value[0] : undefined;
}

function coerceMediaValue(schema, singleValue, listValue) {
  const isArray = schema?.type === 'array';
  if (isArray) {
    if (Array.isArray(listValue) && listValue.length > 0) return listValue;
    if (singleValue) return [singleValue];
    return undefined;
  }
  if (singleValue) return singleValue;
  const first = firstOf(listValue);
  return first !== undefined ? first : undefined;
}

// Find a model's array-typed image ("reference images") input, if any. Distinct
// from model.imageField, which may be a single start-frame image.
function findImagesListField(model) {
  const inputs = model?.inputs || {};
  for (const [key, input] of Object.entries(inputs)) {
    if (input && input.type === 'array' && (input.mediaKind === 'image' || input.field === 'images_list')) {
      return key;
    }
  }
  return null;
}

// Build the Replicate `input` object: keep only keys the model actually
// declares, and translate the UI's generic media keys onto the model's fields.
export function buildInput(model, params = {}) {
  const inputs = model.inputs || {};
  const input = {};

  for (const key of Object.keys(inputs)) {
    let value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      // Coerce enum values to their canonical casing/spelling. Different
      // catalogs may disagree on casing (e.g. "1k" vs "1K"); Replicate rejects
      // anything not exactly in the enum, so match case-insensitively.
      const enumValues = inputs[key]?.enum;
      if (Array.isArray(enumValues) && typeof value === 'string' && !enumValues.includes(value)) {
        const match = enumValues.find(
          (candidate) => String(candidate).toLowerCase() === value.toLowerCase(),
        );
        if (match !== undefined) value = match;
      }
      input[key] = value;
    }
  }

  const assignMedia = (field, singleValue, listValue) => {
    if (!field || input[field] !== undefined) return;
    const value = coerceMediaValue(inputs[field], singleValue, listValue);
    if (value !== undefined) input[field] = value;
  };

  // Image inputs. Treat every provided image as one pool and route by count:
  //   * exactly one image  -> the model's single image field (e.g. `image`
  //     first frame)
  //   * two or more images -> the model's array "reference images" field (e.g.
  //     `reference_images`) when one exists
  // This mirrors how models like Seedance expect images: the single frame slot
  // holds one image, and additional images belong in reference images rather
  // than being dropped. Models whose primary image field is itself an array
  // (e.g. nano-banana `image_input`) always receive the whole list. Seedance
  // also forbids reference images together with first/last frame images, so the
  // single field is left empty when routing to reference images.
  const imagesListField = findImagesListField(model);
  const images = [];
  if (typeof params.image_url === 'string' && params.image_url) images.push(params.image_url);
  if (Array.isArray(params.images_list)) {
    for (const value of params.images_list) if (value) images.push(value);
  }
  const uniqueImages = [...new Set(images)];

  if (imagesListField && imagesListField === model.imageField) {
    // The primary image field is itself an array — send every image there.
    assignMedia(imagesListField, undefined, uniqueImages);
  } else if (uniqueImages.length >= 2 && imagesListField) {
    // Two or more images and a dedicated reference-images array field exists.
    assignMedia(imagesListField, undefined, uniqueImages);
  } else if (uniqueImages.length >= 1 && model.imageField) {
    // A single image (or no array field) — use the single image field.
    assignMedia(model.imageField, uniqueImages[0], undefined);
  } else if (uniqueImages.length >= 1 && imagesListField) {
    // No single field, but an array field exists.
    assignMedia(imagesListField, undefined, uniqueImages);
  }

  assignMedia(model.swapField, params.swap_url, params.swaps_list);
  assignMedia(model.videoField, params.video_url, params.videos_list);
  assignMedia(model.audioField, params.audio_url, params.audios_list);

  return input;
}

// Replicate outputs can be a string URL, an array of URLs or objects, or an
// object with a nested URL. Normalize to { url, outputs }.
function normalizeOutput(output) {
  if (output == null) return { url: null, outputs: [] };

  if (typeof output === 'string') {
    return { url: output, outputs: [output] };
  }

  if (Array.isArray(output)) {
    const outputs = output
      .map((item) => (typeof item === 'string' ? item : item?.url || null))
      .filter(Boolean);
    return { url: outputs[0] || null, outputs };
  }

  if (typeof output === 'object') {
    if (typeof output.url === 'string') return { url: output.url, outputs: [output.url] };
    const nested = Object.values(output).find((value) => typeof value === 'string' && /^https?:\/\//.test(value));
    if (nested) return { url: nested, outputs: [nested] };
  }

  return { url: null, outputs: [] };
}

async function replicateJson(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const detail = data?.detail || data?.title || response.statusText;
    const error = new Error(`Replicate request failed: ${detail}`);
    error.status = response.status;
    error.response = data;
    if (response.status === 401) {
      error.message = 'Replicate rejected the API token. Check your REPLICATE_API_TOKEN or saved key.';
    }
    throw error;
  }

  return data;
}

export async function runReplicatePrediction({ apiKey, model, params, mode, maxAttempts = 900, interval = 2000 }) {
  const version = model?.replicate?.version;
  if (!version) {
    throw new Error(`Replicate model "${model?.id || 'unknown'}" is missing a version id. Re-run the importer.`);
  }

  const input = buildInput(model, params);
  applyRecastSystemPrompt(model, input, mode);

  let prediction = await replicateJson(`${REPLICATE_API}/predictions`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ version, input }),
  });

  const pollUrl = prediction?.urls?.get || `${REPLICATE_API}/predictions/${prediction.id}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = prediction?.status;

    if (status === 'succeeded') {
      const { url, outputs } = normalizeOutput(prediction.output);
      return {
        url,
        outputs,
        status: 'succeeded',
        provider: 'replicate',
        model: model.id,
        replicateId: prediction.id,
      };
    }

    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Replicate generation ${status}: ${prediction.error || 'Unknown error'}`);
    }

    await sleep(interval);
    prediction = await replicateJson(pollUrl, apiKey);
  }

  throw new Error('Replicate generation timed out.');
}

