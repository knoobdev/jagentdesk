import { describe, expect, it } from "vitest";
import { clusterChatTitle, shortClusterName } from "./cluster-chat-title";

describe("shortClusterName", () => {
  it("takes the last underscore segment of a gke context name", () => {
    expect(shortClusterName("gke_musashino-rag_asia-northeast1-a_mrag-live")).toBe("mrag-live");
  });
  it("returns a plain name unchanged", () => {
    expect(shortClusterName("docker-desktop")).toBe("docker-desktop");
  });
  it("falls back for an empty name", () => {
    expect(shortClusterName("   ")).toBe("cluster");
  });
});

describe("clusterChatTitle", () => {
  it("prefixes the cluster and uses the first message line", () => {
    expect(clusterChatTitle("gke_p_r_mrag-live", "why is a pod crash-looping?\nmore details")).toBe(
      "mrag-live: why is a pod crash-looping?",
    );
  });

  it("collapses whitespace and skips leading blank lines", () => {
    expect(clusterChatTitle("staging", "\n\n   scale   up   the   deployment ")).toBe(
      "staging: scale up the deployment",
    );
  });

  it("returns undefined for an empty message so the daemon can title it", () => {
    expect(clusterChatTitle("mrag-live", "   \n  ")).toBeUndefined();
  });

  it("keeps the same question distinguishable across clusters", () => {
    const q = "list all failing pods";
    expect(clusterChatTitle("prod", q)).not.toBe(clusterChatTitle("staging", q));
  });
});
