import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { RemoteJobCard } from "./remote-job-card";
import {
  readRemoteJobToolResult,
  remoteJobCardVariant,
  type RemoteJobToolResult,
} from "./remote-job-detection";

/** Remote tasks have no destination: their surface is the live job card (spec 33.9). */
export function register(app: BuiltinClientHost) {
  app.toolCallRenderer<RemoteJobToolResult>("remote-job", {
    placements: ["inline", "details"],
    match: readRemoteJobToolResult,
    Card: ({ client, toolName, match, placement }) => (
      <RemoteJobCard
        client={client}
        initialJob={match.job}
        initialOutput={match.output}
        initialOutputOffset={match.outputOffset}
        initialTruncated={match.outputTruncatedHead}
        // The expanded details keep the full card; the chat row compacts remote_job_wait.
        {...(placement === "inline" ? { variant: remoteJobCardVariant(toolName) } : {})}
        testID="remote-job-card"
      />
    ),
  });
}
