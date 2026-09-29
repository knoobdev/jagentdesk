import { z } from "zod";
import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentStreamEvent,
  AgentTimelineItem,
  ImportedTimelineEntry,
} from "../../agent-sdk-types.js";

// JAgentDesk has no first-class notification timeline item (upstream #3411 not ported);
// render the notice as a synthetic status-line tool call, like the OMP notices.
export function openCodeRuntimeNoticeItem(major: 1 | 2, timestamp: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `opencode-runtime-notice:v${major}:${timestamp}`,
    name: "opencode_runtime_notice",
    status: "completed",
    error: null,
    detail: { type: "plain_text", label: `This chat uses OpenCode v${major}.`, icon: "sparkles" },
    metadata: { synthetic: true, source: "opencode_runtime_notice", level: "info" },
  };
}

const Notices = z.array(
  z.object({ major: z.union([z.literal(1), z.literal(2)]), timestamp: z.string().datetime() }),
);

// These rows belong to JAgentDesk, not OpenCode's conversation. Keep their original
// timestamps in the persistence handle so history rebuilds preserve placement.
export function withOpenCodeRuntimeNotice(
  session: AgentSession,
  major: 1 | 2,
  previous?: AgentPersistenceHandle,
): AgentSession {
  const notices = Notices.parse(previous?.metadata?.openCodeRuntimeNotices ?? []);
  const added = notices.at(-1)?.major !== major;
  if (added) notices.push({ major, timestamp: new Date().toISOString() });
  const entries: ImportedTimelineEntry[] = notices.map(({ major: recordedMajor, timestamp }) => ({
    timestamp,
    item: openCodeRuntimeNoticeItem(recordedMajor, timestamp),
  }));
  const describePersistence = session.describePersistence.bind(session);
  const streamHistory = session.streamHistory.bind(session);
  return Object.assign(session, {
    initialTimeline: added ? entries.slice(-1) : [],
    describePersistence() {
      const handle = describePersistence();
      return (
        handle && { ...handle, metadata: { ...handle.metadata, openCodeRuntimeNotices: notices } }
      );
    },
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      const pending = [...entries];
      const event = (entry: ImportedTimelineEntry): AgentStreamEvent => ({
        type: "timeline",
        provider: "opencode",
        ...entry,
      });
      for await (const row of streamHistory()) {
        while (
          row.type === "timeline" &&
          row.timestamp &&
          pending[0]?.timestamp &&
          pending[0].timestamp <= row.timestamp
        ) {
          yield event(pending.shift()!);
        }
        yield row;
      }
      for (const entry of pending) yield event(entry);
    },
  });
}
