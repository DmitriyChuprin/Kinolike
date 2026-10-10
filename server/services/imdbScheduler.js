const { runImdbRatingsImport } = require('./imdbRatingsImporter');

let intervalHandle = null;
let timeoutHandle = null;
let running = false;

async function scheduledRun() {
  if (running) return;
  running = true;
  try {
    await runImdbRatingsImport();
  } catch (error) {
    console.error('[IMDb Scheduler] Не удалось обновить IMDb:', error.message);
  } finally {
    running = false;
  }
}

function startImdbScheduler() {
  if (process.env.IMDB_AUTO_UPDATE !== 'true') return null;
  if (intervalHandle || timeoutHandle) return { intervalHandle, timeoutHandle };

  const hours = Math.max(1, Number(process.env.IMDB_UPDATE_INTERVAL_HOURS || 24));
  const initialMinutes = Math.max(0, Number(process.env.IMDB_UPDATE_INITIAL_DELAY_MINUTES || 10));
  const intervalMs = hours * 60 * 60 * 1000;
  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    void scheduledRun();
    intervalHandle = setInterval(() => void scheduledRun(), intervalMs);
    intervalHandle.unref?.();
  }, initialMinutes * 60 * 1000);
  timeoutHandle.unref?.();
  console.log(`[IMDb Scheduler] Обновление каждые ${hours} ч., первый запуск через ${initialMinutes} мин.`);
  return { intervalHandle, timeoutHandle };
}

function stopImdbScheduler() {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  timeoutHandle = null;
  intervalHandle = null;
}

module.exports = { scheduledRun, startImdbScheduler, stopImdbScheduler };
