import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemixError } from '../contracts.js';
import { resolveMediaExecutable } from '../../media/server/binaries.js';

function executableFor(command) {
  return resolveMediaExecutable(command);
}

export function runMediaCommand(command, args) {
  return new Promise((resolve, reject) => {
    const executable = executableFor(command);
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new RemixError('remix_media_tools_missing', `${command} is required for Remix Studio.`, 503));
      } else reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new RemixError('remix_media_processing_failed', `${command} failed: ${(stderr || stdout).slice(-1000)}`, 422));
    });
  });
}

function fpsNumber(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/').map(Number);
  return denominator ? numerator / denominator : 0;
}

export async function probeVideo(filePath) {
  const { stdout } = await runMediaCommand('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(video?.duration || data.format?.duration);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RemixError('remix_invalid_video', 'The uploaded file does not contain a readable video stream.', 422);
  }
  const rotation = Number(video.tags?.rotate || video.side_data_list?.find((item) => item.rotation != null)?.rotation || 0);
  return {
    durationSeconds,
    width: Number(video.width),
    height: Number(video.height),
    fps: fpsNumber(video.avg_frame_rate || video.r_frame_rate),
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name || null,
    hasAudio: Boolean(audio),
    rotation,
    sizeBytes: Number(data.format?.size || 0),
    format: data.format?.format_name || null,
  };
}

export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function downloadToFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new RemixError('remix_asset_download_failed', `Asset download failed (${response.status}).`, 502);
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return filePath;
}

export async function createPlaybackProxy(inputPath, outputPath) {
  await runMediaCommand('ffmpeg', [
    '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'setsar=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', outputPath,
  ]);
  return probeVideo(outputPath);
}

export async function extractExactFrame(inputPath, outputPath, timestampSeconds, fps = 30) {
  const frame = Math.max(0, Math.round(Number(timestampSeconds) * (fps || 30)));
  const actualTimestampSeconds = frame / (fps || 30);
  await runMediaCommand('ffmpeg', [
    '-y', '-i', inputPath,
    '-vf', `select=eq(n\\,${frame})`,
    '-vsync', '0', '-frames:v', '1', outputPath,
  ]);
  const info = await stat(outputPath).catch(() => null);
  if (!info?.size) throw new RemixError('remix_frame_unavailable', 'No frame exists at that timestamp.', 422);
  return { actualTimestampSeconds, sizeBytes: info.size };
}

export async function createAlephInput({
  inputPath, outputPath, startSeconds = 0, durationSeconds, width, height, fps,
}) {
  const targetFps = Math.min(30, Math.max(24, Math.round(fps || 24)));
  const maxWidth = Math.min(1920, Math.max(480, Number(width) || 1280));
  const maxHeight = Math.min(1080, Math.max(480, Number(height) || 720));
  const videoBitrateKbps = Math.max(700, Math.floor((15 * 1024 * 8) / durationSeconds) - 160);
  await runMediaCommand('ffmpeg', [
    '-y', '-ss', String(startSeconds), '-i', inputPath, '-t', String(durationSeconds),
    '-vf', `scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${targetFps}`,
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${videoBitrateKbps}k`, '-bufsize', `${videoBitrateKbps * 2}k`,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath,
  ]);
  const info = await stat(outputPath);
  if (info.size >= 16 * 1024 * 1024) {
    throw new RemixError('remix_aleph_proxy_too_large', 'Could not prepare the selected clip under Aleph’s 16 MB limit.', 422);
  }
  return { ...(await probeVideo(outputPath)), sizeBytes: info.size };
}

export async function normalizeGeneratedVideo({
  generatedPath, outputPath, width, height, fps, durationSeconds,
}) {
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1', `fps=${fps || 30}`,
  ].join(',');
  await runMediaCommand('ffmpeg', [
    '-y', '-i', generatedPath, '-vf', filter, '-t', String(durationSeconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart', outputPath,
  ]);
}

export async function spliceAndMux({
  sourcePath, generatedPath, outputPath, scope, selectedTimeSeconds, durationSeconds, fps,
}) {
  const visualPath = `${outputPath}.visual.mp4`;
  if (scope === 'whole') {
    await runMediaCommand('ffmpeg', [
      '-y', '-i', generatedPath, '-i', sourcePath,
      '-map', '0:v:0', '-map', '1:a:0?', '-t', String(durationSeconds),
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      '-movflags', '+faststart', outputPath,
    ]);
    return;
  }
  const boundary = Math.floor(selectedTimeSeconds * fps) / fps;
  await runMediaCommand('ffmpeg', [
    '-y', '-i', sourcePath, '-i', generatedPath,
    '-filter_complex',
    `[0:v]trim=start=0:end=${boundary},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[p];`
      + `[1:v]setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[g];`
      + '[p][g]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
    '-pix_fmt', 'yuv420p', visualPath,
  ]);
  await runMediaCommand('ffmpeg', [
    '-y', '-i', visualPath, '-i', sourcePath,
    '-map', '0:v:0', '-map', '1:a:0?', '-t', String(durationSeconds),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
    '-movflags', '+faststart', outputPath,
  ]);
}

export async function createThumbnail(inputPath, outputPath) {
  await runMediaCommand('ffmpeg', [
    '-y', '-ss', '0.1', '-i', inputPath, '-frames:v', '1',
    '-vf', 'scale=480:-2', outputPath,
  ]);
}

export async function readMediaFile(filePath) {
  const [body, info] = await Promise.all([readFile(filePath), stat(filePath)]);
  return { body, sizeBytes: info.size };
}
