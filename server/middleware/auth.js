const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// Express не добавляет res.cookie/res.clearCookie самостоятельно. Не тянем
// отдельную зависимость только ради одной cookie: JWT также возвращается в
// JSON и используется клиентом через Authorization: Bearer.
function setTokenCookie(res, token) {
  const parts = [
    `token=${encodeURIComponent(token)}`,
    'Max-Age=604800',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearTokenCookie(res) {
  res.append('Set-Cookie', [
    'token=',
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; '));
}

function authMiddleware(req, res, next) {
  // Ищем токен в cookie или Authorization header
  const cookie = req.headers.cookie || '';
  const cookieMatch = cookie.match(/token=([^;]+)/);
  const authHeader = req.headers.authorization;
  const bearerMatch = authHeader && authHeader.match(/^Bearer\s+(.+)$/);
  
  // Приоритет Authorization: клиент может иметь устаревшую cookie после миграции
  // или смены домена/пути cookie.
  const token = (bearerMatch && bearerMatch[1]) || (cookieMatch && cookieMatch[1]);
  
  if (!token) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Backward-compatible migration: an old client may only have the JWT in
    // localStorage. The first authenticated request upgrades it to HttpOnly.
    if (!cookieMatch && bearerMatch) setTokenCookie(res, token);
    next();
  } catch (err) {
    // Токен может остаться у браузера после смены JWT_SECRET или переноса
    // приложения. Удаляем его, чтобы следующий вход создал новую сессию.
    clearTokenCookie(res);
    return res.status(401).json({ error: 'Сессия истекла. Войдите снова.', code: 'INVALID_TOKEN' });
  }
}

// Опциональная авторизация — если токен есть, добавляем user, если нет — пропускаем
function optionalAuth(req, res, next) {
  const cookie = req.headers.cookie || '';
  const cookieMatch = cookie.match(/token=([^;]+)/);
  const authHeader = req.headers.authorization;
  const bearerMatch = authHeader && authHeader.match(/^Bearer\s+(.+)$/);
  
  // Приоритет Authorization: клиент может иметь устаревшую cookie после миграции
  // или смены домена/пути cookie.
  const token = (bearerMatch && bearerMatch[1]) || (cookieMatch && cookieMatch[1]);
  
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      // Игнорируем невалидный токен
    }
  }
  next();
}

module.exports = { authMiddleware, optionalAuth, setTokenCookie, clearTokenCookie };
