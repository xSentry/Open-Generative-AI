const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const submodulePaths = [
    'packages/Open-AI-Design-Agent',
    'packages/Open-Poe-AI',
    'packages/Vibe-Workflow',
];

function hasPath(targetPath) {
    return fs.existsSync(targetPath);
}

function hasMeaningfulContent(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name === 'node_modules') continue;

        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (hasMeaningfulContent(entryPath)) {
                return true;
            }
            continue;
        }

        return true;
    }

    return false;
}

function prepareSubmodule(relativePath) {
    const absolutePath = path.resolve(repoRoot, relativePath);

    if (!absolutePath.startsWith(repoRoot + path.sep)) {
        throw new Error(`Refusing to inspect outside repository: ${relativePath}`);
    }

    if (!hasPath(absolutePath)) {
        return;
    }

    if (hasPath(path.join(absolutePath, '.git')) || hasPath(path.join(absolutePath, 'package.json'))) {
        return;
    }

    if (hasMeaningfulContent(absolutePath)) {
        console.log(`Leaving ${relativePath}: directory contains non-placeholder files.`);
        return;
    }

    fs.rmSync(absolutePath, { recursive: true, force: true });
    console.log(`Removed incomplete submodule placeholder: ${relativePath}`);
}

for (const submodulePath of submodulePaths) {
    prepareSubmodule(submodulePath);
}
