export type StatusLoaderBucket = "needs_input" | "failed" | "running" | "attention" | "done";

export function shouldRenderSyncedStatusLoader(input: {
  bucket: StatusLoaderBucket | null | undefined;
}): boolean {
  return input.bucket === "running";
}
