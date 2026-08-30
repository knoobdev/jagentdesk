import { beforeEach, describe, expect, it } from "vitest";
import { useClusterNavStore } from "./cluster-nav-store";

describe("useClusterNavStore.clearLastCluster", () => {
  beforeEach(() => {
    useClusterNavStore.setState({ lastCluster: null });
  });

  it("forgets the remembered cluster when the disconnected one matches", () => {
    const { setLastCluster, clearLastCluster } = useClusterNavStore.getState();
    setLastCluster("srv_a", "clu_1");
    expect(useClusterNavStore.getState().lastCluster).toEqual({
      serverId: "srv_a",
      clusterId: "clu_1",
    });

    clearLastCluster("clu_1");
    expect(useClusterNavStore.getState().lastCluster).toBeNull();
  });

  it("keeps the remembered cluster when a different cluster is disconnected", () => {
    const { setLastCluster, clearLastCluster } = useClusterNavStore.getState();
    setLastCluster("srv_a", "clu_1");

    clearLastCluster("clu_2");
    expect(useClusterNavStore.getState().lastCluster).toEqual({
      serverId: "srv_a",
      clusterId: "clu_1",
    });
  });

  it("is a no-op when nothing is remembered", () => {
    const { clearLastCluster } = useClusterNavStore.getState();
    clearLastCluster("clu_1");
    expect(useClusterNavStore.getState().lastCluster).toBeNull();
  });
});
