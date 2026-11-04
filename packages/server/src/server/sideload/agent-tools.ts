import { z } from "zod";
import { SideloadOptionsSchema } from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { JAgentDeskToolDefinition, JAgentDeskToolResult } from "../agent/tools/types.js";
import { toSideloadError } from "./errors.js";
import type { SideloadService } from "./sideload-service.js";

/**
 * Agent tools of 26.10. Listing runs on its own; installing raises the permission card
 * (04.21) first and installs nothing when it is denied. No tool takes or returns a
 * password, token, certificate or 2FA code. Device listing is `device_list` of spec 27.
 */

export interface SideloadAgentTool extends JAgentDeskToolDefinition {
  requiresPermission: boolean;
}

export type RequestSideloadPermission = (
  agentId: string,
  request: {
    name: string;
    kind: "tool";
    title: string;
    description: string;
    input: Record<string, unknown>;
  },
) => Promise<AgentPermissionResponse>;

function json(value: unknown): JAgentDeskToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failed(message: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const InstallInput = z.object({
  deviceId: z.string().min(1).describe("iOS device UDID"),
  path: z.string().min(1).describe("Absolute path of the .ipa on the daemon host"),
  accountId: z
    .string()
    .optional()
    .describe("Sideload account id (apl_…); defaults to the only account"),
  options: SideloadOptionsSchema.optional(),
});

const AndroidInput = z.object({
  deviceId: z.string().min(1).describe("adb serial of the Android device"),
  path: z.string().min(1).describe("Absolute path of the .apk / .apks on the daemon host"),
});

/** The slice of SideloadService the tools use. */
export type SideloadToolService = Pick<
  SideloadService,
  "listAccounts" | "listApps" | "signAndInstall" | "androidInstall"
>;

export function createSideloadAgentTools(input: {
  service: SideloadToolService;
  callerAgentId: string | null;
  requestPermission: RequestSideloadPermission;
}): SideloadAgentTool[] {
  const { service, callerAgentId, requestPermission } = input;

  async function approve(
    name: string,
    title: string,
    description: string,
    args: Record<string, unknown>,
  ) {
    if (!callerAgentId) return false;
    const decision = await requestPermission(callerAgentId, {
      name,
      kind: "tool",
      title,
      description,
      input: args,
    });
    return decision.behavior === "allow";
  }

  return [
    {
      name: "sideload_list_accounts",
      title: "Sideload accounts",
      description: "List the Apple accounts sideload can sign with (no secrets).",
      requiresPermission: false,
      inputSchema: {},
      handler: async () =>
        json(
          (await service.listAccounts()).map((account) => ({
            id: account.id,
            appleId: account.appleId,
            kind: account.kind,
            teamId: account.teamId,
            signedIn: account.signedIn,
            appIdsUsed: account.appIdsUsed,
            appIdsLimit: account.appIdsLimit,
          })),
        ),
    },
    {
      name: "sideload_list_apps",
      title: "Sideloaded apps",
      description: "List apps sideloaded to physical iOS devices, with expiry and auto refresh.",
      requiresPermission: false,
      inputSchema: {},
      handler: async () => json(service.listApps()),
    },
    {
      name: "sideload_install",
      title: "Sideload an IPA",
      description:
        "Sign an .ipa with a sideload Apple account and install it on a physical iPhone/iPad. Asks the user first.",
      requiresPermission: true,
      inputSchema: InstallInput.shape,
      handler: async (raw) => {
        const args = InstallInput.parse(raw);
        const accounts = await service.listAccounts();
        const accountId = args.accountId ?? (accounts.length === 1 ? accounts[0]!.id : null);
        if (!accountId) return failed("Pass accountId: there is not exactly one sideload account.");
        const allowed = await approve(
          "sideload_install",
          `Install ${args.path.split(/[\\/]/).pop()} on ${args.deviceId}`,
          `Sign with ${accounts.find((account) => account.id === accountId)?.appleId ?? accountId} and install on the device.`,
          { deviceId: args.deviceId, path: args.path, accountId },
        );
        if (!allowed) return failed("denied: the user did not allow this install.");
        try {
          return json(
            await service.signAndInstall({
              accountId,
              deviceUdid: args.deviceId,
              ipaPath: args.path,
              options: args.options,
            }),
          );
        } catch (error) {
          const failure = toSideloadError(error);
          return failed(`${failure.code}: ${failure.message}`);
        }
      },
    },
    {
      name: "android_install",
      title: "Install an APK",
      description: "Install an .apk or .apks on an Android device over adb. Asks the user first.",
      requiresPermission: true,
      inputSchema: AndroidInput.shape,
      handler: async (raw) => {
        const args = AndroidInput.parse(raw);
        const allowed = await approve(
          "android_install",
          `Install ${args.path.split(/[\\/]/).pop()} on ${args.deviceId}`,
          `adb install on ${args.deviceId}`,
          { deviceId: args.deviceId, path: args.path },
        );
        if (!allowed) return failed("denied: the user did not allow this install.");
        try {
          return json({ output: await service.androidInstall(args.deviceId, [args.path]) });
        } catch (error) {
          const failure = toSideloadError(error);
          return failed(`${failure.code}: ${failure.message}`);
        }
      },
    },
  ];
}
