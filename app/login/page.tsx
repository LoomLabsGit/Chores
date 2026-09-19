import type { Metadata } from "next";
import { SetupNotice } from "@/components/setup-notice";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!hasSupabaseEnv()) return <SetupNotice />;
  const { error } = await searchParams;
  return <LoginForm linkError={error === "link"} />;
}
