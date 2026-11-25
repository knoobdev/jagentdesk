import { vi } from "vitest";

// SDK 57 installs Metro-only import.meta/async-require globals here; Vite owns module loading.
vi.mock("expo/src/winter", () => ({}));
