import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function bundledBinary(command) {
  try {
    if (command === 'ffmpeg') return require('ffmpeg-static') || null;
    return require('ffprobe-static')?.path || null;
  } catch {
    return null;
  }
}

export function resolveMediaExecutable(command, env = process.env) {
  const explicit = command === 'ffmpeg' ? env.FFMPEG_PATH : env.FFPROBE_PATH;
  return explicit || bundledBinary(command) || command;
}

export function assertMediaBinaries(env = process.env) {
  const resolved = {};
  for (const command of ['ffmpeg', 'ffprobe']) {
    const executable = resolveMediaExecutable(command, env);
    const result = spawnSync(executable, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr || `exit code ${result.status}`;
      throw new Error(`${command} is required for media processing (${detail}).`);
    }
    resolved[command] = executable;
  }
  return resolved;
}
