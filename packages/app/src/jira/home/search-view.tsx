import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type {
  JiraIssueCard,
  JiraProject,
  JiraSuggestion,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { errorMessage, useJiraCall, type JiraCall } from "../api";
import { jiraKeys, useJiraProjects } from "../queries";
import { Chip, EmptyState, ErrorBanner, Field, Input, Tabs } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { IssueList } from "./issue-list";

// Search (spec 29.3): JQL with suggestions, or a basic mode that writes the JQL; results page with
// the daemon's nextPageToken; "Save as filter".

type Mode = "basic" | "jql";

const MODE_TABS: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: "basic", label: "Basic" },
  { id: "jql", label: "JQL" },
];

interface Basic {
  projectKey: string | null;
  mine: boolean;
  openOnly: boolean;
  text: string;
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export function basicToJql(basic: Basic): string {
  const clauses = [
    basic.projectKey ? `project = ${basic.projectKey}` : null,
    basic.mine ? "assignee = currentUser()" : null,
    basic.openOnly ? "statusCategory != Done" : null,
    basic.text.trim() ? `text ~ ${quote(basic.text.trim())}` : null,
  ].filter((clause): clause is string => clause !== null);
  return `${clauses.join(" AND ")} ORDER BY updated DESC`.trim();
}

/** The word being typed and, when it follows `field =`, that field. */
function suggestionTarget(jql: string): { fieldName?: string; value: string } {
  const valueMatch = /([\w.]+)\s*(=|!=|~|in\s*\(|IN\s*\()\s*"?([^"\s,()]*)$/.exec(jql);
  if (valueMatch) return { fieldName: valueMatch[1], value: valueMatch[3] ?? "" };
  return { value: /([\w.]*)$/.exec(jql)?.[1] ?? "" };
}

async function fetchSuggestions(
  call: JiraCall,
  connectionId: string,
  jql: string,
): Promise<JiraSuggestion[]> {
  const target = suggestionTarget(jql);
  if (!target.fieldName && target.value.length < 2) return [];
  try {
    const result = await call("jira.jql.suggest.request", { connectionId, ...target });
    return result.suggestions.slice(0, 8);
  } catch (error) {
    // Suggestions only assist typing; a failed lookup (partial JQL, offline) shows none.
    if (error instanceof Error) return [];
    throw error;
  }
}

function useJqlSuggestions(serverId: string, connectionId: string, jql: string): JiraSuggestion[] {
  const call = useJiraCall(serverId);
  const [suggestions, setSuggestions] = useState<JiraSuggestion[]>([]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const next = await fetchSuggestions(call, connectionId, jql);
        if (!cancelled) setSuggestions(next);
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [call, connectionId, jql]);
  return suggestions;
}

function applySuggestion(jql: string, suggestion: JiraSuggestion): string {
  const target = suggestionTarget(jql);
  return `${jql.slice(0, jql.length - target.value.length)}${suggestion.value} `;
}

type Results =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      jql: string;
      issues: JiraIssueCard[];
      nextPageToken: string | null;
      total: number | null;
    }
  | { kind: "error"; message: string };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

function SuggestionChip({
  suggestion,
  onPick,
}: {
  suggestion: JiraSuggestion;
  onPick: (suggestion: JiraSuggestion) => void;
}) {
  const pick = useCallback(() => onPick(suggestion), [onPick, suggestion]);
  return (
    <Pressable style={jiraStyles.chip} onPress={pick}>
      <Text style={jiraStyles.chipText}>{suggestion.label}</Text>
    </Pressable>
  );
}

function ProjectChip({
  project,
  active,
  onToggle,
}: {
  project: JiraProject;
  active: boolean;
  onToggle: (projectKey: string) => void;
}) {
  const toggle = useCallback(() => onToggle(project.key), [onToggle, project.key]);
  return <Chip label={project.key} active={active} onPress={toggle} />;
}

function BasicForm({
  basic,
  projects,
  onChange,
}: {
  basic: Basic;
  projects: JiraProject[];
  onChange: (basic: Basic) => void;
}) {
  const setText = useCallback((text: string) => onChange({ ...basic, text }), [basic, onChange]);
  const toggleProject = useCallback(
    (key: string) => onChange({ ...basic, projectKey: basic.projectKey === key ? null : key }),
    [basic, onChange],
  );
  const toggleMine = useCallback(
    () => onChange({ ...basic, mine: !basic.mine }),
    [basic, onChange],
  );
  const toggleOpen = useCallback(
    () => onChange({ ...basic, openOnly: !basic.openOnly }),
    [basic, onChange],
  );
  return (
    <View style={jiraStyles.formField}>
      <Input
        value={basic.text}
        onChangeText={setText}
        placeholder="Search text"
        testID="jira-search-text"
      />
      <View style={jiraStyles.rowWrap}>
        {projects.map((project) => (
          <ProjectChip
            key={project.key}
            project={project}
            active={basic.projectKey === project.key}
            onToggle={toggleProject}
          />
        ))}
        <Chip label="Assigned to me" active={basic.mine} onPress={toggleMine} />
        <Chip label="Open only" active={basic.openOnly} onPress={toggleOpen} />
      </View>
      <Text style={jiraStyles.mono}>{basicToJql(basic)}</Text>
    </View>
  );
}

