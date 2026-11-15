import { useEffect, useState } from "react";
import {
  openCustomProviderForm,
  type CustomProviderFormModel,
  type CustomProviderFormSnapshot,
} from "./custom-provider-form-model";

/** Model lifetime adapter: constructed once per mount, destroyed on unmount. */
export function useCustomProviderFormModel(
  snapshot: CustomProviderFormSnapshot,
): CustomProviderFormModel {
  const [model] = useState(() => openCustomProviderForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applySshServers(snapshot.sshServers);
  }, [model, snapshot.sshServers]);

  return model;
}
