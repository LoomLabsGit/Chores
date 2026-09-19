export function SetupNotice() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6 py-12">
      <h1 className="text-2xl font-extrabold">Connect Supabase to get started</h1>
      <p className="text-muted">
        DuoSync couldn&apos;t find its Supabase settings. Copy <code className="font-mono">.env.example</code> to{" "}
        <code className="font-mono">.env.local</code>, fill in your project URL and publishable key, then restart the dev
        server. On Vercel, add the same variables under Project Settings → Environment Variables.
      </p>
      <p className="text-sm text-muted">
        Don&apos;t forget to run <code className="font-mono">supabase/migrations/0001_init.sql</code> in the Supabase SQL
        editor (or with <code className="font-mono">supabase db push</code>).
      </p>
    </main>
  );
}
