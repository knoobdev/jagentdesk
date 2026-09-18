import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useToast } from "@/contexts/toast-context";
import type { ToastApi } from "@/components/toast-host";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import type { ForumMessage, StoredForumTopic } from "@jagentdesk/protocol/messages";

// Live team notifications: watch every connected host's forum.stream and raise an in-app toast when a
// teammate posts a new message or a task ships — so the user sees "who, in which thread" at a glance
// without having to sit on the Team screen. The daemon broadcasts the whole topic on each mutation, so
// we keep a per-topic baseline (message ids + task statuses) and toast only the delta since we last saw
// it. The first time a topic arrives we record the baseline silently, so opening the app never floods
// the user with the entire backlog.

interface TopicBaseline {
  messageIds: Set<string>;
  taskStatus: Map<string, string>;
  status: string;
}

function snapshot(topic: StoredForumTopic): TopicBaseline {
  return {
    messageIds: new Set(topic.messages.map((m) => m.id)),
    taskStatus: new Map(topic.tasks.map((task) => [task.id, task.status])),
    status: topic.status,
  };
}

function isTeammatePost(message: ForumMessage): boolean {
  return (
    message.authorAgentId !== "user" &&
    message.authorAgentId !== "system" &&
    message.role !== "user" &&
    message.role !== "system"
  );
}

function postMessageAndVariant(
  message: ForumMessage,
  topicTitle: string,
  t: TFunction,
): { text: string; variant: "info" | "warning" } {
  const vars = { author: message.authorLabel, topic: topicTitle };
  if (message.kind === "question" || message.awaitingHuman) {
    return { text: t("forumNotifications.question", vars), variant: "warning" };
  }
  if (message.kind === "decision") {
    return { text: t("forumNotifications.decision", { topic: topicTitle }), variant: "info" };
  }
  if (message.kind === "review") {
    return { text: t("forumNotifications.review", vars), variant: "info" };
  }
  return { text: t("forumNotifications.newPost", vars), variant: "info" };
}

function notifyNewPosts(
  topic: StoredForumTopic,
  prev: TopicBaseline,
  toast: ToastApi,
  t: TFunction,
): void {
  const fresh = topic.messages.filter((m) => !prev.messageIds.has(m.id) && isTeammatePost(m));
  if (fresh.length === 0) return;
  if (fresh.length > 2) {
    toast.show(t("forumNotifications.manyPosts", { count: fresh.length, topic: topic.title }), {
      variant: "info",
      durationMs: 3500,
    });
    return;
  }
  for (const message of fresh) {
    const { text, variant } = postMessageAndVariant(message, topic.title, t);
    toast.show(text, { variant, durationMs: 3500 });
  }
}

function notifyCompletions(
  topic: StoredForumTopic,
  prev: TopicBaseline,
  toast: ToastApi,
  t: TFunction,
): void {
  for (const task of topic.tasks) {
    const before = prev.taskStatus.get(task.id);
    if (task.status === "done" && before !== undefined && before !== "done") {
      toast.show(t("forumNotifications.taskDone", { task: task.title, topic: topic.title }), {
        variant: "success",
        durationMs: 4500,
      });
    }
  }
  if (topic.status === "done" && prev.status !== "done") {
    toast.show(t("forumNotifications.topicDone", { topic: topic.title }), {
      variant: "success",
      durationMs: 5000,
    });
  }
}

function HostForumWatcher({ serverId }: { serverId: string }): null {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const { t } = useTranslation();
  const seen = useRef<Map<string, TopicBaseline>>(new Map());

  useEffect(() => {
    if (!client) return;
    return client.subscribeForumStream((topic) => {
      const prev = seen.current.get(topic.id);
      seen.current.set(topic.id, snapshot(topic));
      if (!prev) return; // first sighting: record the baseline, don't toast the backlog
      notifyNewPosts(topic, prev, toast, t);
      notifyCompletions(topic, prev, toast, t);
    });
  }, [client, toast, t]);

  return null;
}

/**
 * App-wide team-forum notifications. Mounts one silent watcher per connected host so new posts and
 * shipped tasks surface as toasts regardless of which screen the user is on.
 */
export function ForumNotifications(): ReactElement {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <HostForumWatcher key={host.serverId} serverId={host.serverId} />
      ))}
    </>
  );
}
