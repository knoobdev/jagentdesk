import { BuiltinServerRegistry } from "./host.js";
import { loadBuiltins } from "./load.generated.js";
export const builtinServerRegistry = new BuiltinServerRegistry();
loadBuiltins(builtinServerRegistry);
