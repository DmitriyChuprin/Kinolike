#!/usr/bin/env node
require('dotenv').config();

const path = require('path');
const db = require('../db/database');
const { runImdbRatingsImport } = require('../services/imdbRatingsImporter');

function parseArgs(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === '--skip-download') options.skipDownload = true;
    else if (argument === '--force-import') options.forceImport = true;
    else if (argument === '--force-download') options.forceDownload = true;
    else if (argument.startsWith('--data-dir=')) options.dataDir = path.resolve(argument.slice('--data-dir='.length));
    else if (argument.startsWith('--dataset=')) options.datasetPath = path.resolve(argument.slice('--dataset='.length));
    else if (argument.startsWith('--batch-size=')) options.batchSize = Number(argument.slice('--batch-size='.length));
    else throw new Error(`Неизвестный аргумент: ${argument}`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await db.initSchema();
    const result = await runImdbRatingsImport(options);
    console.log('[IMDb Ratings CLI] Готово:', JSON.stringify(result, null, 2));
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[IMDb Ratings CLI] Ошибка:', error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };

