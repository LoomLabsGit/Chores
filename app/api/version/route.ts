// Which build is this server running? The app compares it with the build it is running in the browser, so a
// phone that has been open in the background since before an update can notice and refresh itself.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { version: process.env.NEXT_PUBLIC_APP_VERSION ?? "local" },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
