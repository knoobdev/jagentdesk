import { useMemo } from "react";
import type { ArgoCdAppDetail } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { ScrollView, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  layoutResourceGraph,
  type GraphEdgePlacement,
} from "./graph-layout";
import { AppNodeCard, ResourceNodeCard } from "./resource-node-card";
import {
  APP_NODE_ID,
  visibleChildren,
  type ArgoCdFilteredResources,
  type ArgoCdResourceModel,
} from "./resources";

function EdgeLayer({
  edges,
  width,
  height,
  color,
}: {
  edges: readonly GraphEdgePlacement[];
  width: number;
  height: number;
  color: string;
}) {
  return (
    <Svg width={width} height={height} style={styles.edges}>
      {edges.map((edge) => (
        <Path
          key={`${edge.from}->${edge.to}`}
          d={edge.path}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
        />
      ))}
    </Svg>
  );
}

// The theme colour reaches the SVG through this wrapper: react-native-svg's `stroke` is not a
// style prop, and wrapping `Path` itself leaks `uniProps` onto the DOM on web.
const ThemedEdgeLayer = withUnistyles(EdgeLayer);
const edgeColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** Desktop Tree view: the app at the left, owned resources fanning out to the right. */
export function ArgoCdResourceGraph({
  app,
  model,
  filtered,
  selectedId,
  onSelect,
}: {
  app: Pick<ArgoCdAppDetail, "name" | "health" | "sync">;
  model: ArgoCdResourceModel;
  filtered: ArgoCdFilteredResources;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(
    () =>
      layoutResourceGraph({
        rootId: APP_NODE_ID,
        children: visibleChildren(model, filtered.visible),
        edges: model.edges,
      }),
    [model, filtered.visible],
  );
  const canvasStyle = useMemo(
    () => [styles.canvas, inlineUnistylesStyle({ width: layout.width, height: layout.height })],
    [layout.width, layout.height],
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <ScrollView horizontal contentContainerStyle={styles.scrollContent}>
        <View style={canvasStyle} testID="argocd-resource-graph">
          <ThemedEdgeLayer
            edges={layout.edges}
            width={layout.width}
            height={layout.height}
            uniProps={edgeColor}
          />
          {layout.nodes.map((placement) => {
            const positionStyle = inlineUnistylesStyle({
              left: placement.x,
              top: placement.y,
              width: GRAPH_NODE_WIDTH,
              height: GRAPH_NODE_HEIGHT,
            });
            if (placement.id === APP_NODE_ID) {
              return (
                <View key={placement.id} style={[styles.node, positionStyle]}>
                  <AppNodeCard name={app.name} health={app.health} sync={app.sync} />
                </View>
              );
            }
            const item = model.items.get(placement.id);
            if (!item) return null;
            return (
              <View key={placement.id} style={[styles.node, positionStyle]}>
                <ResourceNodeCard
                  item={item}
                  selected={selectedId === item.id}
                  dimmed={!filtered.matched.has(item.id)}
                  onSelect={onSelect}
                />
              </View>
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  canvas: {
    position: "relative",
  },
  edges: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  node: {
    position: "absolute",
  },
});
