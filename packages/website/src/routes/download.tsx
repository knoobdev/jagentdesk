import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/download")({
  head: () =>
    pageMeta(
      "Build JAgentDesk",
      "Build the JAgentDesk desktop and mobile applications from this workspace.",
      "/download",
    ),
  component: Download,
});

function Download() {
  return (
    <SiteShell width="default">
      <h1 className="text-3xl md:text-4xl font-semibold tracking-tight mb-2">Build JAgentDesk</h1>
      <p className="text-muted-foreground mb-10">
        This project does not publish artifacts through a public release or app-store endpoint.
        Build the applications locally from the workspace instead.
      </p>

      <div className="space-y-6">
        <section className="rounded-xl border border-border bg-card/40 p-6 md:p-8">
          <h2 className="text-2xl font-semibold mb-3">Desktop</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Build the Electron application for the current desktop platform.
          </p>
          <code className="block rounded-lg bg-black/30 p-4 text-sm">npm run build:desktop</code>
        </section>

        <section className="rounded-xl border border-border bg-card/40 p-6 md:p-8">
          <h2 className="text-2xl font-semibold mb-3">Mobile</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Build the iOS or Android application from the Expo workspace with the configured EAS
            profile.
          </p>
          <code className="block rounded-lg bg-black/30 p-4 text-sm">
            cd packages/app && eas build --platform ios
          </code>
        </section>
      </div>
    </SiteShell>
  );
}
