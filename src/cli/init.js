// src/cli/init.js
// Generates a minimal starter config file in the current directory.
// The user edits dataDir and filePattern to point at their data.

import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export async function runInit() {
  const configPath = join(process.cwd(), 'cyborg-hunter.config.json');

  if (existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    console.log('Delete it first if you want to regenerate.');
    return;
  }

  // Minimal config — just the fields every project needs to set.
  // filePattern defaults to JSON-or-CSV because jsPsych's `.csv()` save is
  // the most common format we see in the wild (Shape-2 producers use JSON; most
  // jsPsych setups use CSV).
  const config = {
    dataDir: './data',
    filePattern: '*.{json,csv}',
    outputDir: './cyborg-hunter-report'
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`Created ${configPath}`);
  console.log('Edit dataDir and filePattern to match your data location.');
  console.log('See docs/configuration.md for all available options.');
}