function SaveFilter({
  serverId,
  connectionId,
  jql,
}: {
  serverId: string;
  connectionId: string;
  jql: string;
}) {
  const call = useJiraCall(serverId);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const save = useCallback(async () => {
    setState({ kind: "saving" });
    try {
      await call("jira.filters.save.request", {
        connectionId,
        name: name.trim(),
        jql,
        favourite: true,
      });
      await queryClient.invalidateQueries({ queryKey: jiraKeys.filters(serverId, connectionId) });
      setState({ kind: "saved" });
      setName("");
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }, [call, connectionId, jql, name, queryClient, serverId]);
  const handleSave = useCallback(() => void save(), [save]);
  return (
    <>
      <Field label="Save as filter">
        <View style={jiraStyles.row}>
          <View style={jiraStyles.main}>
            <Input
              value={name}
              onChangeText={setName}
              placeholder="Filter name"
              testID="jira-filter-name"
            />
          </View>
          <Button
            variant="secondary"
            disabled={!name.trim()}
            loading={state.kind === "saving"}
            onPress={handleSave}
            testID="jira-filter-save"
          >
            Save
          </Button>
        </View>
      </Field>
      {state.kind === "saved" ? <Text style={jiraStyles.textMuted}>Filter saved.</Text> : null}
      {state.kind === "error" ? <ErrorBanner message={state.message} /> : null}
    </>
  );
}

function ResultsView({
  serverId,
  connectionId,
  results,
  onOpenIssue,
  onMore,
}: {
  serverId: string;
  connectionId: string;
  results: Extract<Results, { kind: "ready" }>;
  onOpenIssue: (issueKey: string) => void;
  onMore: () => void;
}) {
  if (results.issues.length === 0) return <EmptyState title="No issues match" />;
  return (
    <>
      <Text style={jiraStyles.textSmall}>
        {results.total !== null
          ? `${results.issues.length} of ${results.total}`
          : `${results.issues.length} issues`}
      </Text>
      <IssueList issues={results.issues} onOpenIssue={onOpenIssue} testID="jira-search-results" />
      {results.nextPageToken ? (
        <Button variant="outline" onPress={onMore}>
          Load more
        </Button>
      ) : null}
      <SaveFilter serverId={serverId} connectionId={connectionId} jql={results.jql} />
    </>
  );
}

export function SearchView({
  serverId,
  connectionId,
  initialJql,
  onOpenIssue,
}: {
  serverId: string;
  connectionId: string;
  initialJql: string | null;
  onOpenIssue: (issueKey: string) => void;
}) {
  const call = useJiraCall(serverId);
  const projects = useJiraProjects(serverId, connectionId);
  const [mode, setMode] = useState<Mode>(initialJql ? "jql" : "basic");
  const [basic, setBasic] = useState<Basic>({
    projectKey: null,
    mine: false,
    openOnly: true,
    text: "",
  });
  const [jql, setJql] = useState(initialJql ?? "");
  const [results, setResults] = useState<Results>({ kind: "idle" });
  const suggestions = useJqlSuggestions(serverId, connectionId, mode === "jql" ? jql : "");
  const effectiveJql = useMemo(
    () => (mode === "basic" ? basicToJql(basic) : jql),
    [basic, jql, mode],
  );

  const run = useCallback(
    async (query: string, nextPageToken?: string) => {
      if (!query.trim()) return;
      if (!nextPageToken) setResults({ kind: "loading" });
      try {
        const page = await call("jira.search.request", {
          connectionId,
          jql: query,
          maxResults: 50,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
        setResults((previous) => {
          const earlier = nextPageToken && previous.kind === "ready" ? previous.issues : [];
          return {
            kind: "ready",
            jql: query,
            issues: [...earlier, ...page.issues],
            nextPageToken: page.nextPageToken,
            total: page.total,
          };
        });
      } catch (error) {
        setResults({ kind: "error", message: errorMessage(error) });
      }
    },
    [call, connectionId],
  );

  useEffect(() => {
    if (initialJql) void run(initialJql);
  }, [initialJql, run]);

  const changeMode = useCallback(
    (next: Mode) => {
      if (next === "jql" && mode === "basic") setJql(basicToJql(basic));
      setMode(next);
    },
    [basic, mode],
  );
  const pickSuggestion = useCallback(
    (suggestion: JiraSuggestion) => setJql((current) => applySuggestion(current, suggestion)),
    [],
  );
  const search = useCallback(() => void run(effectiveJql), [effectiveJql, run]);
  const more = useCallback(() => {
    if (results.kind === "ready" && results.nextPageToken) {
      void run(results.jql, results.nextPageToken);
    }
  }, [results, run]);

  return (
    <ScrollView
      style={jiraStyles.scroll}
      contentContainerStyle={jiraStyles.scrollContent}
      keyboardShouldPersistTaps="handled"
      testID="jira-search"
    >
      <Tabs tabs={MODE_TABS} value={mode} onChange={changeMode} testIDPrefix="jira-search-mode" />
      {mode === "basic" ? (
        <BasicForm basic={basic} projects={projects.data ?? []} onChange={setBasic} />
      ) : (
        <View style={jiraStyles.formField}>
          <Input
            value={jql}
            onChangeText={setJql}
            placeholder='project = <KEY> AND status = "In Progress"'
            multiline
            testID="jira-search-jql"
          />
          {suggestions.length > 0 ? (
            <View style={jiraStyles.rowWrap} testID="jira-jql-suggestions">
              {suggestions.map((suggestion) => (
                <SuggestionChip
                  key={suggestion.value}
                  suggestion={suggestion}
                  onPick={pickSuggestion}
                />
              ))}
            </View>
          ) : null}
        </View>
      )}
      <View style={jiraStyles.row}>
        <Button
          variant="default"
          loading={results.kind === "loading"}
          onPress={search}
          testID="jira-search-run"
        >
          Search
        </Button>
      </View>
      {results.kind === "error" ? <ErrorBanner message={results.message} /> : null}
      {results.kind === "ready" ? (
        <ResultsView
          serverId={serverId}
          connectionId={connectionId}
          results={results}
          onOpenIssue={onOpenIssue}
          onMore={more}
        />
      ) : null}
    </ScrollView>
  );
}
