#!/usr/bin/env node
/*
 * Replicate model importer.
 *
 * Fetches a Replicate model's OpenAPI input/output schema, normalizes it into
 * the same shape the Studio UI already understands (see
 * packages/studio/src/models.js), persists every imported model into a JSON
 * store and (re)generates a models.js-like JS module from that store.
 *
 * Usage:
 *   node modules/providers/replicate/scripts/replicate-model-import.js <owner/name> [<owner/name> ...] [options]
 *   node modules/providers/replicate/scripts/replicate-model-import.js kwaivgi/kling-v3-omni-video
 *   node modules/providers/replicate/scripts/replicate-model-import.js --collection text-to-image --mode t2i
 *   node modules/providers/replicate/scripts/replicate-model-import.js black-forest-labs/flux-dev --mode t2i --name "Flux Dev"
 *   node modules/providers/replicate/scripts/replicate-model-import.js --regen-only          # rebuild JS from JSON store only
 *
 * Good general usage to fetch latest needed models:
 *   node modules/providers/replicate/scripts/replicate-model-import.js --fresh --collection official --collection text-to-image --collection text-to-speech --collection ai-face-generator --collection text-to-video --collection super-resolution --collection ai-music-generation --collection image-editing --collection remove-backgrounds --collection ai-enhance-videos --collection sketch-to-image --collection image-to-video
 *   node modules/providers/replicate/scripts/replicate-model-import.js --collection lipsync --mode lipsync
 *
 * Options:
 *   --mode <t2i|i2i|t2v|i2v|v2v|lipsync|recast|audio|t2t>   Force the Studio mode(s), comma-separated (otherwise inferred).
 *   --collection <slug>                                 Import every model in a Replicate collection (repeatable).
 *   --sort <newest|oldest|run_count|none>               Order collection models before limiting (default: newest).
 *   --limit <n|none>                                    Cap collection models kept (default: 80; "none" disables).
 *   --no-limit                                          Disable the collection limit (import all).
 *   --concurrency <n>                                   Parallel fetches for direct model refs (default: 6).
 *   --name "<Display Name>"                             Override the display name.
 *   --id <slug>                                         Override the generated model id.
 *   --version <hash>                                    Pin a specific Replicate version id.
 *   --fresh, --reset                                    Delete the existing store and start from scratch.
 *   --regen-only                                        Skip fetching, only regenerate the JS module.
 *   --remove <owner/name>                               Remove a model from the store, then regenerate.
 *
 * Auth:
 *   Reads REPLICATE_API_TOKEN from the environment or the repo root .env file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MODULE_DIR = path.resolve(__dirname, '..');
const STORE_PATH = path.join(MODULE_DIR, 'data', 'replicate-models.json');
const OUTPUT_PATH = path.join(MODULE_DIR, 'replicateModels.js');
const REPLICATE_API = 'https://api.replicate.com/v1';

const STUDIO_MODES = ['t2i', 'i2i', 't2v', 'i2v', 'v2v', 'lipsync', 'recast', 'audio', 't2t'];

// Derived (virtual) modes are NOT imported directly with --mode; they are
// computed from a model's inputs/outputs when the JS module is generated. This
// keeps them always in sync with the store (a plain --regen-only re-derives them
// for every existing model, no re-fetch needed).
//
// "cinema": any image model (t2i/i2i) that also exposes the exact inputs Cinema
// Studio drives, so the Cinema UI can offer a provider-aware model picker.
// "marketing": video models that accept a prompt plus MULTIPLE reference images
// (product + avatar + extra refs) — Marketing Studio's omni-reference video ads.
const DERIVED_MODES = ['cinema', 'marketing'];
const OUTPUT_MODES = [...STUDIO_MODES, ...DERIVED_MODES];

// Inputs a model must declare to back Cinema Studio (prompt + aspect_ratio).
// Tighten/loosen here to change which models get tagged "cinema".
const CINEMA_REQUIRED_INPUTS = ['prompt', 'aspect_ratio'];

// A model backs Cinema Studio when it produces images (t2i/i2i) and declares all
// CINEMA_REQUIRED_INPUTS. `modes` is the model's already-resolved Studio modes.
function modelSupportsCinema(record, modes) {
  const isImageModel = modes.includes('t2i') || modes.includes('i2i');
  if (!isImageModel) return false;
  const inputs = record?.inputs || {};
  return CINEMA_REQUIRED_INPUTS.every((key) => Boolean(inputs[key]));
}

// A model backs the Body Swap / "recast" Studio when it outputs video and accepts
// BOTH a source video input and a reference *subject* image input (put the
// image's subject/performance into the video). `recast` is a real Studio mode;
// unlike cinema it may also be forced with --mode recast for hand-curated adds.
//
// The structural signature (video + image -> video) alone is too broad: it also
// matches video super-resolution / restoration / background-replacement / frame
// continuation models whose image input is a mask/background/frame, not a
// subject. So we additionally require the image field to look like a subject
// reference (i.e. NOT one of these non-subject field names).
const RECAST_NON_SUBJECT_IMAGE_FIELDS = /(mask|bg|background|first_frame|last_frame|end_frame|keyframe|frames?)/i;

function modelSupportsRecast(record, modes) {
  const isVideoOutput = modes.includes('t2v') || modes.includes('i2v') || modes.includes('v2v');
  if (!isVideoOutput) return false;
  const videoField = record?.videoField;
  const imageField = record?.imageField;
  if (!videoField || !imageField) return false;
  if (RECAST_NON_SUBJECT_IMAGE_FIELDS.test(imageField)) return false;
  return true;
}

// A model accepts multiple reference images when it advertises maxImages > 1
// (MuAPI convention) or declares ANY array-typed image input (Replicate). We
// scan every input, not just the designated `imageField`, because models like
// seedance expose a single `image` (start frame) AND a separate array
// `reference_images` — the latter is the one that backs multi-image use.
function acceptsMultipleImages(record) {
  if (Number(record?.maxImages) > 1) return true;
  const inputs = record?.inputs || {};
  for (const input of Object.values(inputs)) {
    if (
      input &&
      input.type === 'array' &&
      (input.mediaKind === 'image' || input.field === 'images_list')
    ) {
      return true;
    }
  }
  return false;
}

// A model backs the Marketing Studio when it outputs video, takes a text prompt
// (the ad script) and accepts MULTIPLE reference images (product + avatar + refs).
function modelSupportsMarketing(record, modes) {
  const isVideoOutput = modes.includes('t2v') || modes.includes('i2v') || modes.includes('v2v');
  if (!isVideoOutput) return false;
  const hasPrompt = Boolean(record?.inputs?.prompt) || Boolean(record?.hasPrompt);
  if (!hasPrompt) return false;
  return acceptsMultipleImages(record);
}

// Sorting + selection defaults for collection imports.
const SORT_MODES = ['newest', 'oldest', 'run_count', 'listed'];
const DEFAULT_SORT = 'newest';
const DEFAULT_LIMIT = 80;
const DEFAULT_CONCURRENCY = 6;

// Studio mode -> exported array name in the generated module (mirrors models.js).
const MODE_EXPORTS = {
  t2i: 't2iReplicateModels',
  i2i: 'i2iReplicateModels',
  t2v: 't2vReplicateModels',
  i2v: 'i2vReplicateModels',
  v2v: 'v2vReplicateModels',
  lipsync: 'lipsyncReplicateModels',
  recast: 'recastReplicateModels',
  audio: 'audioReplicateModels',
  t2t: 't2tReplicateModels',
  // Derived modes:
  cinema: 'cinemaReplicateModels',
  marketing: 'marketingReplicateModels',
};

// ---------------------------------------------------------------------------
// Minimal .env loader (no external dependency).
// ---------------------------------------------------------------------------
function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes and inline comments for unquoted values.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveToken() {
  const token = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!token) {
    throw new Error('REPLICATE_API_TOKEN is required. Add it to .env or export it before running the importer.');
  }
  if (token === 'r8_replace-with-your-replicate-api-token') {
    throw new Error('REPLICATE_API_TOKEN is still set to the example value. Replace it with a real Replicate API token.');
  }
  return token;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    models: [], collections: [], limit: DEFAULT_LIMIT, sort: DEFAULT_SORT, concurrency: DEFAULT_CONCURRENCY,
    mode: null, name: null, id: null, version: null, regenOnly: false, remove: null, fresh: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--mode': opts.mode = argv[++i]; break;
      case '--name': opts.name = argv[++i]; break;
      case '--id': opts.id = argv[++i]; break;
      case '--version': opts.version = argv[++i]; break;
      case '--remove': opts.remove = argv[++i]; break;
      case '--collection': opts.collections.push(argv[++i]); break;
      case '--sort': opts.sort = String(argv[++i] || '').toLowerCase(); break;
      case '--concurrency': opts.concurrency = Number.parseInt(argv[++i], 10); break;
      case '--no-limit': opts.limit = null; break;
      case '--limit': {
        const raw = String(argv[++i] || '').toLowerCase();
        opts.limit = (raw === 'none' || raw === 'off' || raw === '0') ? null : Number.parseInt(raw, 10);
        break;
      }
      case '--regen-only': opts.regenOnly = true; break;
      case '--fresh':
      case '--reset': opts.fresh = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        opts.models.push(arg);
    }
  }
  if (opts.mode) {
    const modes = opts.mode.split(',').map((s) => s.trim()).filter(Boolean);
    const invalid = modes.filter((m) => !STUDIO_MODES.includes(m));
    if (invalid.length > 0) {
      throw new Error(`Invalid --mode "${invalid.join(', ')}". Expected one or more (comma-separated) of: ${STUDIO_MODES.join(', ')}`);
    }
  }
  // Normalize sort aliases; `none`/`listed` disables sorting (keep curated order).
  if (opts.sort === 'none' || opts.sort === 'off') opts.sort = 'listed';
  if (opts.sort === 'popular' || opts.sort === 'runs' || opts.sort === 'run-count') opts.sort = 'run_count';
  if (!SORT_MODES.includes(opts.sort)) {
    throw new Error(`Invalid --sort "${opts.sort}". Expected one of: newest, oldest, run_count, none.`);
  }
  if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new Error('--limit must be a positive integer, or "none" to disable.');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency <= 0) {
    throw new Error('--concurrency must be a positive integer.');
  }
  return opts;
}

function printHelp() {
  console.log(`Replicate model importer

Usage:
  node modules/providers/replicate/scripts/replicate-model-import.js <owner/name> [<owner/name> ...] [options]
  node modules/providers/replicate/scripts/replicate-model-import.js --collection <slug> [--collection <slug> ...] [options]
  node modules/providers/replicate/scripts/replicate-model-import.js --regen-only
  node modules/providers/replicate/scripts/replicate-model-import.js --remove <owner/name>

Options:
  --mode <${STUDIO_MODES.join('|')}>   Force the Studio mode(s); comma-separated for multiple. Otherwise inferred.
  --collection <slug>        Import every model in a Replicate collection (repeatable).
  --sort <newest|oldest|run_count|none>   Order collection models before limiting (default: newest).
  --limit <n|none>           Cap collection models kept (default: ${DEFAULT_LIMIT}; "none" or --no-limit to disable).
  --no-limit                 Disable the collection limit (import all).
  --concurrency <n>          Parallel fetches for direct model refs (default: ${DEFAULT_CONCURRENCY}).
  --name "<Display Name>"    Override display name.
  --id <slug>                Override generated model id.
  --version <hash>           Pin a specific Replicate version id.
  --fresh, --reset           Delete the existing store and start from scratch
                             (combine with model refs to rebuild from only those).
  --regen-only               Only regenerate the JS module from the JSON store.
  --remove <owner/name>      Remove a model from the store, then regenerate.
`);
}

// ---------------------------------------------------------------------------
// Replicate fetch
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replicateGet(pathname, token, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${REPLICATE_API}${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    // Back off and retry on rate-limit responses.
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number.parseFloat(res.headers.get('retry-after') || '') || 2 ** attempt;
      console.warn(`  Rate limited on ${pathname}; retrying in ${retryAfter}s ...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = data?.detail || data?.title || res.statusText;
      if (res.status === 401) {
        throw new Error('Replicate rejected REPLICATE_API_TOKEN. Check that the token in .env is valid and active.');
      }
      if (res.status === 404) {
        throw new Error(`Replicate resource not found: ${pathname} (${detail})`);
      }
      throw new Error(`Replicate request failed (${res.status}): ${detail}`);
    }
    return data;
  }
}

// Fetch a Replicate collection and return the full model objects. The collection
// detail already embeds each model's `latest_version.openapi_schema`, so no
// per-model requests are needed. Follows `next` if the API ever paginates.
async function fetchCollectionModels(slug, token) {
  const models = [];
  let pathname = `/collections/${slug}`;

  while (pathname) {
    const data = await replicateGet(pathname, token);
    for (const model of data?.models || []) {
      if (model?.owner && model?.name) models.push(model);
    }

    const next = data?.next;
    pathname = next ? next.replace(REPLICATE_API, '') : null;
  }

  return models;
}

// Sort collection model objects. `newest`/`oldest` use each model's created_at,
// `run_count` uses popularity; `listed` keeps the API's curated order.
function sortCollectionModels(models, sort) {
  if (sort === 'listed') return models;
  const copy = [...models];
  if (sort === 'run_count') {
    copy.sort((a, b) => (b.run_count || 0) - (a.run_count || 0));
  } else if (sort === 'oldest') {
    copy.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else {
    // newest (default)
    copy.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }
  return copy;
}

// Convert a collection model object into the shape buildRecord expects, reusing
// the embedded latest_version + openapi_schema (no network call).
function collectionModelToFetched(model) {
  const version = model.latest_version || null;
  return {
    owner: model.owner,
    name: model.name,
    model,
    version,
    schema: version?.openapi_schema,
  };
}

// Run an async worker over items with bounded concurrency, preserving order.
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  const size = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: size }, runner));
  return results;
}

async function fetchModel(ref, versionId, token) {
  const [owner, name] = ref.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid model reference "${ref}". Expected "owner/name".`);
  }

  const model = await replicateGet(`/models/${owner}/${name}`, token);
  let version;
  if (versionId) {
    version = await replicateGet(`/models/${owner}/${name}/versions/${versionId}`, token);
  } else {
    version = model.latest_version;
    if (!version) {
      throw new Error(`Model "${ref}" has no latest_version. Pass --version explicitly.`);
    }
  }

  const schema = version.openapi_schema;
  if (!schema?.components?.schemas) {
    throw new Error(`Model "${ref}" version ${version.id} has no OpenAPI schema.`);
  }

  return { owner, name, model, version, schema };
}

// ---------------------------------------------------------------------------
// Schema normalization (Replicate OpenAPI -> Studio input format)
// ---------------------------------------------------------------------------
function convertType(openApiType) {
  switch (openApiType) {
    case 'integer': return 'int';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return 'array';
    case 'object': return 'object';
    case 'string':
    default: return 'string';
  }
}

function resolveRef(ref, root) {
  // ref like "#/components/schemas/aspect_ratio"
  const segments = ref.replace(/^#\//, '').split('/');
  let node = root;
  for (const seg of segments) {
    node = node?.[seg];
    if (node == null) return null;
  }
  return node;
}

// Replicate frequently wraps enum properties as { allOf: [{ $ref }] , default, ... }.
// Merge that referenced schema into a flat property definition.
function flattenProperty(prop, root) {
  let flat = { ...prop };
  if (Array.isArray(prop.allOf)) {
    for (const part of prop.allOf) {
      const target = part.$ref ? resolveRef(part.$ref, root) : part;
      if (target) {
        flat = { ...target, ...flat };
        if (target.enum && !flat.enum) flat.enum = target.enum;
        if (target.type && !flat.type) flat.type = target.type;
      }
    }
    delete flat.allOf;
  }
  if (prop.$ref) {
    const target = resolveRef(prop.$ref, root);
    if (target) flat = { ...target, ...flat };
    delete flat.$ref;
  }
  return flat;
}

// Detect whether a uri/file field represents an image, video or audio.
function classifyMediaText(text) {
  const t = String(text).toLowerCase();
  if (/(video|clip|footage)/.test(t)) return 'video';
  if (/(audio|voice|speech|sound|music|song|track|vocal)/.test(t)) return 'audio';
  if (/(image|img|photo|picture|frame|mask|face|portrait)/.test(t)) return 'image';
  return null;
}

function detectMediaKind(name, prop) {
  // The field NAME/TITLE is the strongest signal (e.g. "images"), so classify
  // from it first and only fall back to the description. This avoids
  // cross-contamination such as an "images" field on a music model whose
  // description mentions "music".
  const label = `${name} ${prop.title || ''}`;
  return classifyMediaText(label) || classifyMediaText(prop.description || '');
}

function isFileProp(prop) {
  return prop.format === 'uri' || (prop.type === 'array' && prop.items && prop.items.format === 'uri');
}

// Determine an array field's max item count: prefer the schema's maxItems, else
// parse phrasing like "up to 10 images" / "max 4" from the description.
function inferMaxItems(prop) {
  if (typeof prop.maxItems === 'number') return prop.maxItems;
  const desc = String(prop.description || '');
  const match =
    desc.match(/up to (\d+)/i) ||
    desc.match(/max(?:imum)?\s+(?:of\s+)?(\d+)/i) ||
    desc.match(/(\d+)\s+(?:images|items|videos|files|photos)/i);
  if (match) {
    const n = Number.parseInt(match[1], 10);
    if (n > 0 && n <= 50) return n;
  }
  return undefined;
}

function buildInputField(name, rawProp, root) {
  const prop = flattenProperty(rawProp, root);
  const field = { type: convertType(prop.type), title: prop.title || prettifyName(name), name };

  if (prop.description) field.description = prop.description;
  if (prop.default !== undefined) field.default = prop.default;
  if (Array.isArray(prop.enum)) field.enum = prop.enum;
  if (typeof prop.minimum === 'number') field.minValue = prop.minimum;
  if (typeof prop.maximum === 'number') field.maxValue = prop.maximum;
  if (typeof prop.multipleOf === 'number') field.step = prop.multipleOf;

  const arrayMaxItems = prop.type === 'array' ? inferMaxItems(prop) : undefined;

  const fileKind = isFileProp(prop) ? (detectMediaKind(name, prop) || 'image') : null;
  if (fileKind) {
    field.format = 'uri';
    // Audio uploaders in the UI look for field:"audio" / field:"audios_list".
    if (prop.type === 'array') {
      field.field = fileKind === 'audio' ? 'audios_list' : `${fileKind}s_list`;
      if (arrayMaxItems !== undefined) field.maxItems = arrayMaxItems;
    } else {
      field.field = fileKind;
    }
    field.mediaKind = fileKind;
  }

  if (prop.type === 'array' && prop.items) {
    const items = { type: convertType(prop.items.type) };
    if (Array.isArray(prop.items.enum)) items.enum = prop.items.enum;
    if (prop.items.format) items.format = prop.items.format;
    if (prop.items.properties) items.properties = prop.items.properties;
    field.items = items;
    if (arrayMaxItems !== undefined) field.maxItems = arrayMaxItems;
  }

  return { field, meta: { fileKind, isArray: prop.type === 'array', order: prop['x-order'] ?? 999 } };
}

function prettifyName(name) {
  return String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Output schema inspection + mode inference
// ---------------------------------------------------------------------------
function describeOutput(schema) {
  const output = schema.components?.schemas?.Output;
  if (!output) return { kind: 'unknown', schema: null };

  // Resolve $ref / array-item $ref so uri formats & titles are visible, but stay
  // scoped to the OUTPUT schema (never the inputs, to avoid false positives).
  let resolved = output;
  if (output.$ref) resolved = resolveRef(output.$ref, schema) || output;
  else if (output.type === 'array' && output.items?.$ref) {
    resolved = { ...output, items: resolveRef(output.items.$ref, schema) || output.items };
  }

  const asText = JSON.stringify(resolved).toLowerCase();
  // Does the output reference a file at all? (top-level, array items, or $ref)
  const isFileOutput = /"format"\s*:\s*"uri"/.test(asText);
  let kind = 'unknown';
  if (/\.(mp4|mov|webm|mkv|m4v)|"?video"?/.test(asText)) kind = 'video';
  else if (/\.(mp3|wav|flac|ogg|m4a|aac|opus)|"?audio"?/.test(asText)) kind = 'audio';
  else if (/\.(png|jpe?g|webp|gif|avif|bmp)|"?image"?/.test(asText)) kind = 'image';
  else if (!isFileOutput) kind = 'text'; // no uri anywhere -> non-media output (LLM text, json, numbers)
  // else: a file output whose media type we couldn't name -> stays 'unknown'
  //       (resolved later via default_example extension).

  return { kind, schema: output };
}

// Strongest available signal: Replicate's default_example carries real output
// URLs whose file extension reveals image vs video vs audio.
function mediaKindFromExample(model) {
  const example = model?.default_example;
  if (!example) return null;
  const text = JSON.stringify(example.output ?? example).toLowerCase();
  if (/\.(mp4|mov|webm|mkv|m4v)(\?|"|\\|$)/.test(text)) return 'video';
  if (/\.(mp3|wav|flac|ogg|m4a|aac|opus)(\?|"|\\|$)/.test(text)) return 'audio';
  if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|"|\\|$)/.test(text)) return 'image';
  return null;
}

// Replicate output schemas are often just a generic `uri`, so fall back to the
// model name/description to distinguish image vs video vs audio outputs.
function mediaKindFromText(text) {
  const t = String(text).toLowerCase();
  if (/(video|animate|animation|motion|footage|clip)/.test(t)) return 'video';
  if (/(speech|voice|tts|music|audio|song|sound|melody)/.test(t)) return 'audio';
  if (/(image|photo|picture|portrait|logo|sticker|render)/.test(t)) return 'image';
  return null;
}

// Order a set of modes canonically (by STUDIO_MODES) and drop duplicates.
function finalizeModes(modes, fallback) {
  const unique = STUDIO_MODES.filter((m) => modes.includes(m));
  return unique.length > 0 ? unique : [fallback];
}

// Infer every Studio mode a model supports. A model with an OPTIONAL media input
// supports both the text-only mode and the media mode (e.g. t2i + i2i); a
// REQUIRED media input restricts it to the media mode only.
function inferModes(record, outputKind) {
  const required = new Set(record.required || []);
  const imageField = record.imageField;
  const videoField = record.videoField;
  const audioField = record.audioField;
  const hasImageInput = Boolean(imageField);
  const hasVideoInput = Boolean(videoField);
  const imageRequired = Boolean(imageField && required.has(imageField));
  const videoRequired = Boolean(videoField && required.has(videoField));
  const name = `${record.id} ${record.name}`.toLowerCase();

  if (/lip.?sync/.test(name)) return ['lipsync'];

  // Upgrade an ambiguous (unknown/image) output kind using text signals.
  const textKind = mediaKindFromText(`${record.name} ${record.id} ${record.description}`);
  let resolvedKind = outputKind;
  if ((outputKind === 'unknown' || outputKind === 'image') && (textKind === 'video' || textKind === 'audio')) {
    resolvedKind = textKind;
  } else if (outputKind === 'unknown' && textKind) {
    resolvedKind = textKind;
  }

  if (resolvedKind === 'audio') return ['audio'];
  if (resolvedKind === 'text') return ['t2t'];

  if (resolvedKind === 'video') {
    const modes = [];
    if (hasVideoInput) modes.push('v2v');
    if (hasImageInput) modes.push('i2v');
    // Pure text-to-video is possible unless a media input is mandatory.
    if (!videoRequired && !imageRequired) modes.push('t2v');
    return finalizeModes(modes, 't2v');
  }

  if (resolvedKind === 'image') {
    const modes = [];
    if (hasImageInput) modes.push('i2i');
    // Pure text-to-image is possible unless the image input is mandatory.
    if (!imageRequired) modes.push('t2i');
    return finalizeModes(modes, 't2i');
  }

  // Fall back on the strongest input signal when the output stays ambiguous.
  if (hasVideoInput) return ['v2v'];
  if (hasImageInput) return ['i2i'];
  if (audioField) return ['audio'];
  return ['t2t'];
}

// ---------------------------------------------------------------------------
// Build a normalized store record from a fetched model.
// ---------------------------------------------------------------------------
function buildRecord({ owner, name, model, version, schema }, opts) {
  const inputSchema = schema.components?.schemas?.Input;
  if (!inputSchema?.properties) {
    throw new Error(`Model "${owner}/${name}" has no Input schema properties.`);
  }

  const requiredNames = Array.isArray(inputSchema.required) ? inputSchema.required : [];

  // Build + order inputs by Replicate's x-order.
  const built = Object.entries(inputSchema.properties)
    .map(([key, prop]) => ({ key, ...buildInputField(key, prop, schema) }))
    .sort((a, b) => a.meta.order - b.meta.order);

  const inputs = {};
  let imageField = null;
  let videoField = null;
  let audioField = null;
  let swapField = null;

  for (const entry of built) {
    inputs[entry.key] = entry.field;
    if (entry.meta.fileKind === 'image') {
      if (!imageField) imageField = entry.key;
      else if (!swapField) swapField = entry.key;
    } else if (entry.meta.fileKind === 'video' && !videoField) {
      videoField = entry.key;
    } else if (entry.meta.fileKind === 'audio' && !audioField) {
      audioField = entry.key;
    }
  }

  const hasPrompt = Boolean(inputs.prompt);
  const promptRequired = hasPrompt && requiredNames.includes('prompt');

  const outputInfo = describeOutput(schema);
  // Prefer a concrete schema kind; otherwise fall back to the default_example's
  // file extension before leaving it ambiguous.
  const exampleKind = mediaKindFromExample(model);
  const isConcrete = ['image', 'video', 'audio', 'text'].includes(outputInfo.kind);
  const effectiveOutputKind = isConcrete ? outputInfo.kind : (exampleKind || outputInfo.kind);

  const displayName = opts.name || model.name || prettifyName(name);
  const id = opts.id || slugify(name);

  // Capture creation dates so the generated module can sort newest-first.
  const createdAt = model.created_at || version.created_at || null;

  const record = {
    id,
    name: displayName,
    provider: 'replicate',
    replicate: {
      ref: `${owner}/${name}`,
      owner,
      model: name,
      version: version.id,
      url: model.url || `https://replicate.com/${owner}/${name}`,
      createdAt,
      versionCreatedAt: version.created_at || null,
    },
    description: model.description || '',
    inputs,
    required: requiredNames,
    hasPrompt,
    promptRequired,
    outputKind: effectiveOutputKind,
    output: outputInfo.schema,
  };

  if (imageField) record.imageField = imageField;
  if (swapField) record.swapField = swapField;
  if (videoField) record.videoField = videoField;
  if (audioField) record.audioField = audioField;

  const modeOverride = opts.mode
    ? opts.mode.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  record.modes = modeOverride || inferModes(record, effectiveOutputKind);
  if (record.modes.includes('lipsync')) {
    record.category = videoField ? 'video' : 'image';
  }

  return record;
}

// ---------------------------------------------------------------------------
// JSON store persistence
// ---------------------------------------------------------------------------
function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(`Failed to parse ${STORE_PATH}: ${error.message}`);
  }
}

function saveStore(records) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const sorted = [...records].sort((a, b) => a.replicate.ref.localeCompare(b.replicate.ref));
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

// Guard against duplicates before persisting/generating:
//   1. collapse any records that share the same replicate.ref (last wins),
//   2. ensure every record has a unique `id` (two different refs can slugify to
//      the same id, e.g. owner-a/flux-dev vs owner-b/flux-dev).
function normalizeRecords(records) {
  const byRef = new Map();
  for (const record of records) {
    if (record?.replicate?.ref) byRef.set(record.replicate.ref, record);
  }
  const unique = [...byRef.values()];

  const seenIds = new Map(); // id -> ref that owns it
  for (const record of unique) {
    const baseId = record.id;
    if (!seenIds.has(baseId)) {
      seenIds.set(baseId, record.replicate.ref);
      continue;
    }

    if (seenIds.get(baseId) === record.replicate.ref) continue;

    // Collision between two different refs -> disambiguate with the owner.
    let candidate = `${baseId}-${slugify(record.replicate.owner)}`;
    let n = 2;
    while (seenIds.has(candidate)) {
      candidate = `${baseId}-${slugify(record.replicate.owner)}-${n}`;
      n += 1;
    }
    console.warn(`  Duplicate id "${baseId}" from ${record.replicate.ref}; renamed to "${candidate}".`);
    record.id = candidate;
    seenIds.set(candidate, record.replicate.ref);
  }

  return unique;
}

// Normalize, then write both the JSON store and the generated module.
function persist(records) {
  const normalized = normalizeRecords(records);
  saveStore(normalized);
  writeModule(normalized);
  return normalized;
}

// Union two mode lists, keeping the canonical STUDIO_MODES order.
function mergeModes(a, b) {
  const set = new Set([...(a || []), ...(b || [])]);
  return STUDIO_MODES.filter((mode) => set.has(mode));
}

function upsertRecord(records, record) {
  const idx = records.findIndex((r) => r.replicate?.ref === record.replicate.ref);
  if (idx === -1) {
    records.push(record);
    return 'added';
  }

  // Merge (don't replace) the modes of an already-stored model, while refreshing
  // the rest of the record with the latest fetched data. `--fresh` never reaches
  // here because it starts from an empty store.
  const existing = records[idx];
  const existingModes = Array.isArray(existing.modes)
    ? existing.modes
    : (existing.mode ? [existing.mode] : []);
  const merged = mergeModes(existingModes, record.modes);
  const grew = merged.length > record.modes.length;

  record.modes = merged; // reflect the union in the emitted record + logs
  if (merged.includes('lipsync') && !record.category) {
    record.category = record.videoField ? 'video' : 'image';
  }
  records[idx] = record;
  return grew ? 'merged' : 'updated';
}

// ---------------------------------------------------------------------------
// Generate the models.js-like module from the store.
// ---------------------------------------------------------------------------
function generateModule(records) {
  const grouped = Object.fromEntries(OUTPUT_MODES.map((mode) => [mode, []]));
  for (const record of records) {
    // Support the new `modes` array plus legacy single-`mode` records.
    const rawModes = Array.isArray(record.modes)
      ? record.modes
      : (record.mode ? [record.mode] : ['t2i']);
    const modes = rawModes.filter((mode) => STUDIO_MODES.includes(mode));
    const effectiveModes = modes.length > 0 ? modes : ['t2i'];

    // Strip the transient mode keys from the emitted model object; array
    // membership encodes the mode (mirroring models.js). A multi-mode model is
    // emitted into each of its mode arrays.
    const { modes: _modes, mode: _legacyMode, ...model } = record;
    for (const mode of effectiveModes) {
      grouped[mode].push(model);
    }

    // Derived "cinema" membership: computed from the model's inputs so it stays
    // in sync on every regen. Also honors an explicit `cinema` tag if a record
    // was stored with one.
    if (rawModes.includes('cinema') || modelSupportsCinema(record, effectiveModes)) {
      grouped.cinema.push(model);
    }

    // Derived "recast" membership: structurally-matching video models (source
    // video + reference image → video). Skip when already tagged recast in the
    // store (e.g. via --mode recast) so it isn't emitted twice.
    if (!effectiveModes.includes('recast') && modelSupportsRecast(record, effectiveModes)) {
      grouped.recast.push(model);
    }

    // Derived "marketing" membership: video models with prompt + multiple
    // reference images (product/avatar/refs → video ad).
    if (modelSupportsMarketing(record, effectiveModes)) {
      grouped.marketing.push(model);
    }
  }

  // Sort each mode's list newest-first so the UI defaults to (and lists) the
  // newest model at the top. Undated models sort last, then by name.
  const createdTime = (m) => {
    const ts = m.replicate?.createdAt || m.replicate?.versionCreatedAt;
    const value = ts ? Date.parse(ts) : NaN;
    return Number.isNaN(value) ? -Infinity : value;
  };
  for (const mode of OUTPUT_MODES) {
    grouped[mode].sort((a, b) => {
      const diff = createdTime(b) - createdTime(a);
      return diff !== 0 ? diff : String(a.name).localeCompare(String(b.name));
    });
  }

  const header = `// AUTO-GENERATED by modules/providers/replicate/scripts/replicate-model-import.js -- do not edit by hand.
// Source of truth: modules/providers/replicate/data/replicate-models.json
// Regenerate with: node modules/providers/replicate/scripts/replicate-model-import.js --regen-only
`;

  const arrays = OUTPUT_MODES.map((mode) => {
    const exportName = MODE_EXPORTS[mode];
    const json = JSON.stringify(grouped[mode], null, 2);
    return `export const ${exportName} = ${json};`;
  }).join('\n\n');

  const modeMapEntries = OUTPUT_MODES.map((mode) => `  ${mode}: ${MODE_EXPORTS[mode]},`).join('\n');
  // allReplicateModels intentionally spreads only the real (imported) Studio
  // modes; derived modes (cinema) re-use models already present there, so they
  // are excluded to avoid duplicate entries in the flat list.
  const spread = STUDIO_MODES.map((mode) => `  ...${MODE_EXPORTS[mode]},`).join('\n');

  const helpers = `
export const replicateModelsByMode = {
${modeMapEntries}
};

export const allReplicateModels = [
${spread}
];

export const getReplicateModelById = (id) => allReplicateModels.find((m) => m.id === id);

export const getReplicateModelsForMode = (mode) => replicateModelsByMode[mode] || [];

export const getReplicateModelByRef = (ref) =>
  allReplicateModels.find((m) => m.replicate?.ref === ref);
`;

  return `${header}\n${arrays}\n${helpers}`;
}

function writeModule(records) {
  const contents = generateModule(records);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, contents, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Print the effective run settings (including defaults) before doing anything.
function printSettings(opts) {
  let action = 'import';
  if (opts.regenOnly) action = 'regen-only (rebuild module from store)';
  else if (opts.remove) action = `remove "${opts.remove}"`;
  else if (opts.models.length === 0 && opts.collections.length === 0 && opts.fresh) action = 'reset (empty store)';

  const lines = [
    '=== Replicate importer settings ===',
    `  action       : ${action}`,
    `  store        : ${opts.fresh ? 'fresh (wipe existing)' : 'append/update existing'}`,
    `  models       : ${opts.models.length ? opts.models.join(', ') : '(none)'}`,
    `  collections  : ${opts.collections.length ? opts.collections.join(', ') : '(none)'}`,
    `  mode         : ${opts.mode ? opts.mode : '(auto-infer)'}`,
    `  sort         : ${opts.sort}${opts.sort === DEFAULT_SORT ? ' (default)' : ''}`,
    `  limit        : ${opts.limit === null ? 'none' : `${opts.limit}${opts.limit === DEFAULT_LIMIT ? ' (default)' : ''}`}`,
    `  concurrency  : ${opts.concurrency}${opts.concurrency === DEFAULT_CONCURRENCY ? ' (default)' : ''}`,
  ];
  if (opts.version) lines.push(`  version      : ${opts.version}`);
  if (opts.name) lines.push(`  name override: ${opts.name}`);
  if (opts.id) lines.push(`  id override  : ${opts.id}`);
  lines.push('===================================');

  console.log(lines.join('\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  printSettings(opts);

  loadDotEnv();

  // `--fresh` wipes the existing store and starts from scratch.
  const records = opts.fresh ? [] : loadStore();
  if (opts.fresh) {
    console.log('Fresh run: clearing the existing Replicate model store.');
  }

  if (opts.remove) {
    const before = records.length;
    const filtered = records.filter((r) => r.replicate?.ref !== opts.remove);
    if (filtered.length === before) {
      console.warn(`No stored model matched "${opts.remove}".`);
    } else {
      console.log(`Removed ${opts.remove} from the store.`);
    }
    const removed = persist(filtered);
    console.log(`Regenerated ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${removed.length} models).`);
    return;
  }

  if (opts.regenOnly) {
    const normalized = normalizeRecords(records);
    writeModule(normalized);
    console.log(`Regenerated ${path.relative(REPO_ROOT, OUTPUT_PATH)} from ${normalized.length} stored models.`);
    return;
  }

  if (opts.models.length === 0 && opts.collections.length === 0) {
    // `--fresh` alone is a valid "reset to empty" operation.
    if (opts.fresh) {
      saveStore(records);
      writeModule(records);
      console.log(`Reset store: ${path.relative(REPO_ROOT, STORE_PATH)} (0 models)`);
      console.log(`Regenerated ${path.relative(REPO_ROOT, OUTPUT_PATH)}.`);
      return;
    }
    printHelp();
    throw new Error('No model reference or collection provided.');
  }

  const token = resolveToken();

  const directRefs = [...new Set(opts.models)];
  const seenRefs = new Set(directRefs);

  if (opts.collections.length > 0 && !opts.mode) {
    console.warn(
      'Warning: importing a collection without --mode; the Studio mode will be auto-inferred per model, ' +
      'which can misclassify edge cases. Pass --mode to force a single mode.'
    );
  }

  // Each collection is sorted and limited INDIVIDUALLY (using the global --sort
  // and --limit), then all selections are merged and de-duplicated before import.
  const selectedModels = [];
  for (const slug of opts.collections) {
    console.log(`Scanning collection "${slug}" ...`);
    const models = await fetchCollectionModels(slug, token);
    const ranked = sortCollectionModels(models, opts.sort);
    const capped = (opts.limit !== null && ranked.length > opts.limit)
      ? ranked.slice(0, opts.limit)
      : ranked;
    console.log(`  found ${models.length}; selected ${capped.length} (sort=${opts.sort}, limit=${opts.limit ?? 'none'})`);

    let added = 0;
    for (const model of capped) {
      const ref = `${model.owner}/${model.name}`;
      if (seenRefs.has(ref)) continue; // de-dup vs direct refs + already-selected collections
      seenRefs.add(ref);
      selectedModels.push(model);
      added += 1;
    }
    if (added !== capped.length) {
      console.log(`  ${capped.length - added} duplicate(s) skipped after merge`);
    }
  }

  if (opts.collections.length > 0) {
    console.log(`Total unique collection models to import: ${selectedModels.length}`);
  }

  if ((directRefs.length + selectedModels.length) > 1 && (opts.name || opts.id)) {
    throw new Error('--name/--id can only be used with a single model reference.');
  }

  let imported = 0;
  let skipped = 0;

  const record = (fetched, refLabel) => {
    try {
      const built = buildRecord(fetched, opts);
      const action = upsertRecord(records, built);
      imported += 1;
      console.log(
        `  ${action}: id="${built.id}" modes="${built.modes.join(',')}" ` +
        `inputs=${Object.keys(built.inputs).length} output=${built.outputKind} version=${built.replicate.version}`
      );
    } catch (error) {
      skipped += 1;
      console.warn(`  skipped ${refLabel}: ${error.message}`);
    }
  };

  // 1. Collection models: build in-memory, no network per model.
  for (const model of selectedModels) {
    record(collectionModelToFetched(model), `${model.owner}/${model.name}`);
  }

  // 2. Direct refs: fetch with bounded concurrency, then build.
  if (directRefs.length > 0) {
    console.log(`Fetching ${directRefs.length} model(s) with concurrency ${opts.concurrency} ...`);
    const results = await mapPool(directRefs, opts.concurrency, async (ref) => {
      console.log(`Fetching ${ref} ...`);
      return { fetched: await fetchModel(ref, opts.version, token), ref };
    });
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.ok) record(result.value.fetched, result.value.ref);
      else { skipped += 1; console.warn(`  skipped ${directRefs[i]}: ${result.error.message}`); }
    }
  }

  const normalized = persist(records);
  console.log(`\nImported/updated: ${imported}, skipped: ${skipped}`);
  console.log(`Store: ${path.relative(REPO_ROOT, STORE_PATH)} (${normalized.length} models)`);
  console.log(`Module: ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
});

