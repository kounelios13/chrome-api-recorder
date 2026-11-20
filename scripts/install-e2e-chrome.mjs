#!/usr/bin/env node
/**
 * Downloads Chrome for Testing into `.e2e/` so the end-to-end suite can load an
 * unpacked extension. Branded Google Chrome no longer supports
 * `--load-extension`, so a Chrome-for-Testing (or Chromium) binary is required.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, '.e2e');
const BINARY = join(DEST, 'chrome-linux64', 'chrome');

async function main() {
  if (existsSync(BINARY)) {
    console.log(`Chrome for Testing already installed: ${BINARY}`);
    return;
  }

  let version = process.env.CFT_VERSION;
  if (!version) {
    const response = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json');
    if (!response.ok) throw new Error(`Could not fetch the Chrome for Testing version list (HTTP ${response.status})`);
    const metadata = await response.json();
    version = metadata.channels.Stable.version;
  }

  const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip`;
  console.log(`Downloading Chrome for Testing ${version}\n  ${url}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);

  mkdirSync(DEST, { recursive: true });
  const zipPath = join(DEST, 'chrome-linux64.zip');
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', DEST], { stdio: 'inherit' });
  if (unzip.error || unzip.status !== 0) {
    throw new Error('Could not unzip the archive; install the "unzip" package and retry');
  }
  rmSync(zipPath, { force: true });
  chmodSync(BINARY, 0o755);
  console.log(`Installed: ${BINARY}`);
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
