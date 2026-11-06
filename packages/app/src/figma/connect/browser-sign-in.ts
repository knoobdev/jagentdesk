export type FigmaBrowserReply =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string };

export type FigmaBrowserOutcome = { kind: "connected" } | { kind: "error"; message: string };

export interface FigmaBrowserWait {
  signal: AbortSignal;
  onCode: () => void;
}

interface BrowserSignInPorts {
  open: (input: { authorizeUrl: string; redirectUri: string }) => Promise<FigmaBrowserReply>;
  cancel: (state: string) => Promise<unknown>;
  complete: (input: {
    attemptId: string;
    code: string;
    state: string;
  }) => Promise<{ connection: unknown | null }>;
}

// A provider error can leave the browser on Figma without calling the loopback. Cancel only
// this attempt's listener, and never exchange a code that arrives after the user cancelled.
export async function finishFigmaBrowserSignIn(
  ports: BrowserSignInPorts,
  begin: { attemptId: string; authorizeUrl: string; redirectUri: string },
  wait?: FigmaBrowserWait,
): Promise<FigmaBrowserOutcome> {
  const cancelled: FigmaBrowserOutcome = { kind: "error", message: "Sign-in cancelled." };
  if (wait?.signal.aborted) return cancelled;
  const state = new URL(begin.authorizeUrl).searchParams.get("state");
  let rejectCancellation: (error: unknown) => void = () => {};
  const cancellationFailure = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    if (state) void ports.cancel(state).catch(rejectCancellation);
  };
  wait?.signal.addEventListener("abort", cancel, { once: true });
  let reply: FigmaBrowserReply;
  try {
    reply = await Promise.race([
      ports.open({ authorizeUrl: begin.authorizeUrl, redirectUri: begin.redirectUri }),
      cancellationFailure,
    ]);
  } finally {
    wait?.signal.removeEventListener("abort", cancel);
  }
  if (wait?.signal.aborted) return cancelled;
  if (reply.kind === "error") return reply;
  wait?.onCode();
  const result = await ports.complete({
    attemptId: begin.attemptId,
    code: reply.code,
    state: reply.state,
  });
  return result.connection
    ? { kind: "connected" }
    : { kind: "error", message: "Figma rejected the sign-in." };
}
