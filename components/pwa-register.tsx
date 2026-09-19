"use client";

import { useEffect } from "react";

/** Registers the tiny offline-shell service worker (production only, so dev HMR is never cached). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* installability is a nice-to-have; ignore failures */
    });
  }, []);
  return null;
}
