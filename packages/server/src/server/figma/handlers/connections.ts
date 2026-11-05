import type { FigmaContext } from "../context.js";
import { FigmaServiceError } from "../context.js";
import { figmaSecretKeys, FigmaOAuth } from "../oauth.js";
import type { FigmaHandlerMap, FigmaSessionInfo } from "./types.js";

// Connections + OAuth (32.2). Owner: work package W2.

export type ConnectionsRequestType =
  | "figma.connections.list.request"
  | "figma.connections.remove.request"
  | "figma.connections.test.request"
  | "figma.oauth.begin.request"
  | "figma.oauth.complete.request"
  | "figma.oauth.delegate.request";

// The token manager is created in `create.ts` and reaches handlers through ctx.tokens.
// While the placeholder is in place, sign-in actions answer `unsupported` like the other
// unbuilt parts (unavailable.ts), and reads that only need the store still work.
function tokenProvider(ctx: FigmaContext, session?: FigmaSessionInfo): FigmaOAuth {
  if (ctx.tokens instanceof FigmaOAuth) {
    ctx.tokens.attach(ctx);
    if (session) ctx.tokens.trackSession(session);
    return ctx.tokens;
  }
  throw new FigmaServiceError("unsupported", "Figma sign-in is not available yet");
}

export const connectionsHandlers: FigmaHandlerMap<ConnectionsRequestType> = {
  "figma.connections.list.request": async (_request, ctx, session) => {
    // Reads work without the token manager, but a session that talks to the service is
    // remembered as a potential loopback host for the desktop delegation.
    if (ctx.tokens instanceof FigmaOAuth && session) {
      ctx.tokens.attach(ctx);
      ctx.tokens.trackSession(session);
    }
    const connections = await ctx.store.listConnections();
    return { connections };
  },

  "figma.connections.remove.request": async (request, ctx) => {
    const existing = await ctx.store.getConnection(request.connectionId);
    if (!existing) {
      throw new FigmaServiceError("not_found", "No such Figma connection.");
    }
    await ctx.store.removeConnection(request.connectionId);
    for (const key of figmaSecretKeys(request.connectionId)) {
      await ctx.secrets.delete(key);
    }
    if (ctx.tokens instanceof FigmaOAuth) ctx.tokens.forgetCache(request.connectionId);
    return {};
  },

  "figma.connections.test.request": async (request, ctx, session) => {
    const connection = await tokenProvider(ctx, session).testConnection(ctx, request.connectionId);
    return { connection };
  },

  "figma.oauth.begin.request": async (request, ctx, session) =>
    tokenProvider(ctx, session).begin(ctx, {
      clientId: request.clientId,
      clientSecret: request.clientSecret,
      redirect: request.redirect,
    }),

  "figma.oauth.complete.request": async (request, ctx, session) => {
    const connection = await tokenProvider(ctx, session).complete(ctx, {
      attemptId: request.attemptId,
      code: request.code,
      state: request.state,
      pastedUrl: request.pastedUrl,
    });
    return { connection };
  },

  "figma.oauth.delegate.request": async (request, ctx, session) =>
    tokenProvider(ctx, session).delegate(
      ctx,
      { clientId: request.clientId, clientSecret: request.clientSecret },
      session,
    ),
};
