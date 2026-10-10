const { runSync } = require('./tmdbSyncService');

let intervalHandle = null;
let timeoutHandle = null;
let running = false;

async function scheduledRun() {
  if (running) return;
  running = true;
  try {
    await runSync();
  } catch (error) {
    console.error('[TMDB Scheduler] Не удалось выполнить синхронизацию:', error.message);
  } finally {
    running = false;
  }
}

function startTmdbSyncScheduler() {
  if (process.env.TMDB_SYNC_ENABLED !== 'true') return null;
  if (intervalHandle || timeoutHandle) return { intervalHandle, timeoutHandle };

  const hours = Math.max(1, Number(process.env.TMDB_SYNC_INTERVAL_HOURS || 168));
  const initialMinutes = Math.max(0, Number(process.env.TMDB_SYNC_INITIAL_DELAY_MINUTES || 30));
  const intervalMs = hours * 60 * 60 * 1000;
  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    void scheduledRun();
    intervalHandle = setInterval(() => void scheduledRun(), intervalMs);
    intervalHandle.unref?.();
  }, initialMinutes * 60 * 1000);
  timeoutHandle.unref?.();
  console.log(`[TMDB Scheduler] Синхронизация каждые ${hours} ч., первый запуск через ${initialMinutes} мин.`);
  return { intervalHandle, timeoutHandle };
}

function stopTmdbSyncScheduler() {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  timeoutHandle = null;
  intervalHandle = null;
}

module.exports = { scheduledRun, startTmdbSyncScheduler, stopTmdbSyncScheduler };
