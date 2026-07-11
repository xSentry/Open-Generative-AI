import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

let loaded = false;

export function loadAppEnv(projectDir = process.cwd()) {
  if (loaded) return;
  loadEnvConfig(projectDir);
  loaded = true;
}
