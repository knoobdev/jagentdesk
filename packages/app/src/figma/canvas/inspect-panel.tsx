// Right-hand inspect panel: selected node fields, edit controls that build ops,
// generated CSS, and an export section.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Input, ErrorBanner } from "@/jira/ui/primitives";
import { Button } from "@/components/ui/button";
import { jiraStyles } from "@/jira/ui/styles";
import type {
  FigmaNode,
  FigmaBytes,
  FigmaComponentMeta,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaColor } from "./protocol-types";
import type { ApplyFigmaEdits } from "../contracts";
import { buildEditOps, type InspectEditPatch } from "./ops";
import { generateNodeCss, gradientFills, colorToCss, type GradientFillInfo } from "./css";
import { baseTextStyle } from "../renderer/node-props";
import { isWeb } from "@/constants/platform";
import { PanelSection, PanelRow, MonoText } from "./panel-ui";
import { errorMessage } from "./api";
import { fetchFigmaExport, useFigmaPendingOps } from "./use-figma-file";
import { nodeEditState, type PendingField } from "./edit-state";
import { EditFailureBanner, PendingBadge, PendingNote } from "./edit-state-view";
import { saveExportedBytes } from "./save-bytes";
import * as Clipboard from "expo-clipboard";
import { Copy, Download, Eye, EyeOff, Lock, Unlock } from "lucide-react-native";

const EXPORT_FORMATS = ["png", "jpg", "svg", "pdf"] as const;
const EXPORT_SCALES = [1, 2, 4] as const;

interface ExportResult {
  bytes: FigmaBytes;
  fileName: string;
}

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
    backgroundColor: theme.colors.surface0,
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
  swatch: {
    width: 36,
    height: 20,
    borderRadius: 4,
    overflow: "hidden",
  },
  stopSwatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
    overflow: "hidden",
    marginRight: 6,
    flexShrink: 0,
  },
  gradientRow: {
    alignSelf: "stretch",
    gap: 4,
  },
  stopsWrap: {
    alignSelf: "stretch",
    gap: 2,
    paddingLeft: 44,
  },
}));

// ---- generic committed-field rows (handlers are useCallback so the JSX props stay referentially stable)

function NumberFieldRow({
  label,
  value,
  disabled,
  pending,
  apply,
  patchKey,
  toPatchValue,
}: {
  label: string;
  value: number | undefined;
  disabled?: boolean;
  pending?: boolean;
  apply: (patch: InspectEditPatch) => void;
  patchKey: keyof InspectEditPatch;
  /** Converts the displayed (relative) number back to what the op carries (page-absolute). */
  toPatchValue?: (value: number) => number;
}) {
  const onCommit = useCallback(
    (next: number) =>
      apply({ [patchKey]: toPatchValue ? toPatchValue(next) : next } as InspectEditPatch),
    [apply, patchKey, toPatchValue],
  );
  return (
    <NumField
      label={label}
      value={value}
      disabled={disabled}
      pending={pending}
      onCommit={onCommit}
    />
  );
}

function TextFieldRow({
  value,
  patchKey,
  apply,
  multiline,
  placeholder,
  disabled,
  pending,
}: {
  value: string;
  patchKey: keyof InspectEditPatch;
  apply: (patch: InspectEditPatch) => void;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  pending?: boolean;
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
      pending={pending}
    />
  );
}

// ---- NumField: numeric commit-on-blur input

function NumField({
  label,
  value,
  disabled,
  pending,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  disabled?: boolean;
  /** The displayed value comes from the local queue, not from Figma (32.6.1). */
  pending?: boolean;
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
      <View style={jiraStyles.row}>
        <Text style={jiraStyles.formLabel}>{label}</Text>
        {pending ? <PendingBadge /> : null}
      </View>
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
  pending,
}: {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  pending?: boolean;
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
      {pending ? (
        <View style={jiraStyles.row}>
          <PendingBadge />
        </View>
      ) : null}
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
  pending,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  pending: ReadonlySet<PendingField>;
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
        pending={pending.has("name")}
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
        {pending.has("visible") ? <PendingBadge /> : null}
        <Button
          size="sm"
          variant={locked ? "outline" : "ghost"}
          leftIcon={locked ? Lock : Unlock}
          onPress={toggleLock}
        >
          {locked ? "Locked" : "Unlocked"}
        </Button>
        {pending.has("locked") ? <PendingBadge /> : null}
      </View>
    </PanelSection>
  );
}

