"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

type Tone = "info" | "success" | "error" | "points";
type Toast = { id: number; message: string; tone: Tone };

type ToastApi = {
  toast: (message: string, tone?: Tone) => void;
  /** Confetti burst for milestone moments (challenge complete). */
  celebrate: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_STYLES: Record<Tone, string> = {
  info: "bg-ink text-app",
  success: "bg-ok text-white",
  error: "bg-danger text-white",
  points: "bg-gold-soft text-gold border border-gold/30",
};

const CONFETTI_COLORS = ["#e5553f", "#0f9488", "#5b4bdb", "#f2b84b", "#ff7a66", "#2dd4bf"];

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [burst, setBurst] = useState(0);
  const nextId = useRef(1);

  const toast = useCallback((message: string, tone: Tone = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 5000 : 3200);
  }, []);

  const celebrate = useCallback(() => {
    setBurst((b) => b + 1);
    window.setTimeout(() => setBurst(0), 3200);
  }, []);

  const api = useMemo(() => ({ toast, celebrate }), [toast, celebrate]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {burst > 0 && <Confetti key={burst} />}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={`anim-toast pointer-events-auto flex max-w-md items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold shadow-sheet ${TONE_STYLES[t.tone]}`}
          >
            {t.tone === "success" && <Icon name="check" size={18} />}
            {t.tone === "points" && <Icon name="star" size={18} />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Confetti() {
  // Random values are generated once per burst (lazy initial state keeps render pure).
  const [pieces] = useState(() =>
    Array.from({ length: 46 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 1.8 + Math.random() * 1.4,
      size: 7 + Math.random() * 7,
      dx: `${(Math.random() - 0.5) * 160}px`,
      rot: `${360 + Math.random() * 540}deg`,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      round: i % 3 === 0,
    })),
  );
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[80] overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti-piece absolute top-0 block"
          style={
            {
              left: `${p.left}%`,
              width: p.size,
              height: p.size * (p.round ? 1 : 0.45),
              borderRadius: p.round ? 999 : 2,
              background: p.color,
              animation: `confetti-fall ${p.duration}s ${p.delay}s cubic-bezier(0.25, 0.6, 0.4, 1) forwards`,
              "--dx": p.dx,
              "--rot": p.rot,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
