require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initSchema } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Безопасность
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: true,
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Статика (frontend)
app.use(express.static(path.join(__dirname, '..', 'client')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/lists', require('./routes/lists'));
app.use('/api/watched', require('./routes/watched'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/tmdb', require('./routes/tmdb'));
app.use('/api/youtube', require('./routes/youtube'));
app.use('/api/streaming', require('./routes/streaming'));
app.use('/api/phantom', require('./routes/phantom'));
app.use('/api/vkvideo', require('./routes/vkvideo'));

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
  }
});

// Обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  res.status(500).json({ error: 'Ошибка сервера' });
});

// Запуск: сначала инициализируем БД, потом слушаем порт
async function start() {
  try {
    await initSchema();
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Не удалось запустить сервер:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
