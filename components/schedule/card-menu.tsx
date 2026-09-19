"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChoreInstance } from "@/lib/types";
import { Icon, type IconName } from "../icons";

export type CardActions = {
  onEdit: (i: ChoreInstance) => void;
  onUncheck: (i: ChoreInstance) => void;
  onDelete: (i: ChoreInstance) => void;
};

type Item = { key: string; label: string; icon: IconName; danger?: boolean; run: () => void };

const ITEM_HEIGHT = 44;
const MENU_WIDTH = 184;

/**
 * The "..." menu on a chore card. What it offers depends on the chore:
 * unfinished -> Edit, Delete; finished -> Uncheck, Delete. (Editing a finished chore would
 * change points that were already paid out, so it has to be unchecked first.)
 * Rendered in a portal so it is never clipped by the card, column or bottom nav.
 */
export function CardMenu({ instance, actions }: { instance: ChoreInstance; actions: CardActions }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const items: Item[] = instance.is_completed
    ? [
        { key: "uncheck", label: "Uncheck", icon: "undo", run: () => actions.onUncheck(instance) },
        { key: "delete", label: "Delete", icon: "trash", danger: true, run: () => actions.onDelete(instance) },
      ]
    : [
        { key: "edit", label: "Edit", icon: "pencil", run: () => actions.onEdit(instance) },
        { key: "delete", label: "Delete", icon: "trash", danger: true, run: () => actions.onDelete(instance) },
      ];

  const open = pos !== null;
  const close = (restoreFocus = true) => {
    setPos(null);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  };

  function toggle() {
    if (open) return close();
    const rect = buttonRef.current!.getBoundingClientRect();
    const height = items.length * ITEM_HEIGHT + 16;
    // Right-align to the button, keep on screen, and flip above if there is no room below
    // (leaving space for the bottom navigation bar).
    const left = Math.min(Math.max(8, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 88 ? Math.max(8, rect.top - 6 - height) : below;
    setPos({ top, left });
  }

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });

    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Tab") {
        close(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const els = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    const onMove = () => close(false); // the position was measured once; do not let it drift
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggle}
        aria-label={`More actions for ${instance.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-11 w-9 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-raised hover:text-ink"
      >
        <Icon name="more" size={20} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${instance.title}`}
            style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
            className="anim-pop-in fixed z-[60] overflow-hidden rounded-2xl border border-line bg-surface p-1 shadow-sheet"
          >
            {items.map((item): ReactNode => (
              <button
                key={item.key}
                role="menuitem"
                onClick={() => {
                  close(false);
                  item.run();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] font-bold hover:bg-raised focus:bg-raised focus:outline-none ${
                  item.danger ? "text-danger" : ""
                }`}
                style={{ minHeight: ITEM_HEIGHT }}
              >
                <Icon name={item.icon} size={18} />
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
