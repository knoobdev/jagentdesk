import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import {
  createRemoteJobCardController,
  type RemoteJobCardViewModel,
} from "./remote-job-card-controller";

export type { RemoteJobCardViewModel } from "./remote-job-card-controller";

export interface UseRemoteJobCardInput {
  client: DaemonClient | null;
  jobId: string;
  /** Tool result seed (spec 33.7); empty while the call was still pending. */
  initialJob: RemoteJob | null;
  initialOutput: string;
  initialOutputOffset: number;
}

/**
 * Mounts one `createRemoteJobCardController` per card instance. The controller captures the
 * client at mount — the session's client object is long-lived, so reconnects are handled
 * inside it (reads retry on the next `remote_exec.job_updated` push).
 */
export function useRemoteJobCard(input: UseRemoteJobCardInput): RemoteJobCardViewModel & {
  stop: () => void;
} {
  const [controller] = useState(() =>
    createRemoteJobCardController({
      client: input.client,
      jobId: input.jobId,
      initialJob: input.initialJob,
      initialOutput: input.initialOutput,
      initialOutputOffset: input.initialOutputOffset,
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  useEffect(() => () => controller.close(), [controller]);
  return { ...state, stop: controller.stop };
}
