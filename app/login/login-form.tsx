"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fieldClass, primaryButton } from "@/components/ui/controls";
import { friendlyError } from "@/lib/errors";
import { getSupabase } from "@/lib/supabase/client";

export function LoginForm({ linkError }: { linkError: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(linkError ? "That confirmation link has expired. Try signing in." : null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = getSupabase();
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice("Check your inbox for a confirmation link, then come back and sign in.");
          setMode("signin");
          return;
        }
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(friendlyError(err as Error));
    } finally {
      setBusy(false);
    }
  }

  const signup = mode === "signup";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="relative h-16 w-16 rounded-[1.4rem] bg-brand" aria-hidden>
          <span className="absolute left-3 top-4 h-7 w-7 rounded-full bg-a" />
          <span className="absolute right-3 top-4 h-7 w-7 rounded-full bg-b opacity-90" />
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight">DuoSync</h1>
        <p className="text-muted">Chores and habits for two. Fair splits, real rewards.</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-bold">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
            placeholder="you@example.com"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-bold">
          Password
          <input
            type="password"
            required
            minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
            placeholder={signup ? "At least 8 characters" : "Your password"}
          />
        </label>

        {error && (
          <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-2xl bg-ok-soft px-4 py-3 text-sm font-semibold text-ok">
            {notice}
          </p>
        )}

        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "One moment…" : signup ? "Create account" : "Sign in"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(signup ? "signin" : "signup");
          setError(null);
        }}
        className="min-h-11 text-sm font-bold text-brand"
      >
        {signup ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
    </main>
  );
}
