import * as React from "react";
import {
  motion,
  AnimatePresence,
  useInView,
  useScroll,
  useTransform,
  type Transition,
} from "framer-motion";

// Shared motion presets — hoisted so every JSX site receives the same object
// reference and doesn't trigger jsx-no-new-object-as-prop.
const FADE_IN_UP = { opacity: 0, y: 20 };
const FADE_IN = { opacity: 1, y: 0 };
const FADE_IN_UP_TINY = { opacity: 0, y: -10 };
const FADE_IN_UP_XL = { opacity: 0, y: 30 };
const FADE_IN_UP_40 = { opacity: 0, y: 40 };
const FADE_IN_UP_4 = { opacity: 0, y: 4 };
const FADE_OUT_UP_4 = { opacity: 0, y: 4 };

const EASE_OUT_06_DELAY_01: Transition = { duration: 0.6, delay: 0.1, ease: "easeOut" };
const EASE_OUT_08_DELAY_05: Transition = { duration: 0.8, delay: 0.5, ease: "easeOut" };
const EASE_OUT_05: Transition = { duration: 0.5, ease: "easeOut" };
const EASE_OUT_015: Transition = { duration: 0.15, ease: "easeOut" };
const DURATION_05: Transition = { duration: 0.5 };

const VIEWPORT_60 = { once: true, margin: "-60px" };

const SVG_OVERFLOW_VISIBLE_STYLE = { overflow: "visible" as const };
const PHONE_PERSPECTIVE_STYLE = { minHeight: 480, perspective: 1200 };
import { CursorFieldProvider } from "~/components/butterfly";
import { CommandDialog } from "~/components/command-dialog";
import { AGENT_PAGES } from "~/data/agent-pages";
import { TerminalIcon } from "~/downloads";
import { HeroMockup } from "~/components/hero-mockup";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  OpenCodeIcon,
  PiIcon,
} from "~/components/agent-icons";
import { ClaudeIcon } from "~/components/mockup";
import { FAQItem } from "~/components/faq-item";
import { SiteFooter } from "~/components/site-footer";
import { SiteHeader } from "~/components/site-header";
import "~/styles.css";

interface LandingPageProps {
  title: React.ReactNode;
  subtitle: string;
}

export function LandingPage({ title, subtitle }: LandingPageProps) {
  return (
    <CursorFieldProvider>
      {/* Hero section with background image */}
      <div className="relative bg-cover bg-center bg-no-repeat">
        <div className="relative p-6 pb-10 md:px-32 md:pt-20 md:pb-12 max-w-7xl mx-auto">
          <Nav />
          <Hero title={title} subtitle={subtitle} />
          <GetStarted />
        </div>

        {/* Mockup - inside hero so it's above the gradient, positioned to overflow into black section */}
        <motion.div
          initial={FADE_IN_UP_40}
          animate={FADE_IN}
          transition={EASE_OUT_08_DELAY_05}
          className="relative px-6 md:px-8 pb-8 md:pb-16"
        >
          <div className="max-w-7xl mx-auto">
            <HeroMockup />
          </div>
        </motion.div>
      </div>

      {/* Phone showcase */}
      <PhoneShowcase />

      {/* Content section */}
      <div className="landing-content bg-background">
        <main className="p-6 md:p-20 md:pt-40 max-w-5xl mx-auto">
          <div className="space-y-24">
            <MultiProviderSection />
            <SelfHostedSection />
            <WorkflowSection />
            <CLISection />
            <FAQ />
          </div>
        </main>
        <SiteFooter />
      </div>
    </CursorFieldProvider>
  );
}

function Nav() {
  return (
    <nav className="mb-16">
      <SiteHeader />
    </nav>
  );
}

function Hero({ title, subtitle }: { title: React.ReactNode; subtitle: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl md:text-5xl font-medium tracking-tight">{title}</h1>
      <p className="text-white/70 text-lg leading-relaxed max-w-lg">{subtitle}</p>
    </div>
  );
}

