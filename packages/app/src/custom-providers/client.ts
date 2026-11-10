import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  ApiProviderRecord,
  EnvProviderSummary,
  ProviderTestResult,
  SaveApiProviderInput,
  TestApiProviderInput,
} from "./types";

// COMPAT(customProvidersClient): typed locally until C10 lands the
// customProvidersList/Save/Delete/Test methods on DaemonClient; remove this
// interface and the adapter once the client package exports them.
export interface CustomProvidersClient {
  customProvidersList(): Promise<{
    providers: ApiProviderRecord[];
    envProviders: EnvProviderSummary[];
  }>;
  customProvidersSave(input: SaveApiProviderInput): Promise<{ provider: ApiProviderRecord }>;
  customProvidersDelete(input: { id: string }): Promise<void>;
  customProvidersTest(input: TestApiProviderInput): Promise<ProviderTestResult>;
}

export function createCustomProvidersClient(daemon: DaemonClient): CustomProvidersClient {
  const withMethods = daemon as DaemonClient & CustomProvidersClient;
  return {
    customProvidersList: () => withMethods.customProvidersList(),
    customProvidersSave: (input) => withMethods.customProvidersSave(input),
    customProvidersDelete: (input) => withMethods.customProvidersDelete(input),
    customProvidersTest: (input) => withMethods.customProvidersTest(input),
  };
}
