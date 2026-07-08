const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const config = require('../vendor-upstreams.json');
const command = process.argv[2] || 'check';

function run(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    if (options.allowFailure) {
      return null;
    }

    const detail = options.capture ? result.stderr || result.stdout : '';
    throw new Error(`git ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }

  return result.stdout ? result.stdout.trim() : '';
}

function ensureCleanWorkingTree() {
  const status = run(['status', '--porcelain'], { capture: true });

  if (status) {
    throw new Error('Working tree is not clean. Commit or stash local changes before pulling upstreams.');
  }
}

function isSubmodulePath(relativePath) {
  const modeLine = run(['ls-files', '-s', relativePath], { capture: true, allowFailure: true });
  return Boolean(modeLine && modeLine.startsWith('160000 '));
}

function latestRemoteCommit(url, branch) {
  const output = run(['ls-remote', url, `refs/heads/${branch}`], { capture: true });
  const [commit] = output.split(/\s+/);
  return commit;
}

function checkRoot() {
  const root = config.root;
  run(['fetch', root.remote, root.branch]);

  const local = run(['rev-parse', 'HEAD'], { capture: true });
  const upstream = run(['rev-parse', `${root.remote}/${root.branch}`], { capture: true });
  const containsUpstream = run(['merge-base', '--is-ancestor', upstream, 'HEAD'], {
    allowFailure: true,
  }) !== null;

  console.log(`${root.name}:`);
  console.log(`  local:    ${local}`);
  console.log(`  upstream: ${upstream}`);
  console.log(`  status:   ${containsUpstream ? 'up to date or ahead' : 'upstream has changes to merge'}`);
}

function checkPackage(pkg) {
  const latest = latestRemoteCommit(pkg.url, pkg.branch);
  console.log(`${pkg.name}:`);
  console.log(`  path:     ${pkg.path}`);
  console.log(`  upstream: ${latest}`);

  if (isSubmodulePath(pkg.path)) {
    const local = run(['-C', pkg.path, 'rev-parse', 'HEAD'], { capture: true, allowFailure: true });
    console.log(`  local:    ${local || 'unknown'}`);
    console.log('  status:   still a submodule; run npm run vendor:submodules before vendored sync');
    return;
  }

  console.log(`  status:   vendored; use npm run upstream:pull to merge ${pkg.branch} into this path`);
  console.log('  note:     package history is vendored, so upstream package merges may need conflict review');
}

function pullRoot() {
  const root = config.root;
  run(['fetch', root.remote, root.branch]);
  run(['merge', `${root.remote}/${root.branch}`]);
}

function pullPackage(pkg) {
  if (!fs.existsSync(path.join(repoRoot, pkg.path))) {
    throw new Error(`Missing vendored package path: ${pkg.path}`);
  }

  if (isSubmodulePath(pkg.path)) {
    throw new Error(`${pkg.path} is still a submodule. Run npm run vendor:submodules first.`);
  }

  run(['fetch', pkg.url, pkg.branch]);
  run([
    'merge',
    '-s',
    'recursive',
    '-X',
    `subtree=${pkg.path}`,
    '--allow-unrelated-histories',
    'FETCH_HEAD',
  ]);
}

function check() {
  checkRoot();
  for (const pkg of config.packages || []) {
    checkPackage(pkg);
  }
}

function pull() {
  ensureCleanWorkingTree();
  pullRoot();
  for (const pkg of config.packages || []) {
    pullPackage(pkg);
  }
}

if (command === 'check') {
  check();
} else if (command === 'pull') {
  pull();
} else {
  console.error('Usage: node scripts/sync-upstreams.js <check|pull>');
  process.exit(1);
}
