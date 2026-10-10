import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { Modal } from './Modal';

describe('Modal', () => {
  it('has dialog semantics and closes on Escape', () => {
    const close = vi.fn();
    render(<Modal title="Подтверждение" onClose={close}><button>Продолжить</button></Modal>);
    expect(screen.getByRole('dialog', { name: 'Подтверждение' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('has no detectable accessibility violations', async () => {
    render(<Modal title="Оценка" onClose={() => undefined}><label>Заметка<textarea /></label><button>Сохранить</button></Modal>);
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
