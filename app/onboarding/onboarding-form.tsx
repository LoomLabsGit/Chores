"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fieldClass, primaryButton, Segmented } from "@/components/ui/controls";
import { friendlyError } from "@/lib/errors";
import { getSupabase } from "@/lib/supabase/client";

export function OnboardingForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getSupabase();
    const { error } =
      mode === "create"
        ? await supabase.rpc("create_household", { p_display_name: name, p_household_name: householdName || null })
        : await supabase.rpc("join_household", { p_display_name: name, p_invite_code: code });
    if (error) {
      setError(friendlyError(error));
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-extrabold">Welcome! Let&apos;s set up your home</h1>
        <p className="mt-2 text-muted">One of you starts the household, the other joins with its invite code.</p>
      </div>

      <Segmented
        label="Household setup"
        value={mode}
        onChange={setMode}
        options={[
          { value: "create", label: "Start one" },
          { value: "join", label: "Join partner" },
        ]}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-bold">
          Your name
          <input
            required
            maxLength={30}
            autoComplete="given-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            placeholder="e.g. Alex"
          />
        </label>

        {mode === "create" ? (
          <label className="flex flex-col gap-1.5 text-sm font-bold">
            <span>
              Household name <span className="font-medium text-muted">(optional)</span>
            </span>
            <input
              maxLength={40}
              value={householdName}
              onChange={(e) => setHouseholdName(e.target.value)}
              className={fieldClass}
              placeholder="Our household"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5 text-sm font-bold">
            Invite code
            <input
              required
              maxLength={12}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className={`${fieldClass} font-mono tracking-[0.3em]`}
              placeholder="ABC123"
            />
          </label>
        )}

        {error && (
          <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "One moment…" : mode === "create" ? "Create household" : "Join household"}
        </button>
      </form>

      <button
        type="button"
        onClick={async () => {
          await getSupabase().auth.signOut();
          window.location.assign("/login");
        }}
        className="min-h-11 text-sm font-bold text-muted"
      >
        Use a different account
      </button>
    </main>
  );
}
