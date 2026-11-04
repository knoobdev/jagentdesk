import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Image, Pressable, Text, View, type TextStyle } from "react-native";
import { MarkdownIt, type ASTNode, type RenderRules } from "react-native-markdown-display";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Paperclip } from "lucide-react-native";
import type { JiraAttachment } from "@jagentdesk/protocol/jira/rpc-schemas";
import {
  createSharedMarkdownRules,
  MarkdownInheritedText,
  MarkdownRenderer,
} from "@/components/markdown/renderer";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import { tint } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { AttachmentViewer, useAttachmentFile } from "./attachments";
import { Spinner } from "./controls";
import { attachmentIdOf } from "./rich-text";
import { formatBytes, handleMarkdownLink } from "./shared";

// Jira rich text (description, comments, work log) as Markdown from the daemon. Differences from
// the chat renderer: no HTML-ish pass (Jira text never carries HTML, and `<…>` must stay text),
// bare URLs are linkified, links open in the system browser, and `jira-attachment:<id>` images
// and links load the issue's attachments through jira.issue.attachments.download (spec 29.7 #9:
// the app never receives a credentialed Jira URL).

const ThemedPaperclip = withUnistyles(Paperclip);

// Inline images up to this size load in full; larger ones use Jira's thumbnail.
const INLINE_FULL_MAX_BYTES = 2 * 1024 * 1024;

interface RichTextContextValue {
  serverId: string;
  connectionId: string;
  attachments: readonly JiraAttachment[];
  open: (attachment: JiraAttachment) => void;
}

const RichTextContext = createContext<RichTextContextValue | null>(null);

