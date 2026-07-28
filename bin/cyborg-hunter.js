#!/usr/bin/env node
// CLI entry point for Cyborg Hunter.
// Usage:
//   npx cyborg-hunter init                       # generate starter config
//   npx cyborg-hunter report [--config path] ...  # generate report

import { readFileSync } from 'node:fs';
import { run } from '../src/cli/report.js';
import { runInit } from '../src/cli/init.js';

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === '--version' || subcommand === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else if (subcommand === 'init') {
  runInit().catch(err => { console.error('Error:', err.message); process.exit(1); });
} else if (subcommand === 'report' || !subcommand) {
  run(args).catch(err => { console.error('Error:', err.message); process.exit(1); });
} else {
  console.error(`Unknown command: ${subcommand}. Use "report", "init", or "--version".`);
  process.exit(1);
}
