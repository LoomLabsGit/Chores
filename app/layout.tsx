import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";
import { ToastProvider } from "@/components/toast";
import { UpdateWatcher } from "@/components/update-watcher";

export const metadata: Metadata = {
  title: { default: "DuoSync", template: "%s · DuoSync" },
  description: "Household chores and habits for two, with points and rewards.",
  applicationName: "DuoSync",
  appleWebApp: { capable: true, title: "DuoSync", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#14121d" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-dvh antialiased">
        <ToastProvider>{children}</ToastProvider>
        <PwaRegister />
        <UpdateWatcher />
      </body>
    </html>
  );
}