const CLAUDE_CODE_BADGE_ICON = <ClaudeCodeIcon className="h-6 w-6" />;
const CODEX_BADGE_ICON = <CodexIcon className="h-6 w-6" />;
const OPENCODE_BADGE_ICON = <OpenCodeIcon className="h-6 w-6" />;
const PI_BADGE_ICON = <PiIcon className="h-6 w-6" />;
const CURSOR_BADGE_ICON = <CursorIcon className="h-6 w-6" />;

const FEATURED_AGENT_COUNT = 5;
const ADDITIONAL_AGENT_COUNT = AGENT_PAGES.length - FEATURED_AGENT_COUNT;

function AgentBadge({ name, icon }: { name: string; icon: React.ReactNode }) {
  const [hovered, setHovered] = React.useState(false);
  const handleMouseEnter = React.useCallback(() => setHovered(true), []);
  const handleMouseLeave = React.useCallback(() => setHovered(false), []);

  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full p-1.5 text-white/60"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {icon}
      <AnimatePresence>
        {hovered && (
          <motion.span
            initial={FADE_IN_UP_4}
            animate={FADE_IN}
            exit={FADE_OUT_UP_4}
            transition={EASE_OUT_015}
            className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-white text-black text-xs whitespace-nowrap pointer-events-none"
          >
            {name}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function FeatureSection({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
    >
      <SectionTitle title={title} description={description} badge={badge} />
      {children}
    </motion.section>
  );
}

function SectionTitle({
  title,
  description,
  badge,
}: {
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <div className="mb-12 space-y-2">
      <div className="flex items-center gap-3">
        <h2 className="text-3xl font-medium">{title}</h2>
        {badge && (
          <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
            {badge}
          </span>
        )}
      </div>
      <p className="text-base text-muted-foreground max-w-lg">{description}</p>
    </div>
  );
}

function MultiProviderSection() {
  const providers = [
    { name: "Claude Code", icon: <ClaudeIcon size={28} /> },
    { name: "Codex", icon: <CodexIcon className="w-7 h-7" /> },
    { name: "OpenCode", icon: <OpenCodeIcon className="w-7 h-7" /> },
    { name: "Pi", icon: <PiIcon className="w-7 h-7" /> },
    { name: "Cursor", icon: <CursorIcon className="w-7 h-7" /> },
  ];

  return (
    <FeatureSection
      title="Works with your tools"
      description="Run your agents from one interface. JAgentDesk uses each provider's native harness, so your subscriptions, skills, config, and MCP servers keep working."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {providers.map((p) => (
          <div
            key={p.name}
            className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
          >
            <span className="text-white/80">{p.icon}</span>
            <span className="font-medium">{p.name}</span>
          </div>
        ))}
        <a
          href="/agents"
          className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-5 py-4 text-white/50 hover:text-white/80 hover:border-white/20 hover:bg-white/[0.03] transition-colors"
        >
          <span className="font-medium">+{ADDITIONAL_AGENT_COUNT} more</span>
        </a>
      </div>
    </FeatureSection>
  );
}

function SelfHostedDiagram() {
  const clients = [
    {
      name: "Desktop",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      ),
    },
    {
      name: "Web",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
    },
    {
      name: "Mobile",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5" y="2" width="14" height="20" rx="2" />
          <path d="M12 18h.01" />
        </svg>
      ),
    },
    {
      name: "CLI",
      icon: (
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
    },
  ];
  const hosts = ["MacBook Pro", "Hetzner VM", "Dev server"];
  const containerRef = React.useRef<HTMLDivElement>(null);
  const clientRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const hostRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const centerRef = React.useRef<HTMLDivElement>(null);

  const setClientRef = React.useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      clientRefs.current[index] = el;
    },
    [],
  );
  const setHostRef = React.useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      hostRefs.current[index] = el;
    },
    [],
  );
  const [paths, setPaths] = React.useState<{ left: string[]; right: string[] }>({
    left: [],
    right: [],
  });

  React.useEffect(() => {
    function computePaths() {
      const container = containerRef.current;
      const center = centerRef.current;
      if (!container || !center) return;

      const cRect = container.getBoundingClientRect();
      const mRect = center.getBoundingClientRect();
      const midL = mRect.left - cRect.left;
      const midR = mRect.right - cRect.left;
      const midY = mRect.top - cRect.top + mRect.height / 2;

      const left = clientRefs.current.map((el) => {
        if (!el) return "";
        const r = el.getBoundingClientRect();
        const x1 = r.right - cRect.left;
        const y1 = r.top - cRect.top + r.height / 2;
        const cpx = x1 + (midL - x1) * 0.6;
        return `M${x1},${y1} C${cpx},${y1} ${midL - (midL - x1) * 0.3},${midY} ${midL},${midY}`;
      });

      const right = hostRefs.current.map((el) => {
        if (!el) return "";
        const r = el.getBoundingClientRect();
        const x2 = r.left - cRect.left;
        const y2 = r.top - cRect.top + r.height / 2;
        const cpx = midR + (x2 - midR) * 0.4;
        return `M${midR},${midY} C${cpx},${midY} ${x2 - (x2 - midR) * 0.3},${y2} ${x2},${y2}`;
      });

      setPaths({ left, right });
    }

    computePaths();
    window.addEventListener("resize", computePaths);
    return () => window.removeEventListener("resize", computePaths);
  }, []);

  return (
    <>
      {/* Mobile: vertical stack */}
      <div className="md:hidden flex flex-col items-center gap-4 py-4">
        <div className="space-y-2 w-full">
          {clients.map((c) => (
            <div
              key={c.name}
              className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
            >
              <span className="text-white/80">{c.icon}</span>
              <span className="font-medium">{c.name}</span>
            </div>
          ))}
        </div>
        <div className="w-px h-6 border-l border-dashed border-white/25" />
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-5 text-center space-y-1">
          <p className="text-xs font-medium text-white/50">Tailscale + Device Pairing</p>
          <p className="text-[10px] text-white/25">or</p>
          <p className="text-xs font-medium text-white/50">Direct Connection</p>
        </div>
        <div className="w-px h-6 border-l border-dashed border-white/25" />
        <div className="space-y-2 w-full">
          {hosts.map((h) => (
            <div
              key={h}
              className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
            >
              <span className="text-white/80">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                  <circle cx="6" cy="6" r="1" />
                  <circle cx="6" cy="18" r="1" />
                </svg>
              </span>
              <span className="font-medium">{h}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop: horizontal with bezier curves */}
      <div ref={containerRef} className="relative hidden md:flex items-center py-4 gap-0">
        {/* SVG curves */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={SVG_OVERFLOW_VISIBLE_STYLE}
        >
          {[...paths.left, ...paths.right].map(
            (d) =>
              d && (
                <path
                  key={d}
                  d={d}
                  fill="none"
                  stroke="rgba(255,255,255,0.25)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
              ),
          )}
        </svg>

        {/* Clients */}
        <div className="space-y-3 flex-shrink-0 relative z-10">
          {clients.map((c, i) => (
            <div
              key={c.name}
              ref={setClientRef(i)}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 backdrop-blur-sm"
            >
              <span className="text-white/80">{c.icon}</span>
              <span className="font-medium">{c.name}</span>
            </div>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Center label */}
        <div
          ref={centerRef}
          className="flex-shrink-0 rounded-xl border border-white/10 bg-white/[0.03] px-8 py-6 text-center space-y-1.5 relative z-10 backdrop-blur-sm"
        >
          <p className="text-sm font-medium text-white/50">Tailscale + Device Pairing</p>
          <p className="text-xs text-white/25">or</p>
          <p className="text-sm font-medium text-white/50">Direct Connection</p>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Hosts */}
        <div className="space-y-3 flex-shrink-0 relative z-10">
          {hosts.map((h, i) => (
            <div
              key={h}
              ref={setHostRef(i)}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4 backdrop-blur-sm"
            >
              <span className="text-white/80">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                  <circle cx="6" cy="6" r="1" />
                  <circle cx="6" cy="18" r="1" />
                </svg>
              </span>
              <span className="font-medium">{h}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SelfHostedSection() {
  return (
    <FeatureSection
      title="Runs where you work"
      description="Start agents on your laptop, a VM, or a dev server. Use them from any device over a direct Tailscale connection."
    >
      <SelfHostedDiagram />
    </FeatureSection>
  );
}

const WORKFLOW_STEPS = ["Worktree", "Preview", "Review", "Commit", "PR", "Merge"] as const;

const REVIEW_FILES = [
  { path: "src/auth/session.ts", delta: "+42" },
  { path: "src/auth/middleware.ts", delta: "+18 -9" },
  { path: "tests/auth.test.ts", delta: "+31" },
] as const;

function WorkflowSection() {
  return (
    <FeatureSection
      title="Review, preview, ship"
      description="Create branches, preview the app in the browser, review the diff inline, then commit, open a PR, and merge without leaving JAgentDesk."
    >
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <WorkflowHeader />
        <div className="grid gap-4 p-4 md:grid-cols-[1.1fr_0.9fr]">
          <WorkflowPreview />
          <WorkflowReviewAndShip />
        </div>
      </div>
    </FeatureSection>
  );
}

function WorkflowHeader() {
  return (
    <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2.5">
        <div className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-sm text-white/80">fix-auth</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/40">worktree</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-white/40">
        {WORKFLOW_STEPS.map((step) => (
          <span key={step} className="rounded-full border border-white/10 px-2 py-1">
            {step}
          </span>
        ))}
      </div>
    </div>
  );
}

function WorkflowPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/20">
      <BrowserChrome />
      <div className="space-y-5 p-5">
        <PreviewHeader />
        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewFormCard titleWidth="w-16" ctaClassName="bg-white/[0.06]" />
          <PreviewFormCard titleWidth="w-20" ctaClassName="bg-emerald-400/20" />
        </div>
      </div>
    </div>
  );
}

function BrowserChrome() {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
      </div>
      <div className="min-w-0 flex-1 rounded-md bg-black/30 px-2 py-1 text-center font-mono text-[10px] text-white/35">
        web.fix-auth.my-app.localhost
      </div>
    </div>
  );
}

function PreviewHeader() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-28 rounded-full bg-white/25" />
      <div className="h-2 w-44 rounded-full bg-white/10" />
    </div>
  );
}

function PreviewFormCard({
  titleWidth,
  ctaClassName,
}: {
  titleWidth: string;
  ctaClassName: string;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className={`h-2 rounded-full bg-white/15 ${titleWidth}`} />
      <div className="h-8 rounded-md bg-white/10" />
      <div className={`h-8 rounded-md ${ctaClassName}`} />
    </div>
  );
}

function WorkflowReviewAndShip() {
  return (
    <div className="space-y-4">
      <InlineReviewPanel />
      <ShipPanel />
    </div>
  );
}

function InlineReviewPanel() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Inline review</span>
        <span className="text-xs text-white/35">3 files changed</span>
      </div>
      <div className="space-y-2">
        {REVIEW_FILES.map((file) => (
          <ReviewFileRow key={file.path} path={file.path} delta={file.delta} />
        ))}
      </div>
    </div>
  );
}

function ReviewFileRow({ path, delta }: { path: string; delta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="truncate font-mono text-white/50">{path}</span>
      <span className="flex gap-1 font-mono">
        {delta.split(" ").map((part) => (
          <span
            key={part}
            className={part.startsWith("-") ? "text-red-300/70" : "text-emerald-300/70"}
          >
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}

function ShipPanel() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Ready to ship</span>
        <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
          checks passed
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-white/70">
          Commit
        </div>
        <div className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-white/70">
          Open PR
        </div>
        <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/15 px-3 py-2 text-emerald-200">
          Merge
        </div>
      </div>
    </div>
  );
}

function GetStarted() {
  return (
    <div className="pt-10">
      <div className="flex flex-row flex-wrap gap-3">
        <DownloadButton />
        <ServerInstallButton />
      </div>
      <div className="pt-3">
        <a
          href="/download"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          All download options
        </a>
      </div>
      <div className="flex items-center gap-2 pt-6">
        <span className="text-xs text-muted-foreground">Supports</span>
        <div className="flex items-center gap-1">
          <AgentBadge name="Claude Code" icon={CLAUDE_CODE_BADGE_ICON} />
          <AgentBadge name="Codex" icon={CODEX_BADGE_ICON} />
          <AgentBadge name="OpenCode" icon={OPENCODE_BADGE_ICON} />
          <AgentBadge name="Pi" icon={PI_BADGE_ICON} />
          <AgentBadge name="Cursor" icon={CURSOR_BADGE_ICON} />
        </div>
        <a
          href="/agents"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          +{ADDITIONAL_AGENT_COUNT} more
        </a>
      </div>
    </div>
  );
}

function DownloadButton() {
  return (
    <a
      href="/download"
      className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 transition-colors"
    >
      Build locally
    </a>
  );
}

const SERVER_INSTALL_TRIGGER = (
  <span className="inline-flex items-center justify-center rounded-lg border border-white/20 px-3 py-2 text-white hover:bg-white/10 transition-colors">
    <TerminalIcon className="h-5 w-5" />
  </span>
);

const SERVER_INSTALL_FOOTNOTE = (
  <>
    Requires Node.js 18+. Run <span className="font-mono text-white/40">jagentdesk</span> to start the
    daemon.
  </>
);

function ServerInstallButton() {
  return (
    <CommandDialog
      trigger={SERVER_INSTALL_TRIGGER}
      title="Run agents on a remote machine"
      description="For headless machines you want to connect to from the JAgentDesk apps. The desktop app already includes a built-in daemon."
      command="npm install -g @jagentdesk/cli && jagentdesk"
      footnote={SERVER_INSTALL_FOOTNOTE}
    />
  );
}

const bashKeywords = new Set([
  "while",
  "do",
  "done",
  "if",
  "then",
  "fi",
  "else",
  "break",
  "true",
  "false",
]);
const bashCommands = new Set(["jagentdesk", "echo", "jq"]);

function tokenizeBashComment(code: string, i: number): { node: React.ReactNode; len: number } {
  const end = code.indexOf("\n", i);
  const comment = end === -1 ? code.slice(i) : code.slice(i, end);
  return {
    node: <span className="text-white/30 italic">{comment}</span>,
    len: comment.length,
  };
}

function tokenizeBashDoubleQuoted(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i + 1;
  while (j < code.length && code[j] !== '"') {
    if (code[j] === "\\") j++;
    j++;
  }
  const str = code.slice(i, j + 1);
  return { node: <span className="text-green-400/80">{str}</span>, len: str.length };
}

function tokenizeBashSingleQuoted(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i + 1;
  while (j < code.length && code[j] !== "'") j++;
  const str = code.slice(i, j + 1);
  return { node: <span className="text-green-400/80">{str}</span>, len: str.length };
}

function tokenizeBashDollar(code: string, i: number): { node: React.ReactNode; len: number } {
  if (code[i + 1] === "(") {
    return { node: <span className="text-amber-300/70">$(</span>, len: 2 };
  }
  let j = i + 1;
  while (j < code.length && /\w/.test(code[j])) j++;
  return {
    node: <span className="text-amber-300/70">{code.slice(i, j)}</span>,
    len: j - i,
  };
}

function tokenizeBashFlag(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i;
  if (code[j + 1] === "-") j++;
  j++;
  while (j < code.length && /[\w-]/.test(code[j])) j++;
  return {
    node: <span className="text-sky-300/70">{code.slice(i, j)}</span>,
    len: j - i,
  };
}

function tokenizeBashWord(code: string, i: number): { node: React.ReactNode; len: number } {
  let j = i;
  while (j < code.length && /\w/.test(code[j])) j++;
  const word = code.slice(i, j);
  const len = j - i;
  if (bashKeywords.has(word)) {
    return { node: <span className="text-purple-400">{word}</span>, len };
  }
  if (bashCommands.has(word)) {
    return { node: <span className="text-white">{word}</span>, len };
  }
  return { node: word, len };
}

function isBashFlagStart(code: string, i: number): boolean {
  return (
    code[i] === "-" &&
    (i === 0 || /\s/.test(code[i - 1])) &&
    i + 1 < code.length &&
    /[\w-]/.test(code[i + 1])
  );
}

function isBashCommentStart(code: string, i: number): boolean {
  return code[i] === "#" && (i === 0 || /[\s(]/.test(code[i - 1]));
}

function tokenizeBashChar(code: string, i: number): { node: React.ReactNode; len: number } {
  const c = code[i];
  if (c === "|" || (c === "&" && code[i + 1] === "&")) {
    const op = c === "|" ? "|" : "&&";
    return { node: <span className="text-white/40">{op}</span>, len: op.length };
  }
  if (c === "\\") return { node: <span className="text-white/40">\</span>, len: 1 };
  if (c === ")") return { node: <span className="text-amber-300/70">)</span>, len: 1 };
  return { node: c, len: 1 };
}

function nextBashToken(code: string, i: number): { node: React.ReactNode; len: number } {
  if (isBashCommentStart(code, i)) return tokenizeBashComment(code, i);
  if (code[i] === '"') return tokenizeBashDoubleQuoted(code, i);
  if (code[i] === "'") return tokenizeBashSingleQuoted(code, i);
  if (code[i] === "$") return tokenizeBashDollar(code, i);
  if (isBashFlagStart(code, i)) return tokenizeBashFlag(code, i);
  if (/[a-zA-Z_]/.test(code[i])) return tokenizeBashWord(code, i);
  return tokenizeBashChar(code, i);
}

function highlightBash(code: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < code.length) {
    const { node, len } = nextBashToken(code, i);
    if (React.isValidElement(node)) {
      tokens.push(React.cloneElement(node, { key: key++ }));
    } else {
      tokens.push(node);
    }
    i += len;
  }

  return tokens;
}

function CLICodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  return (
    <div className="relative bg-white/5 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-3 right-3 text-white/30 hover:text-white/70 transition-colors p-1"
        title="Copy to clipboard"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M216,28H88A20,20,0,0,0,68,48V76H40A20,20,0,0,0,20,96V216a20,20,0,0,0,20,20H168a20,20,0,0,0,20-20V188h28a20,20,0,0,0,20-20V48A20,20,0,0,0,216,28ZM164,212H44V100H164Zm48-48H188V96a20,20,0,0,0-20-20H92V52H212Z" />
          </svg>
        )}
      </button>
      <pre className="p-4 pr-10 text-xs leading-relaxed overflow-x-auto text-white/70 font-mono whitespace-pre">
        {highlightBash(children)}
      </pre>
    </div>
  );
}

