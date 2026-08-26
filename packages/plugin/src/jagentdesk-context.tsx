import type { JAgentDeskApi } from "@jagentdesk/client";
import { createContext, useContext, type ReactNode } from "react";

const JAgentDeskApiContext = createContext<JAgentDeskApi | null>(null);

export function JAgentDeskApiProvider({
  children,
  jagentdesk,
}: {
  children: ReactNode;
  jagentdesk: JAgentDeskApi;
}) {
  return (
    <JAgentDeskApiContext.Provider value={jagentdesk}>{children}</JAgentDeskApiContext.Provider>
  );
}

export function useJAgentDesk(): JAgentDeskApi {
  const jagentdesk = useContext(JAgentDeskApiContext);
  if (!jagentdesk) throw new Error("useJAgentDesk must run inside a contributed plugin surface");
  return jagentdesk;
}