function GeometrySection({
  node,
  disabled,
  pending,
  apply,
  parentOf,
}: {
  node: FigmaNode;
  disabled?: boolean;
  pending: ReadonlySet<PendingField>;
  apply: (patch: InspectEditPatch) => void;
  /** Parent within a loaded subtree: null = top-level frame, undefined = not loaded. */
  parentOf?: (nodeId: string) => FigmaNode | null | undefined;
}) {
  const bounds = dict(node.absoluteBoundingBox);
  // Figma's own inspector shows position relative to the containing frame; set_geometry
  // carries page-absolute coordinates (pending-overrides writes them straight into
  // absoluteBoundingBox), so the display subtracts the parent offset and edits add it back.
  // A top-level frame (parentOf → null) or an unloaded parent keeps the absolute number.
  const parent = parentOf?.(String(node.id));
  const parentBox = dict(parent?.absoluteBoundingBox);
  const offsetX = parent ? (num(parentBox.x) ?? 0) : 0;
  const offsetY = parent ? (num(parentBox.y) ?? 0) : 0;
  const absX = num(bounds.x);
  const absY = num(bounds.y);
  const toAbsoluteX = useCallback((value: number) => value + offsetX, [offsetX]);
  const toAbsoluteY = useCallback((value: number) => value + offsetY, [offsetY]);
  return (
    <PanelSection title="Size & position">
      <View style={jiraStyles.row}>
        <NumberFieldRow
          label="W"
          value={num(bounds.width)}
          disabled={disabled}
          pending={pending.has("width")}
          apply={apply}
          patchKey="width"
        />
        <NumberFieldRow
          label="H"
          value={num(bounds.height)}
          disabled={disabled}
          pending={pending.has("height")}
          apply={apply}
          patchKey="height"
        />
      </View>
      <View style={jiraStyles.row}>
        <NumberFieldRow
          label="X"
          value={absX === undefined ? undefined : absX - offsetX}
          disabled={disabled}
          pending={pending.has("x")}
          apply={apply}
          patchKey="x"
          toPatchValue={toAbsoluteX}
        />
        <NumberFieldRow
          label="Y"
          value={absY === undefined ? undefined : absY - offsetY}
          disabled={disabled}
          pending={pending.has("y")}
          apply={apply}
          patchKey="y"
          toPatchValue={toAbsoluteY}
        />
      </View>
    </PanelSection>
  );
}

const PADDING_KEYS = {
  top: "paddingTop",
  right: "paddingRight",
  bottom: "paddingBottom",
  left: "paddingLeft",
} as const;

function PaddingField({
  side,
  label,
  value,
  node,
  disabled,
  pending,
  apply,
}: {
  side: keyof typeof PADDING_KEYS;
  label: string;
  value: number | undefined;
  node: FigmaNode;
  disabled?: boolean;
  pending?: boolean;
  apply: (patch: InspectEditPatch) => void;
}) {
  const onCommit = useCallback(
    (next: number) =>
      apply({
        padding: {
          top: side === "top" ? next : (num(node[PADDING_KEYS.top]) ?? 0),
          right: side === "right" ? next : (num(node[PADDING_KEYS.right]) ?? 0),
          bottom: side === "bottom" ? next : (num(node[PADDING_KEYS.bottom]) ?? 0),
          left: side === "left" ? next : (num(node[PADDING_KEYS.left]) ?? 0),
        },
      }),
    [apply, side, node],
  );
  return (
    <NumField
      label={label}
      value={value}
      disabled={disabled}
      pending={pending}
      onCommit={onCommit}
    />
  );
}

function AutoLayoutSection({
  node,
  disabled,
  pending,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  pending: ReadonlySet<PendingField>;
  apply: (patch: InspectEditPatch) => void;
}) {
  const layoutMode = typeof node.layoutMode === "string" ? node.layoutMode : null;
  const setRow = useCallback(() => apply({ layoutMode: "HORIZONTAL" }), [apply]);
  const setColumn = useCallback(() => apply({ layoutMode: "VERTICAL" }), [apply]);
  const clear = useCallback(() => apply({ layoutMode: "NONE" }), [apply]);
  const onGap = useCallback((itemSpacing: number) => apply({ itemSpacing }), [apply]);
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
        {pending.has("layoutMode") ? <PendingBadge /> : null}
      </View>
      {showSpacing ? (
        <>
          <NumField
            label="Gap"
            value={num(node.itemSpacing)}
            disabled={disabled}
            pending={pending.has("itemSpacing")}
            onCommit={onGap}
          />
          <Text style={jiraStyles.formLabel}>Padding</Text>
          <View style={jiraStyles.row}>
            <PaddingField
              side="top"
              label="Top"
              node={node}
              value={num(node.paddingTop)}
              disabled={disabled}
              pending={pending.has("padding")}
              apply={apply}
            />
            <PaddingField
              side="right"
              label="Right"
              node={node}
              value={num(node.paddingRight)}
              disabled={disabled}
              pending={pending.has("padding")}
              apply={apply}
            />
            <PaddingField
              side="bottom"
              label="Bottom"
              node={node}
              value={num(node.paddingBottom)}
              disabled={disabled}
              pending={pending.has("padding")}
              apply={apply}
            />
            <PaddingField
              side="left"
              label="Left"
              node={node}
              value={num(node.paddingLeft)}
              disabled={disabled}
              pending={pending.has("padding")}
              apply={apply}
            />
          </View>
        </>
      ) : null}
    </PanelSection>
  );
}

