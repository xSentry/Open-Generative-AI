import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  assertMediaBinaries,
  resolveMediaExecutable,
} from '../modules/media/server/binaries.js';

test('explicit media binary paths take precedence', () => {
  assert.equal(
    resolveMediaExecutable('ffmpeg', { FFMPEG_PATH: '/custom/ffmpeg' }),
    '/custom/ffmpeg',
  );
  assert.equal(
    resolveMediaExecutable('ffprobe', { FFPROBE_PATH: '/custom/ffprobe' }),
    '/custom/ffprobe',
  );
});

test('project-managed FFmpeg and ffprobe binaries are installed and executable', () => {
  const binaries = assertMediaBinaries({});
  assert.equal(existsSync(binaries.ffmpeg), true);
  assert.equal(existsSync(binaries.ffprobe), true);
});
