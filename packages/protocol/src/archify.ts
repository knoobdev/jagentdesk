import { z } from "zod";

// Renderers bundled with the daemon.
export const ArchifyDiagramTypeSchema = z.enum(["lifecycle", "tree"]);
export type ArchifyDiagramType = z.infer<typeof ArchifyDiagramTypeSchema>;
