import type { RpcInput } from "@jagentdesk/plugin";
import { incrementRpc } from "../shared/increment";

export function increment(input: RpcInput<typeof incrementRpc>) {
  return {
    value: input.value + 1,
    handledBy: "plugin subprocess",
  };
}