const GRADIENT_LABELS: Record<string, string> = {
  GRADIENT_LINEAR: "Linear gradient",
  GRADIENT_RADIAL: "Radial gradient",
  GRADIENT_ANGULAR: "Angular gradient",
  GRADIENT_DIAMOND: "Diamond gradient",
};

function GradientFillRow({ fill }: { fill: GradientFillInfo }) {
  // Web renders the gradient through the CSS `background` shorthand (not in RN's ViewStyle);
  // native falls back to the first stop color. Keep the whole thing typed as a View style so
  // <View style=…> accepts the array — the web-only `background` is an intentional escape.
  const swatchStyle: StyleProp<ViewStyle> = isWeb
    ? [{ background: fill.css } as unknown as ViewStyle, styles.swatch]
    : [{ backgroundColor: fill.colors[0] ?? "transparent" }, styles.swatch];
  return (
    <View style={styles.gradientRow} testID="figma-inspect-gradient-fill">
      <View style={jiraStyles.row}>
        <View style={swatchStyle} />
        <Text style={jiraStyles.textSmall}>{GRADIENT_LABELS[fill.type] ?? "Gradient"}</Text>
      </View>
      <View style={styles.stopsWrap}>
        {fill.stopEntries.map((stop) => (
          <View
            key={`${stop.color}@${stop.position}`}
            style={jiraStyles.row}
            testID="figma-inspect-gradient-stop"
          >
            <View style={[{ backgroundColor: stop.color }, styles.stopSwatch]} />
            <MonoText>{`${stop.color} ${stop.position}%`}</MonoText>
          </View>
        ))}
      </View>
    </View>
  );
}

function FillSection({
  node,
  disabled,
  pending,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  pending: ReadonlySet<PendingField>;
  apply: (patch: InspectEditPatch) => void;
}) {
  const solidFill = firstSolidColor(node);
  const gradients = gradientFills(node);
  const fills = Array.isArray(node.fills) ? node.fills : [];
  const onCommit = useApplyHex(apply);
  return (
    <PanelSection title="Fill">
      {gradients.map((fill) => (
        <GradientFillRow key={fill.css} fill={fill} />
      ))}
      {solidFill || gradients.length === 0 ? (
        <CommitText
          value={solidFill ? colorToCss(solidFill) : ""}
          onCommit={onCommit}
          placeholder="#RRGGBB"
          disabled={disabled}
          pending={pending.has("fillColor")}
        />
      ) : null}
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
  pending,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  pending: ReadonlySet<PendingField>;
  apply: (patch: InspectEditPatch) => void;
}) {
  const effects = Array.isArray(node.effects) ? node.effects : [];
  return (
    <PanelSection title="Appearance">
      <NumberFieldRow
        label="Radius"
        value={num(node.cornerRadius)}
        disabled={disabled}
        pending={pending.has("cornerRadius")}
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
  pending,
  apply,
}: {
  node: FigmaNode;
  disabled?: boolean;
  pending: ReadonlySet<PendingField>;
  apply: (patch: InspectEditPatch) => void;
}) {
  const style = dict(node.style);
  // baseTextStyle normalises REST (`fontFamily`/`fontStyle` top-level) and Plugin-API
  // (`fontName.family`/`fontName.style`) shapes; only the Font row needs the merged view.
  const textStyle = baseTextStyle(node);
  return (
    <PanelSection title="Text">
      <TextFieldRow
        value={String(node.characters ?? "")}
        patchKey="characters"
        apply={apply}
        multiline
        disabled={disabled}
        pending={pending.has("characters")}
      />
      <PanelRow label="Font">
        <MonoText>{`${textStyle.fontFamily ?? "—"} ${textStyle.fontStyle ?? ""}`}</MonoText>
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

function ComponentSection({
  node,
  componentMeta,
}: {
  node: FigmaNode;
  componentMeta?: (componentId: string) => FigmaComponentMeta | undefined;
}) {
  const componentId = String(node.componentId ?? "");
  const meta = componentMeta?.(componentId);
  const name = meta?.name || componentId;
  return (
    <PanelSection title="Component">
      <PanelRow label="Component">
        <MonoText>{name}</MonoText>
      </PanelRow>
      <PanelRow label="Main">
        <MonoText>{componentOriginLabel(meta)}</MonoText>
      </PanelRow>
    </PanelSection>
  );
}

// The local-vs-team origin only exists once the components map has loaded; labelling an
// unloaded component "Local" would be a guess, not a fact.
function componentOriginLabel(meta: FigmaComponentMeta | undefined): string {
  if (!meta) return "—";
  return meta.remote === true ? "Team library" : "Local component";
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
}: {
  serverId: string;
  fileKey: string;
  node: FigmaNode;
}) {
  const [format, setFormat] = useState<(typeof EXPORT_FORMATS)[number]>("png");
  const [scale, setScale] = useState<(typeof EXPORT_SCALES)[number]>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    setBusy(false);
    setError(null);
    setResult(null);
  }, [node.id]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchFigmaExport(serverId, fileKey, node.id, format, scale);
      if (!data.file) {
        setError("Export returned no file.");
        return;
      }
      setResult({
        bytes: data.file,
        fileName: data.fileName ?? `${String(node.name ?? "export")}.${format}`,
      });
    } catch (cause) {
      // The daemon's own failure (rate limit, unsupported format, …) is the message the user
      // needs — dropping it hid real export failures behind a generic banner.
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
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
        <Button size="sm" variant="secondary" onPress={startExport} disabled={busy}>
          {busy ? "Exporting…" : "Export"}
        </Button>
        {result ? (
          <Button size="sm" variant="default" leftIcon={Download} onPress={save}>
            Save {result.fileName}
          </Button>
        ) : null}
      </View>
      {error ? <ErrorBanner message={error} /> : null}
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
  /** Component metadata from the loaded subtrees (spec 32.5.2): names + library vs local origin. */
  componentMeta?: (componentId: string) => FigmaComponentMeta | undefined;
  /**
   * Parent of a node inside a loaded subtree (FrameStore.parentOf): null for top-level frames,
   * undefined when no cached subtree contains the node. Geometry position is displayed relative
   * to the parent, absolute otherwise.
   */
  parentOf?: (nodeId: string) => FigmaNode | null | undefined;
}

