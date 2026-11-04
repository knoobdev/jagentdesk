import { ScrollView, Text, View } from "react-native";
import { errorMessage } from "../api";
import { useJiraFilters } from "../queries";
import { EmptyState, ErrorBanner, PressableRow } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// Filters (spec 29.3): mine and favourites; opening one runs its JQL in Search.

export function FiltersView({
  serverId,
  connectionId,
  onOpenFilter,
}: {
  serverId: string;
  connectionId: string;
  onOpenFilter: (jql: string) => void;
}) {
  const filters = useJiraFilters(serverId, connectionId);
  const list = filters.data ?? [];
  const empty = !filters.isLoading && list.length === 0 && !filters.error;
  return (
    <ScrollView
      style={jiraStyles.scroll}
      contentContainerStyle={jiraStyles.scrollContent}
      testID="jira-filters"
    >
      {filters.error ? <ErrorBanner message={errorMessage(filters.error)} /> : null}
      {filters.isLoading ? <Text style={jiraStyles.textMuted}>Loading filters…</Text> : null}
      {empty ? (
        <EmptyState title="No filters" body="Save a search as a filter, or star filters in Jira." />
      ) : null}
      {list.length > 0 ? (
        <View style={jiraStyles.card}>
          {list.map((filter, index) => (
            <PressableRow
              key={filter.id}
              value={filter.jql}
              onPick={onOpenFilter}
              last={index === list.length - 1}
              testID={`jira-filter-${filter.id}`}
            >
              <View style={jiraStyles.main}>
                <Text style={jiraStyles.textStrong}>
                  {filter.favourite ? `★ ${filter.name}` : filter.name}
                </Text>
                <Text style={jiraStyles.mono} numberOfLines={1}>
                  {filter.jql}
                </Text>
              </View>
              <Text style={jiraStyles.textSmall}>
                {filter.mine ? "Mine" : (filter.owner ?? "")}
              </Text>
            </PressableRow>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
