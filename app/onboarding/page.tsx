import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupNotice } from "@/components/setup-notice";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServer } from "@/lib/supabase/server";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your household" };

export default async function OnboardingPage() {
  if (!hasSupabaseEnv()) return <SetupNotice />;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (profile) redirect("/");
  return <OnboardingForm />;
}
