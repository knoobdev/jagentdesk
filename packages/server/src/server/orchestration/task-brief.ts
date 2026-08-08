import { randomUUID } from "node:crypto";
import {
  OrchestrationConfigSchema,
  OrchestrationRouteCategorySchema,
  OrchestrationTaskBriefSchema,
  type OrchestrationConfig,
  type OrchestrationProfile,
  type OrchestrationRouteCategory,
  type OrchestrationRouteTarget,
  type OrchestrationTaskBrief,
} from "@jagentdesk/protocol/orchestration";

interface ParsedRequest {
  objective: string;
  context?: string;
  constraints: string[];
  acceptedDecisions: string[];
  requestedOutcome: string;
  acceptanceCriteria: string[];
  validationPlan: string[];
  explicitRouteCategory?: OrchestrationRouteCategory;
}

const SECTION_ALIASES: Record<string, keyof ParsedRequest> = {
  objective: "objective",
  goal: "objective",
  context: "context",
  constraints: "constraints",
  constraint: "constraints",
  "accepted decisions": "acceptedDecisions",
  decisions: "acceptedDecisions",
  "requested outcome": "requestedOutcome",
  outcome: "requestedOutcome",
  "acceptance criteria": "acceptanceCriteria",
  acceptance: "acceptanceCriteria",
  validation: "validationPlan",
  "validation plan": "validationPlan",
  route: "explicitRouteCategory",
  category: "explicitRouteCategory",
};

function normalizeLine(value: string): string {
  return value
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();
}

