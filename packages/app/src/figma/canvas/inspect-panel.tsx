// Right-hand inspect panel: selected node fields, edit controls that build ops,
// generated CSS, and an export section.
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, Text, ScrollView } from "react-native";
import type { Theme } from "@/styles/theme";
import { Input, ErrorBanner } from "@/jira/ui/primitives";
import { Button } from "@/components/ui/button";
import { jiraStyles } from "@/jira/ui/styles";
import type { FigmaNode, FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaColor } from "./protocol-types";
import type { ApplyFigmaEdits } from "../contracts";
import { buildEditOps, type InspectEditPatch } from "./ops";
import { generateNodeCss, colorToCss } from "./css";
import { PanelSection, PanelRow, MonoText } from "./panel-ui";
import { fetchFigmaExport } from "./use-figma-file";
import { saveExportedBytes } from "./save-bytes";
import * as Clipboard from "expo-clipboard";
import { Copy, Download, Eye, EyeOff, Lock, Unlock } from "lucide-react-native";

const EXPORT_FORMATS = ["png", "jpg", "svg", "pdf"] as const;
const EXPORT_SCALES = [1, 2, 4] as const;

function dict(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstSolidColor(node: FigmaNode): FigmaColor | null {
  for (const entry of Array.isArray(node.fills) ? node.fills : []) {
    const paint = dict(entry);
    if (paint.type === "SOLID" && paint.visible !== false) {
      const color = dict(paint.color);
      const r = num(color.r);
      const g = num(color.g);
      const b = num(color.b);
      if (r === undefined || g === undefined || b === undefined) continue;
      const a = num(color.a) ?? num(paint.opacity) ?? 1;
      return { r, g, b, a };
    }
  }
  return null;
}

const styles = StyleSheet.create((theme: Theme) => ({
  panel: {
    flex: 1,
    backgroundColor: theme.colors.surface,
  },
  emptyWrap: {
    padding: 16,
  },
  header: {
    gap: 4,
  },
  content: {
    padding: 12,
    gap: 18,
  },
  fieldWrap: {
    flex: 1,
    gap: 4,
  },
  textWrap: {
    alignSelf: "stretch",
    gap: 4,
  },
  cssText: {
    lineHeight: 18,
  },
}));

// ---- generic committed-field rows (handlers are useCallback so the JSX props stay referentially stable)

function NumberFieldRow({
  label,
  value,
  disabled,
  apply,
  patchKey,
}: {
  label: string;
  value: number | undefined;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
  patchKey: keyof InspectEditPatch;
}) {
  const onCommit = useCallback(
    (next: number) => apply({ [patchKey]: next } as InspectEditPatch),
    [apply, patchKey],
  );
  return <NumField label={label} value={value} disabled={disabled} onCommit={onCommit} />;
}

function TextFieldRow({
  value,
  patchKey,
  apply,
  multiline,
  placeholder,
  disabled,
}: {
  value: string;
  patchKey: keyof InspectEditPatch;
  apply: (patch: InspectEditPatch) => void;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const onCommit = useCallback(
    (next: string) => apply({ [patchKey]: next } as InspectEditPatch),
    [apply, patchKey],
  );
  return (
    <CommitText
      value={value}
      onCommit={onCommit}
      multiline={multiline}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

// ---- NumField: numeric commit-on-blur input

function NumField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === undefined ? "" : String(value));
  }, [value, focused]);
  const commit = useCallback(() => {
    const parsed = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
  }, [text, value, onCommit]);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => {
    setFocused(false);
    commit();
  }, [commit]);
  return (
    <View style={styles.fieldWrap}>
      <Text style={jiraStyles.formLabel}>{label}</Text>
      <Input
        value={text}
        onChangeText={setText}
        onFocus={onFocus}
        onBlur={onBlur}
        onSubmitEditing={commit}
        keyboardType="numeric"
        editable={!disabled}
        accessibilityLabel={label}
      />
    </View>
  );
}

// ---- CommitText: single/multi-line commit-on-blur field

