#!/usr/bin/env node
/**
 * Compile the macOS accessibility-suppression dylib (native/ax-suppress.m) into
 * resources/native/ax-suppress.dylib for electron-builder's extraResources.
 *
 * macOS only. On Windows/Linux the AX crash path is handled by the
 * `--disable-renderer-accessibility` Chromium switch alone, so this is a no-op
 * and the runtime loader (src/ax-suppress-mac.ts) simply finds no library.
 *
 * Produces a universal (arm64 + x86_64) binary so a single file serves both the
 * Apple-Silicon and Intel dmg targets. Rebuilt on every packaging run — the
 * compile is sub-second and depends only on ABI-stable system frameworks and the
 * Obj-C runtime, so there is nothing to cache or version.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
  console.log(`build-ax-suppress: skipped on ${process.platform} (macOS-only)`);
  process.exit(0);
}

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'ax-suppress.m');
const outDir = path.join(root, 'resources', 'native');
const out = path.join(outDir, 'ax-suppress.dylib');

fs.mkdirSync(outDir, { recursive: true });

const args = [
  '-arch', 'arm64',
  '-arch', 'x86_64',
  '-dynamiclib',
  '-fno-objc-arc',
  '-O2',
  '-mmacosx-version-min=11.0',
  '-fvisibility=hidden',
  '-Wall',
  '-framework', 'AppKit',
  '-framework', 'Foundation',
  '-o', out,
  src,
];

try {
  execFileSync('clang', args, { stdio: 'inherit' });
  console.log(`build-ax-suppress: wrote ${path.relative(root, out)}`);
} catch (err) {
  console.error(`build-ax-suppress: clang failed — ${err.message}`);
  process.exit(1);
}
