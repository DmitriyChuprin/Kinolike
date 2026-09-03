const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

function authMiddleware(req, res, next) {
  // Ищем токен в cookie или Authorization header
  const cookie = req.headers.cookie || '';
  const cookieMatch = cookie.match(/token=([^;]+)/);
  const authHeader = req.headers.authorization;
  const bearerMatch = authHeader && authHeader.match(/^Bearer\s+(.+)$/);
  
  const token = (cookieMatch && cookieMatch[1]) || (bearerMatch && bearerMatch[1]);
  
  if (!token) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

// Опциональная авторизация — если токен есть, добавляем user, если нет — пропускаем
function optionalAuth(req, res, next) {
  const cookie = req.headers.cookie || '';
  const cookieMatch = cookie.match(/token=([^;]+)/);
  const authHeader = req.headers.authorization;
  const bearerMatch = authHeader && authHeader.match(/^Bearer\s+(.+)$/);
  
  const token = (cookieMatch && cookieMatch[1]) || (bearerMatch && bearerMatch[1]);
  
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

module.exports = { authMiddleware, optionalAuth };
