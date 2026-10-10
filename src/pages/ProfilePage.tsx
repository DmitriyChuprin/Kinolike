import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../App';
import { api } from '../services/api';
import { ThemePicker } from '../theme';
import type { Statistics, User } from '../types';

export function ProfilePage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Statistics | null>(null);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { api.stats.overview().then(data => setStats({ ...data, movies: data.counts.movie || 0, tv: data.counts.tv || 0 })).catch(() => setStats(null)); }, []);
  if (!user) return null;

  const report = (error: unknown, fallback: string) => setMessage(error instanceof Error ? error.message : fallback);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    try { const result = await api.auth.updateProfile({ username: username.trim(), email: email.trim() }); setUser(result.user); setEditing(false); setMessage('Профиль сохранён'); }
    catch (error) { report(error, 'Не удалось сохранить профиль'); }
  };
  const setStreamingSource = async (preferred_streaming_source: User['preferred_streaming_source']) => {
    setMessage('');
    try { const result = await api.auth.updateProfile({ preferred_streaming_source }); setUser(result.user); setMessage('Источник онлайн-просмотра сохранён'); }
    catch (error) { report(error, 'Не удалось сохранить источник'); }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    try { await api.auth.changePassword(currentPassword, newPassword); setCurrentPassword(''); setNewPassword(''); setMessage('Пароль изменён'); }
    catch (error) { report(error, 'Не удалось изменить пароль'); }
  };
  const exportData = async () => {
    try {
      const data = await api.lists.exportAll();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `kinolike-export-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (error) { report(error, 'Не удалось экспортировать данные'); }
  };
  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const parsed: unknown = JSON.parse(await file.text()); if (!Array.isArray(parsed)) throw new Error('Файл должен содержать массив записей'); const result = await api.lists.importAll(parsed); setMessage(`Импортировано ${result.count} записей`); }
    catch (error) { report(error, 'Ошибка импорта'); }
    finally { event.target.value = ''; }
  };

  return <div className="profile-page glass-panel">
    <h1>Профиль</h1>{message && <p className="form-message" role="status">{message}</p>}
    <div className="profile-stats"><p>Фильмов и сериалов в списке: <strong>{stats?.total || 0}</strong></p>{stats && stats.avgRating > 0 && <p>Средняя оценка: <strong>{stats.avgRating.toFixed(1)}</strong></p>}</div>
    <section className="profile-form"><h3>Оформление</h3><ThemePicker /></section>
    {editing ? <form onSubmit={save} className="profile-form"><label>Имя<input value={username} onChange={event => setUsername(event.target.value)} required /></label><label>Email<input value={email} onChange={event => setEmail(event.target.value)} type="email" required /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>Отмена</button><button type="submit" className="primary-button">Сохранить</button></div></form> : <div className="profile-info"><p><strong>{user.username}</strong></p><p>{user.email}</p><button className="secondary-button" onClick={() => setEditing(true)}>Редактировать</button></div>}
    <section className="profile-form streaming-source-setting"><h3>Источник онлайн-просмотра</h3><p className="muted">Если выбранный источник недоступен, KinoLike автоматически попробует второй.</p><div className="streaming-source-options" role="radiogroup" aria-label="Источник онлайн-просмотра">{([['phantom', 'Phantom'], ['videohub', 'VideoHUB']] as const).map(([value, label]) => <label key={value} className={user.preferred_streaming_source === value ? 'selected' : ''}><input type="radio" name="streaming-source" checked={user.preferred_streaming_source === value} onChange={() => void setStreamingSource(value)} /><strong>{label}</strong></label>)}</div></section>
    <form onSubmit={changePassword} className="profile-form"><h3>Изменить пароль</h3><label>Текущий пароль<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label><label>Новый пароль<input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" /></label><button type="submit" className="primary-button" disabled={!currentPassword || !newPassword}>Изменить пароль</button></form>
    <div className="profile-data"><h3>Данные</h3><button className="secondary-button" onClick={() => void exportData()}>Экспорт данных</button><label className="secondary-button">Импорт данных<input type="file" accept="application/json,.json" onChange={importData} hidden /></label></div>
    <button className="secondary-button" onClick={() => void logout().finally(() => navigate('/'))}>Выйти</button>
  </div>;
}
