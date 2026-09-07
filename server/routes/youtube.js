const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const http = require('http');

// Настройка прокси
let proxyUrl = null;
if (process.env.TMDB_PROXY_ENABLED === 'true') {
  const type = process.env.TMDB_PROXY_TYPE || 'socks5';
  const host = process.env.TMDB_PROXY_HOST || '127.0.0.1';
  const port = process.env.TMDB_PROXY_PORT || '1080';
  const user = process.env.TMDB_PROXY_USERNAME;
  const pass = process.env.TMDB_PROXY_PASSWORD;
  if (type === 'socks5') {
    proxyUrl = `socks5h://${host}:${port}`;
    if (user && pass) proxyUrl = `socks5h://${user}:${pass}@${host}:${port}`;
  }
}

// Получить URL потока через yt-dlp
router.get('/stream-url', (req, res) => {
  const { video_id } = req.query;
  if (!video_id) return res.status(400).json({ error: 'video_id обязателен' });

  const args = [
    '--no-warnings',
    '--no-playlist',
    '-f', "bestvideo[height<=720]+bestaudio/best[height<=720]",
    '--get-url',
    `https://www.youtube.com/watch?v=${video_id}`
  ];

  if (proxyUrl) {
    args.unshift('--proxy', proxyUrl);
  }

  execFile('yt-dlp', args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp ошибка:', stderr || err.message);
      return res.status(502).json({ error: 'Не удалось получить поток' });
    }
    const url = stdout.trim().split('\n')[0];
    res.json({ url });
  });
});

// Прокси видеопотока
router.get('/proxy', (req, res) => {
  const { video_id } = req.query;
  if (!video_id) return res.status(400).json({ error: 'video_id обязателен' });

  const args = [
    '--no-warnings',
    '--no-playlist',
    '-f', "bestvideo[height<=720]+bestaudio/best[height<=720]",
    '--get-url',
    `https://www.youtube.com/watch?v=${video_id}`
  ];

  if (proxyUrl) {
    args.unshift('--proxy', proxyUrl);
  }

  execFile('yt-dlp', args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp ошибка:', stderr || err.message);
      return res.status(502).json({ error: 'Не удалось получить поток' });
    }

    const streamUrl = stdout.trim().split('\n')[0];
    if (!streamUrl) return res.status(502).json({ error: 'URL потока пуст' });

    // Проксируем запрос к YouTube через socks5
    const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;
    const mod = streamUrl.startsWith('https') ? https : http;

    const proxyReq = mod.get(streamUrl, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
      // Пробрасываем заголовки
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        // Редирект —追随
        const redirectMod = proxyRes.headers.location.startsWith('https') ? https : http;
        const redirReq = redirectMod.get(proxyRes.headers.location, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (redirRes) => {
          res.writeHead(redirRes.statusCode, {
            'Content-Type': redirRes.headers['content-type'] || 'video/mp4',
            'Content-Length': redirRes.headers['content-length'],
            'Accept-Ranges': 'bytes',
          });
          redirRes.pipe(res);
        });
        redirReq.on('error', (e) => { console.error('Redirect error:', e.message); res.status(502).end(); });
        return;
      }

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
        'Content-Length': proxyRes.headers['content-length'],
        'Accept-Ranges': 'bytes',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error('Proxy error:', e.message);
      res.status(502).json({ error: 'Ошибка прокси' });
    });
  });
});

module.exports = router;
