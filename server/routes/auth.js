const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const UserModel = require('../models/user');
const { authMiddleware } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// Регистрация
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    }
    if (await UserModel.findByEmail(email)) {
      return res.status(409).json({ error: 'Email уже зарегистрирован' });
    }
    if (await UserModel.findByUsername(username)) {
      return res.status(409).json({ error: 'Имя пользователя уже занято' });
    }
    const result = await UserModel.create(username, email, password);
    const user = await UserModel.findById(result.lastInsertRowid);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ user, token });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    const user = await UserModel.findByEmail(email);
    if (!user || !UserModel.verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({
      user: { id: user.id, username: user.username, email: user.email, avatar_url: user.avatar_url },
      token,
    });
  } catch (err) {
    console.error('Ошибка входа:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Выход
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Вы вышли из аккаунта' });
});

// Текущий пользователь
router.get('/me', authMiddleware, async (req, res) => {
  const user = await UserModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user });
});

// Обновить профиль
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { username, email, avatar_url } = req.body;
    if (email) {
      const existing = await UserModel.findByEmail(email);
      if (existing && existing.id !== req.user.id) {
        return res.status(409).json({ error: 'Email уже занят' });
      }
    }
    if (username) {
      const existing = await UserModel.findByUsername(username);
      if (existing && existing.id !== req.user.id) {
        return res.status(409).json({ error: 'Имя пользователя уже занято' });
      }
    }
    await UserModel.updateProfile(req.user.id, { username, email, avatar_url });
    const user = await UserModel.findById(req.user.id);
    res.json({ user });
  } catch (err) {
    console.error('Ошибка обновления профиля:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Смена пароля
router.put('/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }
    const fullUser = await UserModel.findById(req.user.id);
    const user = await UserModel.findByEmail(fullUser.email);
    if (!UserModel.verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    await UserModel.updatePassword(req.user.id, newPassword);
    res.json({ message: 'Пароль успешно изменён' });
  } catch (err) {
    console.error('Ошибка смены пароля:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
