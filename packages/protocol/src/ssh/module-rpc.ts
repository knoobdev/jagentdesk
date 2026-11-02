import { z } from "zod";

// Shared request/response shape for the SSH feature modules (spec 25, milestones S2–S8).
// Same envelope as ssh/rpc-schemas.ts — `{ type, requestId, ...params }` in,
// `{ type, payload: { requestId, error, ...data } }` out — except that `error` is structured:
// the UI branches on `code` (`port_in_use`, `docker_socket_denied`, …) and shows `message`.

export const SshModuleErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type SshModuleError = z.infer<typeof SshModuleErrorSchema>;

export function sshModuleRequest<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}

export function sshModuleResponse<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({
      requestId: z.string(),
      error: SshModuleErrorSchema.nullable(),
      ...extra,
    }),
  });
}
