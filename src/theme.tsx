import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  setPreference: (theme: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'kinolike-theme';

function savedPreference(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(savedPreference);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    localStorage.setItem(STORAGE_KEY, preference);
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#071322' : '#e9f2fa');
  }, [preference, resolved]);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme должен использоваться внутри ThemeProvider');
  return context;
}

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  const themes: { value: ThemePreference; label: string }[] = [
    { value: 'light', label: 'Светлая' },
    { value: 'dark', label: 'Тёмная' },
    { value: 'system', label: 'Системная' },
  ];
  return <div className={`theme-picker ${compact ? 'compact' : ''}`} role="radiogroup" aria-label="Цветовая тема">
    {!compact && <span>Тема</span>}
    {themes.map((theme) => <button key={theme.value} type="button" role="radio" aria-checked={preference === theme.value} className={preference === theme.value ? 'active' : ''} onClick={() => setPreference(theme.value)}>{theme.label}</button>)}
  </div>;
}
