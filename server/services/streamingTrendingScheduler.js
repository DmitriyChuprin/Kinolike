const { SERVICES, isDue, updateService } = require('./streamingTrending');
let intervalHandle = null; let timeoutHandle = null; let running = false;
async function scheduledRun() { if (running) return; running = true; try { const due = []; for (const service of SERVICES) if (await isDue(service)) due.push(service); await Promise.all(due.map(updateService)); } catch (error) { console.error(`[Trending Scheduler] update check failed: ${error.message}`); } finally { running = false; } }
function startStreamingTrendingScheduler() {
  if (process.env.STREAMING_TRENDING_ENABLED === 'false' || intervalHandle || timeoutHandle) return null;
  const hours = Math.max(1, Number(process.env.STREAMING_TRENDING_INTERVAL_HOURS || 1));
  // The home page reads only local snapshots, so seed them immediately after a
  // fresh deployment instead of presenting an empty section for several minutes.
  void scheduledRun();
  intervalHandle = setInterval(() => void scheduledRun(), hours * 3600000);
  intervalHandle.unref?.(); console.log(`[Trending Scheduler] Проверка рейтингов каждые ${hours} ч., первый запуск сразу.`); return { intervalHandle };
}
function stopStreamingTrendingScheduler() { if (timeoutHandle) clearTimeout(timeoutHandle); if (intervalHandle) clearInterval(intervalHandle); timeoutHandle = null; intervalHandle = null; }
module.exports = { scheduledRun, startStreamingTrendingScheduler, stopStreamingTrendingScheduler };
