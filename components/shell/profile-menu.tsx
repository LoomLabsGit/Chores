"use client";

import { useEffect, useRef, useState } from "react";
import { useHousehold } from "@/lib/store/household-store";
import { useToast } from "../toast";
import { Icon } from "../icons";
import { Avatar } from "../ui/controls";

/** Who is signed in on this device, plus household details and sign out. */
export function ProfileMenu() {
  const { me, state, tone, actions } = useHousehold();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const code = state.household?.invite_code;
  const soloHousehold = state.members.length < 2;

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast("Invite code copied", "success");
    } catch {
      toast(`Your invite code is ${code}`);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-11 items-center gap-2 rounded-full pl-1 pr-2.5 hover:bg-raised"
      >
        <Avatar name={me.display_name} tone={tone(me.id)} size={34} />
        <span className="max-w-[9rem] truncate text-[15px] font-extrabold">{me.display_name}</span>
        <Icon name="chevron-down" size={16} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="anim-pop-in absolute left-0 top-[calc(100%+0.5rem)] z-50 w-72 overflow-hidden rounded-3xl border border-line bg-surface shadow-sheet"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-muted">{state.household?.name}</p>
          </div>
          <ul className="px-2 py-2">
            {state.members.map((m) => (
              <li key={m.id} className="flex min-h-12 items-center gap-3 rounded-2xl px-2">
                <Avatar name={m.display_name} tone={tone(m.id)} size={32} />
                <span className="min-w-0 flex-1 truncate font-bold">
                  {m.display_name}
                  {m.id === me.id && <span className="ml-1.5 text-xs font-semibold text-muted">you</span>}
                </span>
                <span className="text-sm font-extrabold tabular-nums text-gold">{m.points} pts</span>
              </li>
            ))}
          </ul>

          {soloHousehold && code && (
            <div className="mx-3 mb-2 rounded-2xl bg-brand-soft p-3">
              <p className="text-sm font-bold text-brand">Invite your partner</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-xl bg-surface px-3 py-2 text-center font-mono text-lg font-extrabold tracking-[0.3em]">
                  {code}
                </code>
                <button
                  onClick={copyCode}
                  aria-label="Copy invite code"
                  className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-brand-ink"
                >
                  <Icon name="copy" size={18} />
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">They choose &ldquo;Join partner&rdquo; after creating an account.</p>
            </div>
          )}

          <button
            role="menuitem"
            onClick={() => void actions.signOut()}
            className="flex min-h-12 w-full items-center gap-3 border-t border-line px-5 text-sm font-bold text-muted hover:bg-raised"
          >
            <Icon name="logout" size={18} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
