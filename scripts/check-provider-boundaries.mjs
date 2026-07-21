import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'modules/studio/server',
  'modules/workflow/server/engine.js',
  'modules/workflow/server/nodeExecutors.js',
  'modules/agents/server',
  'modules/design-agent/server',
];
const concreteImport = /(?:from\s*|import\s*\()['"](?:\.\.\/)*providers\/(?:replicate|muapi)\//;

function filesAt(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(absolute, entry.name);
    return entry.isDirectory()
      ? filesAt(path.relative(root, child))
      : /\.[cm]?js$/.test(entry.name) ? [child] : [];
  });
}

const violations = targets.flatMap(filesAt).filter((file) => concreteImport.test(fs.readFileSync(file, 'utf8')));
if (violations.length) {
  console.error('Concrete provider imports crossed provider-neutral boundaries:');
  for (const file of violations) console.error(`- ${path.relative(root, file)}`);
  process.exit(1);
}
console.log('Provider import boundaries are valid.');

