import { getAlternativePages } from "~/data/alternative-pages";

interface SiteFooterProps {
  width?: "default" | "prose";
}

export function SiteFooter({ width = "default" }: SiteFooterProps) {
  const widthClasses =
    width === "prose" ? "max-w-prose p-6 md:p-12 md:pt-0" : "max-w-5xl p-6 md:p-20 md:pt-0";
  const alternatives = getAlternativePages();
  return (
    <footer className={`${widthClasses} mx-auto`}>
      <div className="border-t border-white/10 pt-8 pb-4 grid grid-cols-1 sm:grid-cols-3 gap-8 text-sm">
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Product</p>
          <div className="space-y-2">
            <a
              href="/blog"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              Blog
            </a>
            <a
              href="/docs"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </a>
            <a
              href="/docs/cli"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              CLI
            </a>
            <a
              href="/privacy"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              Privacy
            </a>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Agents</p>
          <div className="space-y-2">
            <a
              href="/claude-code"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              Claude Code
            </a>
            <a
              href="/codex"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              Codex
            </a>
            <a
              href="/opencode"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              OpenCode
            </a>
            <a
              href="/agents"
              className="block text-muted-foreground hover:text-foreground transition-colors"
            >
              All providers
            </a>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-white/60 font-medium">Alternatives</p>
          <div className="space-y-2">
            {alternatives.map((page) => (
              <a
                key={page.slug}
                href={page.href}
                className="block text-muted-foreground hover:text-foreground transition-colors"
              >
                {page.name}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
