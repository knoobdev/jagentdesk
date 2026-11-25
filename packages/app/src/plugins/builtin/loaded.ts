import { BuiltinClientRegistry } from "./host";
import { loadBuiltins } from "./load.generated";
export const builtinClientRegistry = new BuiltinClientRegistry();
loadBuiltins(builtinClientRegistry);
