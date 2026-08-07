import "~/styles.css";

export function SiteHeader() {
  return (
    <header className="flex flex-col items-center gap-4 md:flex-row md:justify-between">
      <a href="/" className="flex items-center gap-3">
        <img src="/logo.svg" alt="JAgentDesk" className="w-6 h-6" />
        <span className="text-lg font-medium">JAgentDesk</span>
      </a>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <a
          href="/blog"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Blog
        </a>
        <a
          href="/docs"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Docs
        </a>
        <a
          href="/download"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Download
        </a>
      </div>
    </header>
  );
}
