import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Identifies this build, in the browser and on the server, so an installed app can tell when it is out of date
  // (see components/update-watcher.tsx). Vercel sets the commit; anywhere else it is "local" and the check is off.
  env: { NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA ?? "local" },
};

export default nextConfig;