interface CLIExample {
  title: string;
  description: string;
  code: string;
}

const cliExamples: CLIExample[] = [
  {
    title: "Run agents",
    description:
      "Launch agents locally or on any remote host. The --worktree flag spins up an isolated git branch so you can run multiple agents on the same repo without conflicts.",
    code: `jagentdesk run "implement user authentication"
jagentdesk run --provider codex --worktree feature-x "implement feature X"
jagentdesk run --host devbox:6767 "run the full test suite"

jagentdesk ls                           # list running agents
jagentdesk attach abc123                # stream live output
jagentdesk send abc123 "also add tests" # follow-up task`,
  },
  {
    title: "Loops",
    description:
      "Have one agent do the work, another verify the result, and loop until it passes. Built-in, no shell scripting needed.",
    code: `# Worker-verifier loop: fix tests until they pass
jagentdesk loop run "make all tests pass" \\
  --verify "verify tests pass and the code is production-ready" \\
  --verify-check "npm test" \\
  --max-iterations 5

jagentdesk loop ls                        # list running loops
jagentdesk loop logs abc123               # stream loop output`,
  },
  {
    title: "Schedules",
    description:
      "Run agents on a cron schedule. Automate recurring tasks like dependency updates, security audits, or report generation.",
    code: `# Run a security audit every Monday at 9am
jagentdesk schedule create --cron "0 9 * * 1" \\
  "audit the codebase for security issues and open PRs for fixes"

jagentdesk schedule ls                    # list all schedules
jagentdesk schedule pause abc123          # pause a schedule
jagentdesk schedule delete abc123         # remove a schedule`,
  },
];

