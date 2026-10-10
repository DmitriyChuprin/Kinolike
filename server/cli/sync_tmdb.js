#!/usr/bin/env node
require('dotenv').config();

const db = require('../db/database');
const { runSync } = require('../services/tmdbSyncService');

async function main() {
  try {
    await db.initSchema();
    console.log('[TMDB CLI] Запуск синхронизации каталога TMDB...');
    const result = await runSync();
    console.log('[TMDB CLI] Готово:', JSON.stringify(result, null, 2));
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[TMDB CLI] Ошибка:', error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
