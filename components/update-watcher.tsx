"use client";

import { useEffect, useState } from "react";

/** The build this copy of the app was made from (set at build time; see next.config.ts). */
const BUNDLED = process.env.NEXT_PUBLIC_APP_VERSION;
const RELOADED_KEY = "duosync-reloaded-for";
const CHECK_EVERY_MS = 10 * 60 * 1000;

/**
 * An installed phone app can stay open in the background for days, running the code it first loaded. When a new
 * version has been deployed, that copy is stale: it can be missing buttons and screens the other person already
 * has. This notices, and brings the app up to date:
 *   - coming back to the app: refresh at once, unless a sheet or dialog is open (never lose someone's input);
 *   - otherwise (or on the timer): show a small "Refresh" bar and let them choose.
 * It does nothing in development, or where the build ID is unknown, so it can never cause a reload loop.
 */
export function UpdateWatcher() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !BUNDLED || BUNDLED === "local") return;
    let cancelled = false;

    async function check(comingBack: boolean) {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (cancelled || !version || version === "local" || version === BUNDLED) return;

        const idle = !document.querySelector('[role="dialog"]');
        let alreadyTried = false;
        try {
          alreadyTried = sessionStorage.getItem(RELOADED_KEY) === version;
        } catch {
          /* storage blocked: fall back to the bar */
          alreadyTried = true;
        }
        if (comingBack && idle && !alreadyTried) {
          try {
            sessionStorage.setItem(RELOADED_KEY, version); // one automatic refresh per version, never a loop
          } catch {
            /* ignore */
          }
          location.reload();
          return;
        }
        setStale(true);
      } catch {
        /* offline: try again next time */
      }
    }

    void check(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check(false);
    }, CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[70] flex justify-center px-3"
    >
      <div className="flex items-center gap-3 rounded-full bg-ink py-1.5 pl-4 pr-1.5 text-sm font-bold text-app shadow-sheet">
        A new version is ready
        <button
          onClick={() => location.reload()}
          className="min-h-9 rounded-full bg-brand px-4 font-extrabold text-brand-ink"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