function parseLabeledRequest(rawRequest: string): ParsedRequest {
  const sections = new Map<string, string[]>();
  let current = "objective";
  for (const rawLine of rawRequest.split(/\r?\n/)) {
    const line = normalizeLine(rawLine.trim());
    const heading = line.match(/^(?:#{1,4}\s*)?([^:]+):\s*(.*)$/);
    if (heading) {
      const key = heading[1].trim().toLowerCase();
      const alias = SECTION_ALIASES[key];
      if (alias) {
        current = alias;
        const initial = heading[2].trim();
        if (initial) {
          const currentLines = sections.get(current) ?? [];
          currentLines.push(initial);
          sections.set(current, currentLines);
        }
        continue;
      }
    }
    const currentLines = sections.get(current) ?? [];
    currentLines.push(line);
    sections.set(current, currentLines);
  }

  const objective = (sections.get("objective") ?? []).join(" ").trim();
  const requestedOutcome = (sections.get("requestedOutcome") ?? []).join(" ").trim() || objective;
  const explicitRoute = (sections.get("explicitRouteCategory") ?? []).join(" ").trim();
  const routeCategory = OrchestrationRouteCategorySchema.safeParse(explicitRoute.toLowerCase());

  return {
    objective,
    context: (sections.get("context") ?? []).join(" ").trim() || undefined,
    constraints: sections.get("constraints") ?? [],
    acceptedDecisions: sections.get("acceptedDecisions") ?? [],
    requestedOutcome,
    acceptanceCriteria: sections.get("acceptanceCriteria") ?? [],
    validationPlan: sections.get("validationPlan") ?? [],
    ...(routeCategory.success ? { explicitRouteCategory: routeCategory.data } : {}),
  };
}

function inferRouteCategory(rawRequest: string): OrchestrationRouteCategory {
  const input = rawRequest.toLowerCase();
  if (/(audit|review|security review|quality gate|kiểm tra chất lượng|review lại)/.test(input)) {
    return "audit";
  }
  if (/(ui|ux|screen|layout|component|giao diện|màn hình|thiết kế)/.test(input)) {
    return "ui";
  }
  if (/(search|find|grep|locate|tìm kiếm|tìm hiểu|investigate|điều tra)/.test(input)) {
    return /(research|nghiên cứu|compare|so sánh|đánh giá|investigate|điều tra)/.test(input)
      ? "research"
      : "search";
  }
  if (/(architecture|protocol|security|migration|cross-cutting|kiến trúc|bảo mật)/.test(input)) {
    return "impl_deep";
  }
  if (/(plan|planning|design|kế hoạch|phân tích|thiết kế giải pháp)/.test(input)) {
    return "planning";
  }
  return "impl";
}

function findProfile(
  config: OrchestrationConfig,
  target: OrchestrationRouteTarget,
): OrchestrationProfile {
  const roleConfig = config.roles[target.role];
  const profile = roleConfig.profiles.find((candidate) => candidate.id === target.profileId);
  if (!profile) {
    throw new Error(
      `Orchestration route references missing ${target.role} profile "${target.profileId}"`,
    );
  }
  if (!profile.enabled || !roleConfig.enabled) {
    throw new Error(`Orchestration profile "${target.profileId}" is disabled`);
  }
  return profile;
}

export function resolveConfiguredRouteCandidates(
  config: OrchestrationConfig,
  category: OrchestrationRouteCategory,
): Array<{ target: OrchestrationRouteTarget; profile: OrchestrationProfile }> {
  const route = config.routes[category];
  const candidates = [route.primary, ...route.fallbacks];
  const errors: string[] = [];
  const usable: Array<{ target: OrchestrationRouteTarget; profile: OrchestrationProfile }> = [];
  for (const candidate of candidates) {
    try {
      const profile = findProfile(config, candidate);
      if (route.guardProviderPrefix && !profile.provider.startsWith(route.guardProviderPrefix)) {
        errors.push(`${candidate.profileId}: provider guard rejected ${profile.provider}`);
        continue;
      }
      usable.push({ target: candidate, profile });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (usable.length === 0) {
    throw new Error(`No usable orchestration route for ${category}: ${errors.join("; ")}`);
  }
  return usable;
}

function resolveRoute(
  config: OrchestrationConfig,
  category: OrchestrationRouteCategory,
): { target: OrchestrationRouteTarget; profile: OrchestrationProfile } {
  return resolveConfiguredRouteCandidates(config, category)[0];
}

function buildNormalizedPrompt(
  parsed: ParsedRequest,
  category: OrchestrationRouteCategory,
  route: { target: OrchestrationRouteTarget; profile: OrchestrationProfile },
): string {
  const list = (items: string[], fallback: string): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
  return [
    "You are the JAgentDesk Supervisor receiving a bounded engineering objective.",
    "Respect the Supervisor–Lead–Peer authority boundaries and return evidence for every claim.",
    "",
    `Objective:\n${parsed.objective}`,
    parsed.context ? `Context:\n${parsed.context}` : undefined,
    `Constraints:\n${list(parsed.constraints, "Preserve the existing product contract and avoid mock data.")}`,
    `Accepted decisions:\n${list(parsed.acceptedDecisions, "No additional decisions have been accepted yet.")}`,
    `Requested outcome:\n${parsed.requestedOutcome}`,
    `Acceptance criteria:\n${list(parsed.acceptanceCriteria, "Implement the requested behavior and prove it with targeted validation.")}`,
    `Validation plan:\n${list(parsed.validationPlan, "Run the smallest relevant tests, build, and observable desktop E2E.")}`,
    `Routing category: ${category}`,
    `Selected execution profile: ${route.target.role}/${route.target.profileId} (${route.profile.provider}/${route.profile.model}, thinking ${route.target.thinkingOptionId ?? route.profile.thinkingOptionId})`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function prepareTaskBrief(input: {
  rawRequest: string;
  config: OrchestrationConfig;
  routeCategory?: OrchestrationRouteCategory;
  nowMs?: number;
  id?: string;
}): OrchestrationTaskBrief {
  const rawRequest = input.rawRequest.trim();
  const parsed = parseLabeledRequest(rawRequest);
  const category =
    parsed.explicitRouteCategory ?? input.routeCategory ?? inferRouteCategory(rawRequest);
  const route = resolveRoute(OrchestrationConfigSchema.parse(input.config), category);
  const openQuestions: string[] = [];

  if (rawRequest.length === 0) {
    openQuestions.push("What outcome should the Supervisor deliver?");
  }
  if (parsed.objective.length < 3) {
    openQuestions.push("What is the concrete objective or user-visible behavior to change?");
  }

  const status = openQuestions.length > 0 ? "needs_clarification" : "ready";
  const acceptanceCriteria = parsed.acceptanceCriteria.length
    ? parsed.acceptanceCriteria
    : ["The requested behavior is implemented and verified with targeted tests."];
  const validationPlan = parsed.validationPlan.length
    ? parsed.validationPlan
    : [
        "Run targeted unit/integration tests, build affected packages, and perform observable desktop E2E.",
      ];

  return OrchestrationTaskBriefSchema.parse({
    id: input.id ?? randomUUID(),
    rawRequest,
    objective: parsed.objective || rawRequest || "Unspecified objective",
    ...(parsed.context ? { context: parsed.context } : {}),
    constraints: parsed.constraints,
    acceptedDecisions: parsed.acceptedDecisions,
    requestedOutcome: parsed.requestedOutcome || rawRequest || "Unspecified outcome",
    acceptanceCriteria,
    validationPlan,
    openQuestions,
    routeCategory: category,
    selectedRoute: {
      ...route.target,
      ...(parsed.explicitRouteCategory === undefined && route.target.thinkingOptionId
        ? { thinkingOptionId: route.target.thinkingOptionId }
        : {}),
    },
    normalizedPrompt: buildNormalizedPrompt(
      {
        ...parsed,
        objective: parsed.objective || rawRequest || "Unspecified objective",
        requestedOutcome: parsed.requestedOutcome || rawRequest || "Unspecified outcome",
        acceptanceCriteria,
        validationPlan,
      },
      category,
      route,
    ),
    status,
    createdAtMs: input.nowMs ?? Date.now(),
  });
}
