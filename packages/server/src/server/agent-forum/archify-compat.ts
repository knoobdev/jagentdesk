import type { ForumDiagram, StoredForumTopic } from "@jagentdesk/protocol/agent-forum/types";

// COMPAT(archifyDiagrams): added after v0.9.43, remove after 2027-03-29.
// Clients older than archify diagrams parse ForumDiagram.format as the closed enum ["mermaid"] and
// reject the whole topic when it holds an archify version. For those clients every archify version
// is presented as a one-line Mermaid note that renders in their ARCH tab; id/version/title/author/
// timestamps are kept so version pills still line up.
export const ARCHIFY_LEGACY_PLACEHOLDER = 'graph TD; A["Update the app to view this diagram"]';

function toLegacyDiagram(diagram: ForumDiagram): ForumDiagram {
  if (diagram.format !== "archify") return diagram;
  const { diagramType: _diagramType, renderStatus: _renderStatus, ...rest } = diagram;
  return { ...rest, format: "mermaid", source: ARCHIFY_LEGACY_PLACEHOLDER };
}

export function downgradeArchifyDiagrams(topic: StoredForumTopic): StoredForumTopic {
  if (!topic.diagrams.some((diagram) => diagram.format === "archify")) return topic;
  return { ...topic, diagrams: topic.diagrams.map(toLegacyDiagram) };
}

// Presents a topic for one client: unchanged when it understands archify, downgraded otherwise.
export function presentForumTopic(
  topic: StoredForumTopic,
  supportsArchifyDiagrams: boolean,
): StoredForumTopic {
  return supportsArchifyDiagrams ? topic : downgradeArchifyDiagrams(topic);
}
