"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";

type Variant = "sheet" | "center" | "drawer";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** sheet: bottom sheet on phones, centred modal on desktop. */
  variant?: Variant;
  /** Docked under the scrolling body (e.g. the Add Chore input). */
  footer?: ReactNode;
  /** Extra content placed beside the title in the header. */
  headerExtra?: ReactNode;
  children: ReactNode;
};

// Stack so Escape only closes the top-most layer and scroll lock is ref-counted.
const stack: symbol[] = [];
let lockCount = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, variant = "sheet", footer, headerExtra, children }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const id = Symbol("modal");
    stack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (lockCount++ === 0) document.body.style.overflow = "hidden";

    // Focus the first control that is not the close button, else the panel itself.
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel;
    first?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && panel) {
        const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return e.preventDefault();
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(id), 1);
      if (--lockCount === 0) document.body.style.overflow = "";
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const layout =
    variant === "drawer"
      ? "justify-end items-stretch"
      : variant === "center"
        ? "items-center justify-center p-4"
        : "items-end justify-center md:items-center md:p-4";
  const panel =
    variant === "drawer"
      ? "anim-drawer h-full w-full max-w-md rounded-l-3xl md:w-[26rem]"
      : variant === "center"
        ? "anim-pop-in w-full max-w-sm rounded-3xl max-h-[85dvh]"
        : "anim-sheet w-full max-h-[92dvh] rounded-t-3xl md:max-w-lg md:rounded-3xl md:max-h-[85dvh]";

  return createPortal(
    <div className={`fixed inset-0 z-50 flex ${layout}`}>
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex flex-col overflow-hidden bg-surface shadow-sheet outline-none ${panel}`}
      >
        {variant === "sheet" && (
          <div aria-hidden className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-line md:hidden" />
        )}
        <header className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-lg font-extrabold">
            {title}
          </h2>
          {headerExtra}
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-line bg-surface px-5 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} variant="center">
      <p className="pb-4 text-[15px] leading-relaxed text-muted">{message}</p>
      <div className="flex gap-3">
        <button
          onClick={onCancel}
          data-autofocus
          className="min-h-12 flex-1 rounded-2xl border border-line font-bold hover:bg-raised"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className={`min-h-12 flex-1 rounded-2xl font-bold text-white ${danger ? "bg-danger" : "bg-brand text-brand-ink"}`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