/** Issue-wide: which attachments rich text may reference, and one viewer for them. */
export function JiraRichTextProvider({
  serverId,
  connectionId,
  attachments,
  children,
}: {
  serverId: string;
  connectionId: string;
  attachments: readonly JiraAttachment[];
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<JiraAttachment | null>(null);
  const close = useCallback(() => setOpened(null), []);
  const value = useMemo(
    () => ({ serverId, connectionId, attachments, open: setOpened }),
    [attachments, connectionId, serverId],
  );
  return (
    <RichTextContext.Provider value={value}>
      {children}
      <AttachmentViewer
        serverId={serverId}
        connectionId={connectionId}
        attachment={opened}
        onClose={close}
      />
    </RichTextContext.Provider>
  );
}

/** Links: mentions are not links, attachments open in the viewer, the rest in the browser. */
function handleJiraLink(url: string): boolean {
  return attachmentIdOf(url) === null && handleMarkdownLink(url);
}

function resolveAttachment(
  context: RichTextContextValue,
  id: string,
  name: string,
  image: boolean,
): JiraAttachment {
  return (
    context.attachments.find((attachment) => attachment.id === id) ?? {
      id,
      filename: name || "attachment",
      mimeType: image ? "image/*" : "application/octet-stream",
      size: 0,
      created_ms: 0,
      author: null,
      hasThumbnail: false,
    }
  );
}

function RichImage({ id, alt }: { id: string; alt: string }) {
  const context = useContext(RichTextContext);
  if (!context) return <Text style={jiraStyles.textMuted}>{alt}</Text>;
  return <LoadedRichImage context={context} id={id} alt={alt} />;
}

function LoadedRichImage({
  context,
  id,
  alt,
}: {
  context: RichTextContextValue;
  id: string;
  alt: string;
}) {
  const attachment = resolveAttachment(context, id, alt, true);
  const variant =
    attachment.hasThumbnail && attachment.size > INLINE_FULL_MAX_BYTES ? "thumbnail" : "content";
  const state = useAttachmentFile(context.serverId, context.connectionId, id, variant);
  const [aspect, setAspect] = useState<number | null>(null);
  const uri = state.kind === "loaded" ? state.file.uri : null;
  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (width, height) => {
        if (!cancelled && width > 0 && height > 0) setAspect(width / height);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);
  const { open } = context;
  const show = useCallback(() => open(attachment), [attachment, open]);
  const source = useMemo(() => (uri ? { uri } : null), [uri]);
  const imageStyle = useMemo(() => [styles.image, { aspectRatio: aspect ?? 16 / 9 }], [aspect]);
  if (state.kind === "failed") {
    return (
      <Pressable onPress={show} accessibilityRole="button" style={styles.failed}>
        <ThemedPaperclip size={12} uniProps={tint.muted} />
        <Text style={jiraStyles.textSmall}>{`${attachment.filename}: ${state.message}`}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={show}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${attachment.filename}`}
      style={styles.imageWrap}
      testID={`jira-rich-image-${id}`}
    >
      {source ? (
        <Image
          source={source}
          style={imageStyle}
          resizeMode="contain"
          accessibilityLabel={attachment.filename}
        />
      ) : (
        <View style={styles.imagePlaceholder}>
          <Spinner />
        </View>
      )}
    </Pressable>
  );
}

function RichAttachmentLink({
  id,
  linkStyle,
  children,
}: {
  id: string;
  linkStyle: TextStyle;
  children: ReactNode;
}) {
  const context = useContext(RichTextContext);
  const attachment = context ? resolveAttachment(context, id, "", false) : null;
  const open = context?.open;
  const show = useCallback(() => {
    if (attachment && open) open(attachment);
  }, [attachment, open]);
  const size = attachment && attachment.size > 0 ? ` (${formatBytes(attachment.size)})` : "";
  return (
    <Text
      style={linkStyle}
      onPress={show}
      accessibilityRole="link"
      testID={`jira-rich-attachment-${id}`}
    >
      <ThemedPaperclip size={12} uniProps={tint.muted} /> {children}
      {size}
    </Text>
  );
}

function ExternalImageLink({ src, alt }: { src: string; alt: string }) {
  const open = useCallback(() => void openExternalUrl(src), [src]);
  return (
    <Text style={jiraStyles.textMuted} onPress={open} accessibilityRole="link">
      {alt || src}
    </Text>
  );
}

type MarkdownStyles = Record<string, TextStyle>;
const EMPTY_STYLE: TextStyle = {};

function createJiraRules(): RenderRules {
  const shared = createSharedMarkdownRules();
  return {
    ...shared,
    // Text inside a link takes the link color (the shared text style would override it).
    text: (
      node: ASTNode,
      _children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = EMPTY_STYLE,
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.text ?? EMPTY_STYLE}
        style={parent.some((ancestor) => ancestor.type === "link") ? styles.link : undefined}
      >
        {node.content}
      </MarkdownInheritedText>
    ),
    image: (node: ASTNode) => {
      const src = typeof node.attributes?.src === "string" ? node.attributes.src : "";
      const alt = typeof node.attributes?.alt === "string" ? node.attributes.alt : "";
      const id = attachmentIdOf(src);
      if (id) return <RichImage key={node.key} id={id} alt={alt} />;
      // External images are not fetched: they show as a link that opens in the browser.
      return <ExternalImageLink key={node.key} src={src} alt={alt} />;
    },
    link: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
      onLinkPress?: (url: string) => boolean,
    ) => {
      const href = typeof node.attributes?.href === "string" ? node.attributes.href : "";
      const id = attachmentIdOf(href);
      if (id) {
        return (
          <RichAttachmentLink key={node.key} id={id} linkStyle={styles.link ?? EMPTY_STYLE}>
            {children}
          </RichAttachmentLink>
        );
      }
      return shared.link?.(node, children, parent, styles, onLinkPress);
    },
  };
}

// Bare URLs become links; no typographer, so Jira text keeps its exact quotes and dashes.
const jiraParser = MarkdownIt({ typographer: false, linkify: true });

export function JiraMarkdown({ text }: { text: string }) {
  const rules = useMemo(createJiraRules, []);
  return (
    <MarkdownRenderer
      text={text}
      rules={rules}
      markdownit={jiraParser}
      onLinkPress={handleJiraLink}
      enableHtmlish={false}
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  imageWrap: {
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: 480,
    marginVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  image: { width: "100%", maxHeight: 360 },
  imagePlaceholder: {
    height: 120,
    alignItems: "center",
    justifyContent: "center",
  },
  failed: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
}));
