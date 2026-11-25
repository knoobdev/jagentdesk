import { z } from "zod";
import {
  ensureValidJson,
  type BuiltinToolContext,
  type JAgentDeskToolResult,
  type RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { slugifySkillName } from "./frontmatter.js";
import type { NativeSkillsService } from "./service.js";

export function registerSkillsTools(
  registerTool: RegisterBuiltinTool,
  skillsStorage: Pick<NativeSkillsService, "author" | "getSkill"> | undefined,
  context: BuiltinToolContext | undefined,
): void {
  // Skills are standard Agent Skills directories (<name>/SKILL.md) installed natively
  // for every provider (spec 22 / ADR-0022): one real copy in .agents/skills plus
  // symlinks into .claude/skills and .kiro/skills, recorded in the skills lock.
  const resolveCwd = (scope: "global" | "project", cwd: string | undefined) => {
    if (scope === "global") return undefined;
    if (cwd) return cwd;
    return context?.callerAgentId
      ? (context.agentManager.getAgent(context.callerAgentId)?.cwd ?? undefined)
      : undefined;
  };
  const skillError = (error: unknown): JAgentDeskToolResult => ({
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  });

  registerTool(
    "create_skill",
    {
      title: "Create skill",
      description:
        "Create a new skill as a standard Agent Skills directory (<name>/SKILL.md) that every coding agent provider loads natively (Claude, Codex, OpenCode, Cursor, Copilot, Pi, OMP, Kimi, Kiro). Use THIS tool when the user asks you to create/make a skill: it installs the real copy in ~/.agents/skills (or <project>/.agents/skills), symlinks it into .claude/skills and .kiro/skills, records it in the JAgentDesk skills lock and shows it in the Skills screen on every device. Never overwrites an existing skill directory. Auto-approved.",
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1, "name is required")
          .max(64, "name must be 64 characters or fewer")
          .describe(
            "Skill name: lowercase letters, digits and hyphens (e.g. pr-reviewer). Other text is converted to that form.",
          ),
        instructions: z
          .string()
          .trim()
          .min(1, "instructions are required")
          .describe("SKILL.md body (markdown): what the skill does and how to apply it."),
        description: z
          .string()
          .trim()
          .max(1024)
          .optional()
          .describe(
            "When the skill should be used (the provider shows this to the model). Defaults to the first line of the instructions.",
          ),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("global (default): the user's home. project: the current workspace."),
        cwd: z
          .string()
          .optional()
          .describe("Workspace directory for scope=project. Defaults to your working directory."),
      },
      outputSchema: {
        id: z.string(),
        name: z.string(),
        path: z.string(),
      },
    },
    async (input: {
      name: string;
      instructions: string;
      description?: string;
      scope?: "global" | "project";
      cwd?: string;
    }) => {
      if (!skillsStorage) {
        return {
          content: [{ type: "text", text: "Skills storage is not configured" }],
          isError: true,
        };
      }
      const scope = input.scope ?? "global";
      const name = slugifySkillName(input.name);
      const description =
        input.description?.trim() ||
        input.instructions
          .split("\n")
          .map((line) => line.replace(/^#+\s*/, "").trim())
          .find(Boolean) ||
        name;
      try {
        const skill = await skillsStorage.author({
          name,
          description,
          body: input.instructions,
          scope,
          cwd: resolveCwd(scope, input.cwd),
        });
        return {
          content: [
            {
              type: "text",
              text: `Created skill "${skill.name}" (${skill.skillId}) at ${skill.realPath}`,
            },
          ],
          structuredContent: ensureValidJson({
            id: skill.skillId,
            name: skill.name,
            path: skill.realPath,
          }),
        };
      } catch (error) {
        return skillError(error);
      }
    },
  );

  registerTool(
    "update_skill",
    {
      title: "Update skill",
      description:
        "Update the description and/or instructions (SKILL.md body) of a skill JAgentDesk owns, by id (the id returned by create_skill or shown in the Skills screen). Learned lessons are kept. Renaming is not supported. Auto-approved.",
      inputSchema: {
        id: z.string().min(1).describe("Skill id to update."),
        instructions: z.string().trim().min(1).optional(),
        description: z.string().trim().max(1024).optional(),
        cwd: z
          .string()
          .optional()
          .describe("Workspace directory, needed only for a project skill."),
      },
      outputSchema: {
        id: z.string(),
        name: z.string(),
      },
    },
    async (input: { id: string; instructions?: string; description?: string; cwd?: string }) => {
      if (!skillsStorage) {
        return {
          content: [{ type: "text", text: "Skills storage is not configured" }],
          isError: true,
        };
      }
      try {
        const current = await skillsStorage.getSkill(input.id, input.cwd);
        const skill = await skillsStorage.author({
          skillId: current.skill.skillId,
          name: current.skill.name,
          description: input.description ?? current.skill.description,
          body: input.instructions ?? current.body,
          scope: current.skill.scope,
          cwd: current.skill.projectRoot ?? undefined,
        });
        return {
          content: [{ type: "text", text: `Updated skill "${skill.name}" (${skill.skillId})` }],
          structuredContent: ensureValidJson({ id: skill.skillId, name: skill.name }),
        };
      } catch (error) {
        return skillError(error);
      }
    },
  );
}
