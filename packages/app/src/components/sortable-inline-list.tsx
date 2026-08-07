// This file exists for TypeScript resolution.
// The actual implementations are in:
// - sortable-inline-list.native.tsx (iOS/Android)
// - sortable-inline-list.web.tsx (Web)
// Metro's platform-specific extensions will pick the right one at runtime.

export * from "./sortable-inline-list.native";
