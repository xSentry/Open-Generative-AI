import { spawn } from 'node:child_process';

const command = process.argv[2] || 'start';
const allowed = new Set(['start', 'dev', 'build']);

if (!allowed.has(command)) {
  console.error(`[run-next] Unsupported command "${command}". Use "start", "dev", or "build".`);
  process.exit(1);
}

const child = spawn(process.execPath, ['./node_modules/next/dist/bin/next', command], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
});

let shuttingDown = false;

function killTree(pid, signal) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

function stopChild(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (!child.killed && child.exitCode === null) {
    killTree(child.pid, signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        killTree(child.pid, 'SIGKILL');
      }
    }, 3000).unref();
  }
}

process.on('SIGINT', () => stopChild('SIGINT'));
process.on('SIGTERM', () => stopChild('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[run-next] Failed to start Next.js:', error);
  process.exit(1);
});