export function InspectPanel({
  serverId,
  fileKey,
  node,
  applyEdits,
  disabled,
  componentMeta,
  parentOf,
}: InspectPanelProps) {
  const pendingOps = useFigmaPendingOps(serverId, fileKey);
  const [editError, setEditError] = useState<string | null>(null);
  // Queued values preview in the fields and carry a Pending badge; the raw node stays for
  // facts the queue cannot change (export runs against the file as Figma has it).
  const editState = useMemo(
    () => (node ? nodeEditState(node, pendingOps) : null),
    [node, pendingOps],
  );
  useEffect(() => setEditError(null), [node?.id]);

  const apply = useCallback(
    (patch: InspectEditPatch) => {
      if (!node) return;
      // buildEditOps throws synchronously on bad input (e.g. a malformed hex); CommitText
      // catches that inline. Only the async RPC result becomes a banner.
      void applyEdits(buildEditOps(node.id, patch)).then(
        () => setEditError(null),
        (cause: unknown) => setEditError(errorMessage(cause)),
      );
    },
    [node, applyEdits],
  );
  const dismissError = useCallback(() => setEditError(null), []);
  const renderEmpty = useCallback(
    () => (
      <View style={styles.emptyWrap}>
        <Text style={jiraStyles.textMuted}>Select a layer on the canvas to inspect it.</Text>
      </View>
    ),
    [],
  );

  if (!node || !editState) return renderEmpty();

  const view = editState.node;
  const pending = editState.pendingFields;
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
          {String(view.name ?? "Untitled")}
        </Text>
        <Text style={jiraStyles.textSmall}>
          {String(node.type ?? "NODE")} · {node.id}
        </Text>
        {editState.pendingCount > 0 ? <PendingNote count={editState.pendingCount} /> : null}
      </View>

      {editError ? <EditFailureBanner message={editError} onDismiss={dismissError} /> : null}

      <LayerSection node={view} disabled={disabled} pending={pending} apply={apply} />
      <GeometrySection
        node={view}
        disabled={disabled}
        pending={pending}
        apply={apply}
        parentOf={parentOf}
      />
      <AutoLayoutSection node={view} disabled={disabled} pending={pending} apply={apply} />
      {!isText ? (
        <FillSection node={view} disabled={disabled} pending={pending} apply={apply} />
      ) : null}
      <StrokeSection node={node} />
      <AppearanceSection node={view} disabled={disabled} pending={pending} apply={apply} />
      {isText ? (
        <TextSection node={view} disabled={disabled} pending={pending} apply={apply} />
      ) : null}
      {node.componentId ? <ComponentSection node={node} componentMeta={componentMeta} /> : null}

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

      <CssSection node={view} />
      <ExportSection serverId={serverId} fileKey={fileKey} node={node} />
    </ScrollView>
  );
}
