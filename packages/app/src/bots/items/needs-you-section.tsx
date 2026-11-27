// Needs you's rows: approvals first and never folded, then chat questions, connectors to fix, and
// the items waiting on the owner (spec 37.4.4 a–e); max(5, approvals) shown, then "Show N more" when
// two or more are hidden. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotNeedsYouSection.tsx:306-427, folding with the shared
// `needsYouFold` (Orca `shared/bots/needs-you-fold.ts`). The asks come from `bots.needs_you.list`,
// already in display order; its item rows are drawn from the item list as item rows.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { needsYouFold } from "@jagentdesk/protocol/bots/rules";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { BotNeedsYouRow } from "@jagentdesk/protocol/bots/views";
import { itemStyles } from "./item-parts";
import { BotNeedRow } from "./need-row";
import { botNeedsYouRows } from "./item-rules";

export function BotNeedsYouSection({
  serverId,
  bot,
  asks,
  items,
  renderItem,
  revealId = null,
}: {
  serverId: string;
  bot: Bot;
  asks: readonly BotNeedsYouRow[];
  /** The items in Needs you, after the asks, in their group's order. */
  items: readonly BotItem[];
  renderItem: (item: BotItem) => ReactNode;
  /** The item Back returns to: shown even past the cap. */
  revealId?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const rows = useMemo(() => botNeedsYouRows(asks, items), [asks, items]);
  const fold = needsYouFold(rows, {
    expanded,
    focusedKey: revealId ? `item:${revealId}` : null,
  });
  if (!fold.folds && expanded) {
    // Too few rows to fold: when they grow back, the group starts folded again.
    setExpanded(false);
  }
  if (rows.length === 0) return null;
  const shown = new Set(fold.visible);
  return (
    <View testID="bot-needs-you">
      {fold.ordered.map((row) =>
        shown.has(row.key) ? (
          <View key={row.key}>
            {row.kind === "item" ? (
              renderItem(row.item)
            ) : (
              <BotNeedRow serverId={serverId} bot={bot} row={row.need} />
            )}
          </View>
        ) : null,
      )}
      {fold.hidden > 0 ? (
        <Pressable
          style={itemStyles.showMore}
          onPress={expand}
          accessibilityRole="button"
          testID="bot-needs-you-more"
        >
          <Text style={itemStyles.muted}>
            {t("bots.items.group.showMore", { count: fold.hidden })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
