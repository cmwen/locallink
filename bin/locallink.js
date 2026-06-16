#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(appRoot, 'package.json');
const distEntryPath = path.join(appRoot, 'dist', 'cli.js');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function formatFatalError(error) {
  if (error && typeof error === 'object') {
    const name = typeof error.name === 'string' ? error.name : '';
    const message = typeof error.message === 'string' ? error.message : '';
    if (message) {
      return name && name !== 'Error' && name !== 'AppError' ? `${name}: ${message}` : message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return `Unexpected fatal error: ${String(error)}`;
}

function readPackageManifest() {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    fail(
      `LocalLink could not read ${packageJsonPath}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
}

const manifest = readPackageManifest();
function dependencyPackageJsonPath(dependency) {
  const parts = dependency.split('/');
  return dependency.startsWith('@')
    ? path.join(appRoot, 'node_modules', parts[0], parts[1], 'package.json')
    : path.join(appRoot, 'node_modules', parts[0], 'package.json');
}

const missingDependencies = Object.keys(manifest.dependencies || {}).filter((dependency) => {
  return !fs.existsSync(dependencyPackageJsonPath(dependency));
});

if (missingDependencies.length > 0) {
  fail(
    `LocalLink dependencies are missing. Run "pnpm install" in ${appRoot} and retry. Missing: ${missingDependencies.join(
      ', ',
    )}.`,
  );
}

if (!fs.existsSync(distEntryPath)) {
  fail(`LocalLink is not built yet. Run "pnpm build" in ${appRoot} and retry.`);
}

const cli = require(distEntryPath);
if (typeof cli.main !== 'function') {
  fail(`LocalLink entrypoint ${distEntryPath} does not export main().`);
}

Promise.resolve(cli.main()).catch((error) => {
  process.stderr.write(`${formatFatalError(error)}\n`);
  process.exit(1);
});
