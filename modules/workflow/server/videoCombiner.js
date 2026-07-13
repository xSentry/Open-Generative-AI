import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ASPECT_SIZES = {
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [1080, 1080],
  '4:3': [1024, 768],
  '3:4': [768, 1024],
  '21:9': [1680, 720],
  '9:21': [720, 1680],
};

function normalizeVideoInput(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^file:\/\//i.test(trimmed)) return fileURLToPath(trimmed);
  return trimmed;
}

function runProcess(command, args, missingMessage) {
  const executable = command === 'ffmpeg'
    ? (process.env.FFMPEG_PATH || command)
    : (process.env.FFPROBE_PATH || command);
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
        reject(new Error(missingMessage));
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

function runFfmpeg(args) {
  return runProcess('ffmpeg', args, 'Video Combiner requires ffmpeg to be installed and available on PATH.');
}

function runFfprobe(args) {
  return runProcess('ffprobe', args, 'Video Combiner requires ffprobe to inspect auto aspect ratio.');
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
  return basename(withoutQuery).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'combined-video';
}

function normalizeAspectRatio(value) {
  const ratio = String(value || 'auto').trim();
  return ratio in ASPECT_SIZES ? ratio : 'auto';
}

function concatFilter(count, aspectRatio) {
  const target = Array.isArray(aspectRatio) ? aspectRatio : ASPECT_SIZES[aspectRatio];
  const chains = [];
  const refs = [];

  for (let index = 0; index < count; index += 1) {
    const filters = ['fps=30', 'format=yuv420p', 'setsar=1'];
    if (target) {
      const [width, height] = target;
      filters.splice(
        1,
        0,
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
      );
    }
    chains.push(`[${index}:v]${filters.join(',')}[v${index}]`);
    refs.push(`[v${index}]`);
  }

  chains.push(`${refs.join('')}concat=n=${count}:v=1:a=0[outv]`);
  return chains.join(';');
}

async function probeVideoSize(video) {
  try {
    const { stdout } = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      video,
    ]);
    const [width, height] = stdout.trim().split('x').map((part) => Number(part));
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return [Math.round(width), Math.round(height)];
    }
  } catch {
    // If ffprobe is unavailable or cannot read a remote URL, let ffmpeg try the
    // concat without scaling. Matching clips still work, and explicit aspect
    // ratios remain fully deterministic.
  }
  return 'auto';
}

export async function combineVideos({ videos_list, aspect_ratio = 'auto' }) {
  const videos = (Array.isArray(videos_list) ? videos_list : [videos_list])
    .map(normalizeVideoInput)
    .filter(Boolean);

  if (videos.length < 2) {
    throw new Error('Video Combiner requires at least two video clips.');
  }

  const ratio = normalizeAspectRatio(aspect_ratio);
  const filterAspect = ratio === 'auto' ? await probeVideoSize(videos[0]) : ratio;
  const dir = await mkdtemp(join(tmpdir(), 'workflow-video-combiner-'));
  const filePath = join(dir, `${safeBasename(videos[0])}-combined.mp4`);
  const inputArgs = videos.flatMap((video) => ['-i', video]);

  await runFfmpeg([
    '-y',
    ...inputArgs,
    '-filter_complex', concatFilter(videos.length, filterAspect),
    '-map', '[outv]',
    '-an',
    '-movflags', '+faststart',
    '-preset', 'veryfast',
    filePath,
  ]);

  if (!(await fileExists(filePath))) {
    throw new Error('Video Combiner did not produce an output video.');
  }

  return {
    path: filePath,
    filename: 'combined-video.mp4',
    contentType: 'video/mp4',
  };
}
