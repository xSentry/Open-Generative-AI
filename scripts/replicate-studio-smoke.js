#!/usr/bin/env node

import fs from 'node:fs';
import { loadDotEnv, resolveReplicateApiToken } from '../modules/providers/replicate/server/env.js';
import {
  getGeneratedReplicateModel,
  isReplicateMappingExposed,
} from '../modules/providers/replicate/server/generatedCatalog.js';
import { runReplicatePrediction } from '../modules/providers/replicate/server/run.js';

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.STUDIO_SMOKE_BASE_URL || 'http://localhost:3000',
    cookie: process.env.STUDIO_SMOKE_COOKIE || '',
    interval: process.env.STUDIO_SMOKE_INTERVAL_MS || '2000',
    maxAttempts: process.env.STUDIO_SMOKE_MAX_ATTEMPTS || '180',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const hasNextValue = argv[index + 1] && !argv[index + 1].startsWith('--');
    const value = inlineValue !== undefined ? inlineValue : hasNextValue ? argv[index + 1] : true;

    if (inlineValue === undefined && hasNextValue) index += 1;
    args[key] = value;
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run replicate:smoke -- --mode=t2i --model=nano-banana --params="{\\"prompt\\":\\"A small red cube\\",\\"aspect_ratio\\":\\"1:1\\"}"',
    '  npm run replicate:smoke -- --http --mode=t2i --model=nano-banana --params="{\\"prompt\\":\\"A small red cube\\",\\"aspect_ratio\\":\\"1:1\\"}"',
    '',
    'Options:',
    '  --http      Post to /api/studio/generate instead of running the generated mapping directly.',
    '  --base-url  Running app URL. Defaults to STUDIO_SMOKE_BASE_URL or http://localhost:3000.',
    '  --cookie    Auth cookie header value. Defaults to STUDIO_SMOKE_COOKIE.',
    '  --mode      Studio mode, such as t2i or i2i.',
    '  --model     Studio model ID from the generated Replicate catalog.',
    '  --params    JSON object passed to /api/studio/generate.',
    '  --params-file  Path to a JSON file containing params. Useful on shells with awkward JSON quoting.',
    '  --max-attempts  Poll attempts for direct Replicate mode. Defaults to STUDIO_SMOKE_MAX_ATTEMPTS or 180.',
    '  --interval      Poll interval in ms for direct Replicate mode. Defaults to STUDIO_SMOKE_INTERVAL_MS or 2000.',
  ].join('\n');
}

function readParams(args) {
  if (args.paramsFile) {
    return fs.readFileSync(args.paramsFile, 'utf8');
  }

  return args.params;
}

async function runHttpSmoke(args, params) {
  const url = new URL('/api/studio/generate', args.baseUrl);
  const headers = {
    'content-type': 'application/json',
  };
  if (args.cookie) headers.cookie = args.cookie;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mode: args.mode,
      model: args.model,
      params,
    }),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

async function runDirectSmoke(args, params) {
  loadDotEnv();
  const apiKey = resolveReplicateApiToken();
  const mapping = getGeneratedReplicateModel(args.model);

  if (!isReplicateMappingExposed(mapping)) {
    throw new Error(`Model "${args.model}" is not exposed in the generated Replicate catalog.`);
  }

  if (mapping.studio?.mode !== args.mode) {
    throw new Error(`Model "${args.model}" is mode "${mapping.studio?.mode}", not "${args.mode}".`);
  }

  const result = await runReplicatePrediction({
    apiKey,
    mapping,
    params: {
      ...params,
      model: args.model,
    },
    maxAttempts: Number.parseInt(args.maxAttempts, 10),
    interval: Number.parseInt(args.interval, 10),
  });

  return {
    ok: true,
    status: 200,
    body: result,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.mode || !args.model || (!args.params && !args.paramsFile)) {
    console.error(usage());
    process.exit(args.help ? 0 : 1);
  }

  let params;
  try {
    params = JSON.parse(readParams(args));
  } catch (error) {
    console.error(`Invalid --params JSON: ${error.message}`);
    process.exit(1);
  }

  if (!params || Array.isArray(params) || typeof params !== 'object') {
    console.error('--params must be a JSON object.');
    process.exit(1);
  }

  const result = args.http
    ? await runHttpSmoke(args, params)
    : await runDirectSmoke(args, params);

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
