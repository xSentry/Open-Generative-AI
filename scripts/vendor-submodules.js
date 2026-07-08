const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const config = require('../vendor-upstreams.json');
const packages = config.packages || [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    const message = options.capture ? result.stderr || result.stdout : '';
    throw new Error(`${command} ${args.join(' ')} failed${message ? `\n${message}` : ''}`);
  }

  return result.stdout ? result.stdout.trim() : '';
}

function isInsideRepo(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function removeSubmoduleGitFile(relativePath) {
  const gitPath = path.join(repoRoot, relativePath, '.git');

  if (!fs.existsSync(gitPath)) {
    return;
  }

  const stat = fs.lstatSync(gitPath);
  if (stat.isDirectory()) {
    throw new Error(`Refusing to remove nested .git directory at ${relativePath}`);
  }

  fs.rmSync(gitPath);
  console.log(`Removed nested git metadata pointer: ${path.join(relativePath, '.git')}`);
}

function removeGitmodulesFileIfEmpty() {
  const gitmodulesPath = path.join(repoRoot, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) {
    return;
  }

  const content = fs.readFileSync(gitmodulesPath, 'utf8');
  if (/\[submodule\s+"/.test(content)) {
    return;
  }

  fs.rmSync(gitmodulesPath);
  console.log('Removed empty .gitmodules');
}

function stageGitmodulesIfPresent() {
  if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
    run('git', ['add', '.gitmodules']);
  }
}

for (const pkg of packages) {
  const absolutePath = path.resolve(repoRoot, pkg.path);

  if (!isInsideRepo(absolutePath)) {
    throw new Error(`Refusing to vendor outside repository: ${pkg.path}`);
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Cannot vendor missing package directory: ${pkg.path}`);
  }

  const modeLine = run('git', ['ls-files', '-s', pkg.path], { capture: true });

  if (modeLine.startsWith('160000 ')) {
    run('git', ['rm', '--cached', pkg.path]);
    console.log(`Removed submodule gitlink from index: ${pkg.path}`);
  } else {
    console.log(`No submodule gitlink found for ${pkg.path}`);
  }

  removeSubmoduleGitFile(pkg.path);

  if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
    const section = `submodule.${pkg.path}`;
    const result = spawnSync('git', ['config', '-f', '.gitmodules', '--remove-section', section], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    if (result.status === 0) {
      console.log(`Removed .gitmodules section: ${section}`);
    }

    stageGitmodulesIfPresent();
  }

  run('git', ['add', pkg.path]);
}

removeGitmodulesFileIfEmpty();

if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
  run('git', ['add', '.gitmodules']);
} else {
  run('git', ['add', '-u', '.gitmodules']);
}

console.log('Vendored package directories are staged. Review with: git status --short');
