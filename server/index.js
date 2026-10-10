require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initSchema } = require('./db/database');
const { startImdbScheduler } = require('./services/imdbScheduler');
const { startTmdbSyncScheduler } = require('./services/tmdbSyncScheduler');
const { startPlaybackWatchdog } = require('./services/playbackLifecycle');
const { startStreamingTrendingScheduler } = require('./services/streamingTrendingScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Безопасность
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // YouTube embedded players require an HTTP Referer (error 153 otherwise).
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, false);
    return callback(new Error('Origin запрещён политикой CORS'));
  },
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});
app.use('/api/', limiter);
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Слишком много попыток входа' } }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Слишком много попыток регистрации' } }));

// Cookie-authenticated unsafe requests must originate from this deployment.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers.authorization) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers.host;
  try {
    if (new URL(origin).host === host || allowedOrigins.includes(origin)) return next();
  } catch (_) { /* invalid origin */ }
  return res.status(403).json({ error: 'Запрос отклонён CSRF-защитой' });
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Статика (frontend)
const frontendDir = path.join(__dirname, '..', 'dist');
const staticCache = process.env.NODE_ENV === 'production' ? { maxAge: '1y', immutable: true } : { maxAge: 0 };
app.use('/assets', express.static(path.join(frontendDir, 'assets'), staticCache));
app.use('/fonts', express.static(path.join(frontendDir, 'fonts'), staticCache));
app.use(express.static(frontendDir, { index: false, maxAge: 0 }));

// API routes
app.use('/api/v1', require('./routes/apiV1'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/lists', require('./routes/lists'));
app.use('/api/watched', require('./routes/watched'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/taste-profile', require('./routes/tasteProfile'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/home', require('./routes/home'));
app.use('/api/tmdb', require('./routes/tmdb'));
app.use('/api/trailers', require('./routes/trailers'));
app.use('/api/streaming', require('./routes/streaming'));
app.use('/api/trending', require('./routes/trending'));

// SPA fallback
app.get('*', (req, res, next) => {
  const isApiRequest = req.path === '/api' || req.path.startsWith('/api/');
  if (!isApiRequest) {
    return res.sendFile(path.join(frontendDir, 'index.html'));
  }
  next();
});

// Не оставляем неизвестные API-запросы с висящим соединением: SPA fallback
// предназначен только для браузерных маршрутов.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint не найден' });
});

// Обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  const isV1 = req.path === '/api/v1' || req.path.startsWith('/api/v1/');
  if (err instanceof SyntaxError && err.status === 400 && err.type === 'entity.parse.failed') {
    if (isV1) return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON' } });
    return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
  }
  if (isV1) return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  res.status(500).json({ error: 'Ошибка сервера' });
});

// Запуск: сначала инициализируем БД, потом слушаем порт
async function start() {
  try {
    await initSchema();
    startImdbScheduler();
    startTmdbSyncScheduler();
    startPlaybackWatchdog();
    startStreamingTrendingScheduler();
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Не удалось запустить сервер:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = app;
