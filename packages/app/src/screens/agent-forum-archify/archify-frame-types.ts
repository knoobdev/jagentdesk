export interface ArchifyFrameProps {
  // Full document from buildArchifyDocument (CSP + shims + archify HTML).
  document: string;
  // Increment to replay the trace animation inside the frame.
  replayToken: number;
  height: number;
  title: string;
  testID?: string;
}
