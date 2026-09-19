import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { SetupNotice } from "@/components/setup-notice";
import { HouseholdProvider } from "@/lib/store/household-store";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServer } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!hasSupabaseEnv()) return <SetupNotice />;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) redirect("/onboarding");

  // This layout is kept across tab changes, so the store (and its realtime
  // subscription) is created once per visit.
  return (
    <HouseholdProvider userId={user.id}>
      <AppShell>{children}</AppShell>
    </HouseholdProvider>
  );
}