function PhoneShowcase() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const textInView = useInView(containerRef, { once: true, margin: "-80px" });

  // Scroll-linked animation: track how far through the container the user has scrolled
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "center center"],
  });

  // Responsive slide distance
  const [slideDistance, setSlideDistance] = React.useState(260);
  React.useEffect(() => {
    function update() {
      setSlideDistance(window.innerWidth < 768 ? 140 : 260);
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Side phones start at x=0 (behind center) and slide out to final position
  const sideOpacity = useTransform(scrollYProgress, [0.2, 0.6], [0, 1]);
  const leftX = useTransform(scrollYProgress, [0.2, 0.6], [0, -slideDistance]);
  const rightX = useTransform(scrollYProgress, [0.2, 0.6], [0, slideDistance]);

  const leftPhoneStyle = React.useMemo(
    () => ({ opacity: sideOpacity, x: leftX, rotateY: -15, scale: 0.97 }),
    [sideOpacity, leftX],
  );
  const rightPhoneStyle = React.useMemo(
    () => ({ opacity: sideOpacity, x: rightX, rotateY: 15, scale: 0.97 }),
    [sideOpacity, rightX],
  );
  const centerPhoneAnimate = React.useMemo(() => (textInView ? FADE_IN : {}), [textInView]);
  const textAnimate = React.useMemo(() => (textInView ? FADE_IN : {}), [textInView]);

  return (
    <div ref={containerRef} className="flex flex-col items-center pt-4 pb-16 gap-20">
      {/* Arrow + text */}
      <motion.div
        initial={FADE_IN_UP_TINY}
        animate={textAnimate}
        transition={DURATION_05}
        className="flex flex-col items-center gap-1.5 px-6"
      >
        <svg
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
          className="text-white/20"
        >
          <path d="M12 5v14M5 12l7 7 7-7" />
        </svg>
        <p className="text-lg text-white/80 text-center">
          When you want to step away from your desk,
          <br className="md:hidden" /> you can.
        </p>
        <p className="text-sm text-white/50 text-center">
          The native mobile app has full feature parity with desktop.
        </p>
      </motion.div>

      {/* Phone trio — side phones are absolute, start behind center, slide outward with perspective rotation */}
      <div
        className="relative flex items-center justify-center overflow-x-clip w-full"
        style={PHONE_PERSPECTIVE_STYLE}
      >
        {/* Left phone — rotated to face inward */}
        <motion.div style={leftPhoneStyle} className="w-[160px] md:w-[240px] absolute">
          <img
            src="/phone-1-480.webp"
            srcSet="/phone-1-320.webp 320w, /phone-1-480.webp 480w"
            sizes="(min-width: 768px) 240px, 160px"
            alt="JAgentDesk sessions list"
            width={480}
            height={1044}
            loading="lazy"
            decoding="async"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>

        {/* Center phone */}
        <motion.div
          initial={FADE_IN_UP_XL}
          animate={centerPhoneAnimate}
          transition={EASE_OUT_06_DELAY_01}
          className="w-[220px] md:w-[240px] relative z-10"
        >
          <img
            src="/phone-2-480.webp"
            srcSet="/phone-2-320.webp 320w, /phone-2-480.webp 480w"
            sizes="(min-width: 768px) 240px, 220px"
            alt="JAgentDesk agent chat"
            width={480}
            height={1044}
            loading="lazy"
            decoding="async"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>

        {/* Right phone — rotated to face inward */}
        <motion.div style={rightPhoneStyle} className="w-[160px] md:w-[240px] absolute">
          <img
            src="/phone-3-480.webp"
            srcSet="/phone-3-320.webp 320w, /phone-3-480.webp 480w"
            sizes="(min-width: 768px) 240px, 160px"
            alt="JAgentDesk diff view"
            width={480}
            height={1044}
            loading="lazy"
            decoding="async"
            className="w-full rounded-[40px] shadow-2xl border-[3px] border-black outline-[3px] outline-white/20"
          />
        </motion.div>
      </div>
    </div>
  );
}

function CLITabButton({
  title,
  index,
  active,
  onSelect,
}: {
  title: string;
  index: number;
  active: boolean;
  onSelect: (i: number) => void;
}) {
  const handleClick = React.useCallback(() => onSelect(index), [onSelect, index]);
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? "border-white/40 text-white bg-white/10"
          : "border-white/15 text-white/50 hover:text-white/80 hover:border-white/30"
      }`}
    >
      {title}
    </button>
  );
}

function CLISection() {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const active = cliExamples[activeIndex];

  return (
    <FeatureSection
      title="Fully scriptable"
      description="Everything you can do in the app, you can do from the terminal."
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {cliExamples.map((example, i) => (
          <CLITabButton
            key={example.title}
            title={example.title}
            index={i}
            active={i === activeIndex}
            onSelect={setActiveIndex}
          />
        ))}
      </div>

      <div className="mb-3">
        <CLICodeBlock>{active.code}</CLICodeBlock>
      </div>

      <a
        href="/docs/cli"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Full CLI reference
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </a>
    </FeatureSection>
  );
}

function FAQ() {
  return (
    <motion.div
      initial={FADE_IN_UP}
      whileInView={FADE_IN}
      viewport={VIEWPORT_60}
      transition={EASE_OUT_05}
      className="space-y-6"
    >
      <h2 className="text-3xl font-medium">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="Is this free?">
          Yes. JAgentDesk is free and open source. You need Claude Code, Codex, Cursor, OpenCode, or Pi
          installed with your own credentials. Voice is local-first by default and can optionally
          use OpenAI speech providers if you configure them.
        </FAQItem>
        <FAQItem question="Does my code leave my machine?">
          JAgentDesk doesn&apos;t send your code anywhere. Agents run locally and talk to their own APIs
          as they normally would. For remote access, connect the daemon and clients through
          Tailscale. The application pairing and signing flow still verifies each device before
          commands are accepted.
        </FAQItem>
        <FAQItem question="What agents does it support?">
          Claude Code, Codex, Cursor, OpenCode, and Pi. Each agent runs as its own process using its
          own CLI or local integration. JAgentDesk doesn&apos;t modify or wrap their behavior.
        </FAQItem>
        <FAQItem question="Do I need the desktop app?">
          No. You can run the daemon headless with{" "}
          <code className="font-mono text-muted-foreground">
            npm install -g @jagentdesk/cli && jagentdesk
          </code>{" "}
          and use the CLI, web app, or mobile app to connect. The desktop app just bundles the
          daemon with a UI.
        </FAQItem>
        <FAQItem question="How does voice work?">
          Voice runs locally on your device by default. You talk, the app transcribes and sends it
          to your agent as text. Optionally, you can configure OpenAI speech providers for
          higher-quality transcription and text-to-speech. See the{" "}
          <a href="/docs/voice" className="underline hover:text-white/80">
            voice docs
          </a>
          .
        </FAQItem>
        <FAQItem question="Can I connect from outside my network?">
          Yes. Connect the daemon and clients to the same Tailscale network and complete the
          application pairing flow. See{" "}
          <a href="/docs/configuration" className="underline hover:text-white/80">
            configuration
          </a>
          .
        </FAQItem>
        <FAQItem question="Do I need git or GitHub?">
          No. JAgentDesk works in any directory. Worktrees are optional and only relevant if you use git.
          You can run agents anywhere you&apos;d normally work.
        </FAQItem>
        <FAQItem question="Can I get banned for using JAgentDesk?">
          <p>We can&apos;t make promises on behalf of providers.</p>
          <p>
            That said, JAgentDesk launches each provider&apos;s local CLI or integration (Claude Code,
            Codex, Cursor, OpenCode, Pi) as a subprocess. It doesn&apos;t extract tokens or call
            inference APIs directly. From the provider&apos;s perspective, usage through JAgentDesk is
            indistinguishable from running the provider yourself.
          </p>
          <p>I&apos;ve been using JAgentDesk with all providers for months without issue.</p>
        </FAQItem>
        <FAQItem question="How do worktrees work?">
          When you launch an agent with the worktree option (from the app, desktop, or CLI), JAgentDesk
          creates a git worktree and runs the agent inside it. The agent works on an isolated branch
          without touching your main working directory. See the{" "}
          <a href="/docs/worktrees" className="underline hover:text-white/80">
            worktrees docs
          </a>
          .
        </FAQItem>
      </div>
    </motion.div>
  );
}
