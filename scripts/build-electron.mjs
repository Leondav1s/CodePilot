import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

function findServerJs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findServerJs(fullPath);
      if (found) return found;
    } else if (entry.isFile() && entry.name === 'server.js') {
      return fullPath;
    }
  }
  return null;
}

function mergeDirectoryContents(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const fromPath = path.join(fromDir, entry.name);
    const toPath = path.join(toDir, entry.name);

    if (entry.isDirectory()) {
      mergeDirectoryContents(fromPath, toPath);
      continue;
    }

    fs.cpSync(fromPath, toPath, { force: true });
  }
}

// Newer Next builds can emit standalone nested under the inferred workspace root
// (for example .next/standalone/<absolute-project-path>/server.js). Electron expects
// server.js directly under .next/standalone, so flatten the output before packaging.
function normalizeStandaloneLayout() {
  const standaloneRoot = '.next/standalone';
  const rootServerPath = path.join(standaloneRoot, 'server.js');
  if (fs.existsSync(rootServerPath)) return;
  if (!fs.existsSync(standaloneRoot)) return;

  const nestedServerPath = findServerJs(standaloneRoot);
  if (!nestedServerPath) return;

  const nestedRoot = path.dirname(nestedServerPath);
  if (nestedRoot === path.resolve(standaloneRoot)) return;

  mergeDirectoryContents(nestedRoot, standaloneRoot);
  console.log(`Flattened standalone output from ${nestedRoot} -> ${standaloneRoot}`);
}

// Replace symlinks in standalone with real copies so electron-builder can package them
function resolveStandaloneSymlinks() {
  const candidateDirs = [
    '.next/standalone/node_modules',
    '.next/standalone/.next/node_modules',
  ];

  for (const standaloneModules of candidateDirs) {
    if (!fs.existsSync(standaloneModules)) continue;

    const entries = fs.readdirSync(standaloneModules);
    for (const entry of entries) {
      const fullPath = path.join(standaloneModules, entry);
      const stat = fs.lstatSync(fullPath);
      if (!stat.isSymbolicLink()) continue;

      const target = fs.readlinkSync(fullPath);
      const resolved = path.resolve(standaloneModules, target);
      if (!fs.existsSync(resolved)) continue;

      fs.rmSync(fullPath, { recursive: true, force: true });
      fs.cpSync(resolved, fullPath, { recursive: true });
      console.log(`Resolved symlink: ${entry} -> ${target}`);
    }
  }
}

async function buildElectron() {
  // Clean dist-electron/ before every build to prevent stale artifacts
  // from leaking into app.asar (caused v0.34 crash on upgrade).
  if (fs.existsSync('dist-electron')) {
    fs.rmSync('dist-electron', { recursive: true });
    console.log('Cleaned dist-electron/');
  }
  fs.mkdirSync('dist-electron', { recursive: true });

  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['electron'],
    sourcemap: true,
    minify: false,
  };

  await build({
    ...shared,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.js',
  });

  await build({
    ...shared,
    entryPoints: ['electron/preload.ts'],
    outfile: 'dist-electron/preload.js',
  });

  console.log('Electron build complete');

  normalizeStandaloneLayout();

  // Fix standalone symlinks after next build
  resolveStandaloneSymlinks();
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
