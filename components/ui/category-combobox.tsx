"use client";

import { useEffect, useId, useRef, useState } from "react";
import { categoryOptions, MAX_CATEGORY_LENGTH, resolveCategory } from "@/lib/logic/library";
import { Icon } from "../icons";
import { fieldClass } from "./controls";

/**
 * A category picker that starts empty. Open it with nothing typed and you get every category,
 * alphabetically; type and the list narrows live. Something that doesn't exist yet is offered as
 * "Create ..."; something that does exist is right there to press.
 *
 * The value is simply the text in the box (so nothing typed is ever lost); the list is a helper that
 * fills it in with the existing spelling. Text that matches no category is flagged "New category".
 * The list opens in the page flow rather than floating, so a bottom sheet's scroll area never clips it.
 */
export function CategoryCombobox({
  id,
  value,
  onChange,
  categories,
  placeholder = "Choose or create a category",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Existing categories. */
  categories: string[];
  placeholder?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  // Until something is typed, opening shows everything, even if the box already holds a category.
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);

  const query = typing ? value : "";
  const { matches, create } = categoryOptions(categories, query);
  const options = [
    ...matches.map((label) => ({ key: `c:${label}`, label, create: false })),
    ...(create ? [{ key: "new", label: create, create: true }] : []),
  ];
  const isNew = !!value.trim() && !categories.some((c) => c.toLowerCase() === value.trim().toLowerCase());

  /**
   * Where the highlight starts: nowhere while the box is empty (nothing is pre-selected), otherwise the exact
   * match, else the first option, so Enter takes the obvious one.
   */
  function startIndex(nextQuery: string) {
    if (!nextQuery.trim()) return -1;
    const opts = categoryOptions(categories, nextQuery);
    const exact = opts.matches.findIndex((c) => c.toLowerCase() === nextQuery.trim().toLowerCase());
    return exact >= 0 ? exact : 0;
  }

  function openList() {
    if (open) return;
    setTyping(false);
    setActive(startIndex(value)); // on the current category if there is one
    setOpen(true);
  }

  function choose(i: number) {
    const opt = options[i];
    if (!opt) return;
    onChange(opt.label);
    setTyping(false);
    setOpen(false);
  }

  function close() {
    setOpen(false);
    setTyping(false);
    // Tidy what was typed: an existing category keeps its spelling ("kitchen" -> "Kitchen").
    const tidy = resolveCategory(categories, value);
    if (tidy !== value) onChange(tidy);
  }

  // Bring the list into view when it opens, and keep the highlighted option visible.
  useEffect(() => {
    if (open) listRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        if (!value.trim()) setActive(e.key === "ArrowDown" ? 0 : Math.max(options.length - 1, 0)); // open AND land on an option
        return;
      }
      if (options.length) {
        const down = e.key === "ArrowDown";
        setActive((i) => (i < 0 ? (down ? 0 : options.length - 1) : (i + (down ? 1 : -1) + options.length) % options.length));
      }
    } else if (e.key === "Enter" && open && active >= 0 && options[active]) {
      e.preventDefault(); // choose an option instead of submitting the form behind it
      choose(active);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // close the list, not the sheet
      close();
    }
  }

  return (
    <div
      ref={rootRef}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={value}
          maxLength={MAX_CATEGORY_LENGTH}
          placeholder={placeholder}
          onFocus={openList}
          onClick={openList}
          onChange={(e) => {
            onChange(e.target.value);
            setTyping(true);
            setActive(startIndex(e.target.value));
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={`${fieldClass} pr-24`}
        />
        <div className="absolute inset-y-0 right-1 flex items-center">
          {value && (
            <button
              type="button"
              aria-label="Clear category"
              onClick={() => {
                onChange("");
                setTyping(false);
                inputRef.current?.focus();
              }}
              className="flex h-11 w-9 items-center justify-center rounded-full text-muted hover:text-ink"
            >
              <Icon name="x" size={16} />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? "Hide categories" : "Show all categories"}
            onMouseDown={(e) => e.preventDefault()} // keep focus in the box
            onClick={() => (open ? close() : (inputRef.current?.focus(), openList()))}
            className="flex h-11 w-9 items-center justify-center rounded-full text-muted hover:text-ink"
          >
            <Icon name="chevron-down" size={18} />
          </button>
        </div>
      </div>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Categories"
          onMouseDown={(e) => e.preventDefault()} // pressing an option must not blur the box first
          className="mt-2 max-h-56 overflow-y-auto rounded-2xl border border-line bg-surface p-1 shadow-card"
        >
          {options.length === 0 && (
            <li className="px-3 py-3 text-sm font-semibold text-muted">No categories yet. Type a name to create the first one.</li>
          )}
          {options.map((opt, i) => (
            <li
              key={opt.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-3 text-[15px] font-bold ${
                i === active ? "bg-brand-soft text-brand" : ""
              }`}
            >
              {opt.create ? (
                <>
                  <Icon name="plus" size={16} strokeWidth={2.6} />
                  <span className="min-w-0 truncate">
                    Create &ldquo;{opt.label}&rdquo;
                  </span>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {opt.label.toLowerCase() === value.trim().toLowerCase() && <Icon name="check" size={16} strokeWidth={3} />}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!open && isNew && (
        <p className="mt-1.5 text-xs font-bold text-brand">
          New category &ldquo;{value.trim()}&rdquo; will be created.
        </p>
      )}
      {!open && !value.trim() && (
        <p className="mt-1.5 text-xs font-semibold text-muted">Optional. Left empty, it is filed under General.</p>
      )}
    </div>
  );
}
