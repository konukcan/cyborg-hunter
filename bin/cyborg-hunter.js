#!/usr/bin/env node
// CLI entry point for Cyborg Hunter.
// Usage:
//   npx cyborg-hunter init                       # generate starter config
//   npx cyborg-hunter report [--config path] ...  # generate report

import { run } from '../src/cli/report.js';
import { runInit } from '../src/cli/init.js';

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === 'init') {
  runInit().catch(err => { console.error('Error:', err.message); process.exit(1); });
} else if (subcommand === 'report' || !subcommand) {
  run(args).catch(err => { console.error('Error:', err.message); process.exit(1); });
} else {
  console.error(`Unknown command: ${subcommand}. Use "report" or "init".`);
  process.exit(1);
}
