import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(dialogRef: RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>(focusableSelector)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!controls.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); opener?.focus(); };
  }, [dialogRef, onClose]);
}

export function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, onClose);

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className={`glass-panel ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть диалог">×</button>
      <h2 id={titleId}>{title}</h2>
      {children}
    </div>
  </div>;
}
