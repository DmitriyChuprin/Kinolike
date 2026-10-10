import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemePicker, ThemeProvider } from './theme';

describe('ThemeProvider', () => {
  beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; });

  it('switches and persists all theme preferences', () => {
    render(<ThemeProvider><ThemePicker /></ThemeProvider>);
    fireEvent.click(screen.getByRole('radio', { name: 'Светлая' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem('kinolike-theme')).toBe('light');
    fireEvent.click(screen.getByRole('radio', { name: 'Системная' }));
    expect(localStorage.getItem('kinolike-theme')).toBe('system');
  });
});