function CommitText({
  value,
  onCommit,
  multiline,
  placeholder,
  disabled,
}: {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  const commit = useCallback(() => {
    if (text === value) return;
    try {
      onCommit(text);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [text, value, onCommit]);
  return (
    <View style={styles.textWrap}>
      <Input
        value={text}
        onChangeText={setText}
        onSubmitEditing={commit}
        onBlur={commit}
        multiline={multiline}
        placeholder={placeholder}
        editable={!disabled}
      />
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}

// ---- Sections (each owns its stable handlers)

function LayerSection({
  node,
  disabled,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const hidden = node.visible === false;
  const locked = node.locked === true;
  const toggleVisibility = useCallback(() => {
    apply({ visible: node.visible === false });
  }, [apply, node.visible]);
  const toggleLock = useCallback(() => {
    apply({ locked: node.locked === true });
  }, [apply, node.locked]);
  return (
    <PanelSection title="Layer">
      <TextFieldRow
        value={String(node.name ?? "")}
        patchKey="name"
        apply={apply}
        disabled={disabled}
      />
      <View style={jiraStyles.row}>
        <Button
          size="sm"
          variant={hidden ? "ghost" : "outline"}
          leftIcon={hidden ? EyeOff : Eye}
          onPress={toggleVisibility}
        >
          {hidden ? "Hidden" : "Visible"}
        </Button>
        <Button
          size="sm"
          variant={locked ? "outline" : "ghost"}
          leftIcon={locked ? Lock : Unlock}
          onPress={toggleLock}
        >
          {locked ? "Locked" : "Unlocked"}
        </Button>
      </View>
    </PanelSection>
  );
}

function GeometrySection({
  node,
  disabled,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const bounds = dict(node.absoluteBoundingBox);
  return (
    <PanelSection title="Size & position">
      <View style={jiraStyles.row}>
        <NumberFieldRow
          label="W"
          value={num(bounds.width)}
          disabled={disabled}
          apply={apply}
          patchKey="width"
        />
        <NumberFieldRow
          label="H"
          value={num(bounds.height)}
          disabled={disabled}
          apply={apply}
          patchKey="height"
        />
      </View>
      <View style={jiraStyles.row}>
        <NumberFieldRow
          label="X"
          value={num(bounds.x)}
          disabled={disabled}
          apply={apply}
          patchKey="x"
        />
        <NumberFieldRow
          label="Y"
          value={num(bounds.y)}
          disabled={disabled}
          apply={apply}
          patchKey="y"
        />
      </View>
    </PanelSection>
  );
}

function AutoLayoutSection({
  node,
  disabled,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const layoutMode = typeof node.layoutMode === "string" ? node.layoutMode : null;
  const setRow = useCallback(() => apply({ layoutMode: "HORIZONTAL" }), [apply]);
  const setColumn = useCallback(() => apply({ layoutMode: "VERTICAL" }), [apply]);
  const clear = useCallback(() => apply({ layoutMode: "NONE" }), [apply]);
  const onGap = useCallback((itemSpacing: number) => apply({ itemSpacing }), [apply]);
  const onPadding = useCallback(
    (padding: number) =>
      apply({
        padding: {
          top: num(node.paddingTop) ?? padding,
          right: num(node.paddingRight) ?? padding,
          bottom: num(node.paddingBottom) ?? padding,
          left: padding,
        },
      }),
    [apply, node.paddingTop, node.paddingRight, node.paddingBottom],
  );
  const showSpacing = layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL";
  return (
    <PanelSection title="Auto layout">
      <View style={jiraStyles.row}>
        <Button
          size="sm"
          variant={layoutMode === "HORIZONTAL" ? "outline" : "ghost"}
          onPress={setRow}
          disabled={disabled}
        >
          Row
        </Button>
        <Button
          size="sm"
          variant={layoutMode === "VERTICAL" ? "outline" : "ghost"}
          onPress={setColumn}
          disabled={disabled}
        >
          Column
        </Button>
        <Button
          size="sm"
          variant={layoutMode ? "ghost" : "outline"}
          onPress={clear}
          disabled={disabled}
        >
          None
        </Button>
      </View>
      {showSpacing ? (
        <>
          <NumField
            label="Gap"
            value={num(node.itemSpacing)}
            disabled={disabled}
            onCommit={onGap}
          />
          <NumField
            label="Padding"
            value={num(node.paddingLeft)}
            disabled={disabled}
            onCommit={onPadding}
          />
        </>
      ) : null}
    </PanelSection>
  );
}

function FillSection({
  node,
  disabled,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const solidFill = firstSolidColor(node);
  const fills = Array.isArray(node.fills) ? node.fills : [];
  const onCommit = useApplyHex(apply);
  return (
    <PanelSection title="Fill">
      <CommitText
        value={solidFill ? colorToCss(solidFill) : ""}
        onCommit={onCommit}
        placeholder="#RRGGBB"
        disabled={disabled}
      />
      <MonoText>{fills.length > 0 ? `${fills.length} paint(s)` : "No fills"}</MonoText>
    </PanelSection>
  );
}

function useApplyHex(apply: (patch: InspectEditPatch) => void) {
  return useCallback((hex: string) => apply({ fillColor: hex }), [apply]);
}

function StrokeSection({ node }: { node: FigmaNode }) {
  const strokes = Array.isArray(node.strokes) ? node.strokes : [];
  const solidStroke = strokes
    .map((entry) => dict(entry))
    .find((paint) => paint.type === "SOLID" && paint.visible !== false);
  return (
    <PanelSection title="Stroke">
      <PanelRow label="Weight">
        <MonoText>{num(node.strokeWeight) ?? 0}px</MonoText>
      </PanelRow>
      {solidStroke ? (
        <PanelRow label="Color">
          <MonoText>{colorToCss(dict(solidStroke).color, solidStroke.opacity)}</MonoText>
        </PanelRow>
      ) : null}
    </PanelSection>
  );
}

function AppearanceSection({
  node,
  disabled,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const effects = Array.isArray(node.effects) ? node.effects : [];
  return (
    <PanelSection title="Appearance">
      <NumberFieldRow
        label="Radius"
        value={num(node.cornerRadius)}
        disabled={disabled}
        apply={apply}
        patchKey="cornerRadius"
      />
      {effects.length > 0 ? (
        <PanelRow label="Effects">
          <MonoText>{effects.map((entry) => String(dict(entry).type)).join(", ")}</MonoText>
        </PanelRow>
      ) : null}
      <PanelRow label="Opacity">
        <MonoText>{Math.round((num(node.opacity) ?? 1) * 100)}%</MonoText>
      </PanelRow>
    </PanelSection>
  );
}

function TextSection({
  node,
  disabled,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const style = dict(node.style);
  return (
    <PanelSection title="Text">
      <TextFieldRow
        value={String(node.characters ?? "")}
        patchKey="characters"
        apply={apply}
        multiline
        disabled={disabled}
      />
      <PanelRow label="Font">
        <MonoText>
          {`${dict(style.fontName).family ?? "—"} ${dict(style.fontName).style ?? ""}`}
        </MonoText>
      </PanelRow>
      <PanelRow label="Size">
        <MonoText>{num(style.fontSize) ?? 0}px</MonoText>
      </PanelRow>
      <PanelRow label="Line height">
        <MonoText>{num(style.lineHeightPx) ?? "auto"}</MonoText>
      </PanelRow>
      <PanelRow label="Letter spacing">
        <MonoText>{num(style.letterSpacing) ?? 0}</MonoText>
      </PanelRow>
      <PanelRow label="Align">
        <MonoText>{String(style.textAlignHorizontal ?? "LEFT")}</MonoText>
      </PanelRow>
    </PanelSection>
  );
}

function ComponentSection({ node }: { node: FigmaNode }) {
  return (
    <PanelSection title="Component">
      <PanelRow label="Component">
        <MonoText>{String(node.componentId)}</MonoText>
      </PanelRow>
      <PanelRow label="Main">
        <MonoText>{node.isExternalOnly === true ? "External" : "Team library"}</MonoText>
      </PanelRow>
    </PanelSection>
  );
}

function CssSection({ node }: { node: FigmaNode }) {
  const css = useMemo(() => generateNodeCss(node), [node]);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(css);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [css]);
  const copyButton = useMemo(
    () => (
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Copy}
        onPress={copy}
        accessibilityLabel="Copy CSS"
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    ),
    [copy, copied],
  );
  return (
    <PanelSection title="CSS" right={copyButton}>
      {css ? (
        <Text style={[jiraStyles.mono, styles.cssText]} selectable>
          {css}
        </Text>
      ) : (
        <MonoText muted>No CSS for this node</MonoText>
      )}
    </PanelSection>
  );
}

// Format/scale segmented control. The per-value closure lives inside this child so the
// Button's onPress prop stays a stable useCallback.
function SegButton({
  value,
  label,
  selected,
  onSelectValue,
}: {
  value: string;
  label: string;
  selected: boolean;
  onSelectValue: (value: string) => void;
}) {
  const onPress = useCallback(() => onSelectValue(value), [onSelectValue, value]);
  return (
    <Button
      size="sm"
      variant={selected ? "outline" : "ghost"}
      onPress={onPress}
      disabled={selected}
    >
      {label}
    </Button>
  );
}

function ExportSection({
  serverId,
  fileKey,
  node,
  linked,
}: {
  serverId: string;
  fileKey: string;
  node: FigmaNode;
  linked: boolean;
}) {
  const [format, setFormat] = useState<(typeof EXPORT_FORMATS)[number]>("png");
  const [scale, setScale] = useState<(typeof EXPORT_SCALES)[number]>(2);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [result, setResult] = useState<{ bytes: FigmaBytes; fileName: string } | null>(null);

  useEffect(() => {
    setState("idle");
    setResult(null);
  }, [node.id]);

  const run = useCallback(async () => {
    setState("busy");
    try {
      const data = await fetchFigmaExport(serverId, fileKey, node.id, format, scale);
      if (!data.file) {
        setState("error");
        return;
      }
      setResult({
        bytes: data.file,
        fileName: data.fileName ?? `${String(node.name ?? "export")}.${format}`,
      });
      setState("done");
    } catch {
      setState("error");
    }
  }, [serverId, fileKey, node.id, node.name, format, scale]);

  const pickFormat = useCallback((candidate: string) => {
    setFormat(candidate as (typeof EXPORT_FORMATS)[number]);
  }, []);
  const pickScale = useCallback((candidate: string) => {
    setScale(Number(candidate) as (typeof EXPORT_SCALES)[number]);
  }, []);
  const startExport = useCallback(() => {
    void run();
  }, [run]);
  const save = useCallback(() => {
    if (result) void saveExportedBytes(result.bytes, result.fileName);
  }, [result]);

  return (
    <PanelSection title="Export">
      <View style={jiraStyles.rowWrap}>
        {EXPORT_FORMATS.map((candidate) => (
          <SegButton
            key={candidate}
            value={candidate}
            label={candidate.toUpperCase()}
            selected={candidate === format}
            onSelectValue={pickFormat}
          />
        ))}
        {EXPORT_SCALES.map((candidate) => (
          <SegButton
            key={candidate}
            value={String(candidate)}
            label={`${candidate}×`}
            selected={candidate === scale}
            onSelectValue={pickScale}
          />
        ))}
      </View>
      <View style={jiraStyles.row}>
        <Button size="sm" variant="secondary" onPress={startExport} disabled={state === "busy"}>
          {state === "busy" ? "Exporting…" : "Export"}
        </Button>
        {result ? (
          <Button size="sm" variant="default" leftIcon={Download} onPress={save}>
            Save {result.fileName}
          </Button>
        ) : null}
      </View>
      {state === "error" ? (
        <ErrorBanner message={linked ? "Export failed." : "Export failed — check the queue."} />
      ) : null}
    </PanelSection>
  );
}

// ---- Panel

export interface InspectPanelProps {
  serverId: string;
  fileKey: string;
  /** The selected node's raw data, or null when nothing is selected. */
  node: FigmaNode | null;
  /** Whether the file is open in Figma Link — edits go straight through when true (32.6). */
  linked: boolean;
  applyEdits: ApplyFigmaEdits;
  disabled?: boolean;
}

export function InspectPanel({
  serverId,
  fileKey,
  node,
  linked,
  applyEdits,
  disabled,
}: InspectPanelProps) {
  const apply = useCallback(
    (patch: InspectEditPatch) => {
      if (!node) return;
      void applyEdits(buildEditOps(node.id, patch)).catch(() => undefined);
    },
    [node, applyEdits],
  );
  const renderEmpty = useCallback(
    () => (
      <View style={styles.emptyWrap}>
        <Text style={jiraStyles.textMuted}>Select a layer on the canvas to inspect it.</Text>
      </View>
    ),
    [],
  );

  if (!node) return renderEmpty();

  const isText = node.type === "TEXT";
  const transitions = Array.isArray(node.transitions) ? node.transitions : [];
  const interaction = node as FigmaNode & {
    interaction?: { type?: string; targetNodeId?: string };
  };

  return (
    <ScrollView
      style={styles.panel}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      testID="figma-inspect-panel"
    >
      <View style={styles.header}>
        <Text style={jiraStyles.textStrong} numberOfLines={1}>
          {String(node.name ?? "Untitled")}
        </Text>
        <Text style={jiraStyles.textSmall}>
          {String(node.type ?? "NODE")} · {node.id}
        </Text>
      </View>

      <LayerSection node={node} disabled={disabled} apply={apply} />
      <GeometrySection node={node} disabled={disabled} apply={apply} />
      <AutoLayoutSection node={node} disabled={disabled} apply={apply} />
      {!isText ? <FillSection node={node} disabled={disabled} apply={apply} /> : null}
      <StrokeSection node={node} />
      <AppearanceSection node={node} disabled={disabled} apply={apply} />
      {isText ? <TextSection node={node} disabled={disabled} apply={apply} /> : null}
      {node.componentId ? <ComponentSection node={node} /> : null}

      {transitions.length > 0 ? (
        <PanelSection title="Interaction">
          {transitions.map((raw) => {
            const entry = dict(raw);
            const flow = `${String(entry.trigger ?? "?")} → ${String(entry.destinationId ?? entry.destinationNode ?? "—")}`;
            return (
              <PanelRow key={flow} label="Flow">
                <MonoText>{flow}</MonoText>
              </PanelRow>
            );
          })}
        </PanelSection>
      ) : null}

      {interaction.interaction ? (
        <PanelSection title="Action">
          <PanelRow label="Type">
            <MonoText>{String(interaction.interaction?.type ?? "—")}</MonoText>
          </PanelRow>
          <PanelRow label="Target">
            <MonoText>{String(interaction.interaction?.targetNodeId ?? "—")}</MonoText>
          </PanelRow>
        </PanelSection>
      ) : null}

      <CssSection node={node} />
      <ExportSection serverId={serverId} fileKey={fileKey} node={node} linked={linked} />
    </ScrollView>
  );
}
