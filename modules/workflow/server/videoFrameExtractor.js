import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveMediaExecutable } from '../../media/server/binaries.js';

const FRAME_MODES = new Set(['first', 'last', 'custom']);

function normalizeVideoInput(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Video Frame Extractor requires a video input.');
  }
  const trimmed = value.trim();
  if (/^file:\/\//i.test(trimmed)) return fileURLToPath(trimmed);
  return trimmed;
}

function runCommand(command, args) {
  const executable = resolveMediaExecutable(command);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new Error(`Video Frame Extractor requires ${command} to be installed and available on PATH.`));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${code}): ${stderr || stdout || 'no output'}`));
    });
  });
}

export function parseTimestampSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;

  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d+(?:\.\d+)?$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function normalizeFrameMode(mode) {
  const normalized = String(mode || 'first').toLowerCase().replace(/\s+/g, '-');
  if (normalized === 'first-frame') return 'first';
  if (normalized === 'last-frame') return 'last';
  if (normalized === 'custom-frame') return 'custom';
  return FRAME_MODES.has(normalized) ? normalized : 'first';
}

function timestampForMode({ frameMode, timestamp }) {
  if (frameMode === 'first') return 0;
  if (frameMode === 'custom') {
    const seconds = parseTimestampSeconds(timestamp);
    if (seconds == null) {
      throw new Error('Custom Frame requires a timestamp in seconds or HH:MM:SS format.');
    }
    return seconds;
  }
  return null;
}

function outputExtension(format) {
  return String(format || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function safeBasename(value) {
  const withoutQuery = String(value || '').split(/[?#]/)[0];
  return basename(withoutQuery).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'video';
}

async function extractLastFrame(videoInput, filePath) {
  const attempts = [
    ['-sseof', '-1'],
    ['-sseof', '-3'],
    ['-sseof', '-10'],
    [],
  ];

  let lastError = null;
  for (const seekArgs of attempts) {
    try {
      await runCommand('ffmpeg', [
        '-y',
        ...seekArgs,
        '-i', videoInput,
        '-an',
        '-update', '1',
        '-f', 'image2',
        filePath,
      ]);
      if (await fileExists(filePath)) return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || 'Failed to extract the last frame from the video.');
}

async function extractSingleFrame(videoInput, filePath, seconds) {
  await runCommand('ffmpeg', [
    '-y',
    '-ss', String(seconds),
    '-i', videoInput,
    '-frames:v', '1',
    '-f', 'image2',
    filePath,
  ]);

  if (!(await fileExists(filePath))) {
    throw new Error(`No frame was found at timestamp ${seconds}.`);
  }
}

export async function extractVideoFrame({ video_url, frame_mode, timestamp, format = 'png' }) {
  const videoInput = normalizeVideoInput(video_url);
  const mode = normalizeFrameMode(frame_mode);
  const seconds = timestampForMode({ frameMode: mode, timestamp });
  const ext = outputExtension(format);
  const dir = await mkdtemp(join(tmpdir(), 'workflow-frame-'));
  const filePath = join(dir, `${safeBasename(videoInput)}-frame.${ext}`);

  if (mode === 'last') await extractLastFrame(videoInput, filePath);
  else await extractSingleFrame(videoInput, filePath, seconds);

  return {
    path: filePath,
    filename: `video-frame.${ext}`,
    contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png',
  };
}
