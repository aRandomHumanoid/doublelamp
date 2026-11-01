// Modal dialog on the native <dialog> element: focus trap, Esc and the backdrop come from the browser.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cls } from "../lib/format";
import { IconX } from "./Icons";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Mount it to open it, unmount it to close it. showModal() moves focus to the first focusable element;
 * put `data-autofocus` on an element to focus that one instead (React's autoFocus runs too early here).
 */
export function Dialog({ title, onClose, children, footer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (d.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={cls("dialog", className)}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className={cls("btn", danger ? "btn-danger" : "btn-primary")}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
