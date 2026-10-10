import { useEffect, useState } from 'react';
import { GlassPanel } from '../components/ui';
import { useAuth } from '../App';
import { api } from '../services/api';
import type { User } from '../types';

export function AdminUsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { if (user?.is_admin) api.admin.users().then(({ users }) => setUsers(users)).catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить пользователей')); }, [user?.is_admin]);
  if (!user?.is_admin) return <div className="empty-page glass-panel"><h1>Нет доступа</h1></div>;
  const toggle = async (target: User) => {
    setBusy(target.id); setError('');
    try { const result = await api.admin.setJellyfinEnabled(target.id, !target.jellyfin_enabled); setUsers(items => items.map(item => item.id === target.id ? result.user : item)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось изменить доступ'); }
    finally { setBusy(null); }
  };
  return <GlassPanel className="profile-page"><h1>Пользователи</h1>{error && <p className="form-message">{error}</p>}<div className="admin-users">{users.map(target => <div className="profile-info" key={target.id}><div><strong>{target.username}</strong><p>{target.email}</p></div><div><p>Jellyfin: <strong>{target.jellyfin_enabled ? 'включён' : 'выключен'}</strong></p><button className="secondary-button" disabled={busy === target.id} onClick={() => void toggle(target)}>{target.jellyfin_enabled ? 'Выключить' : 'Включить'}</button></div></div>)}</div></GlassPanel>;
}
