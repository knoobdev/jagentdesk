/**
 * One SAS exchange per pairing link in this app. The daemon lets only the first
 * `pair_hello` join an attempt, so a second exchange for the same link always
 * fails and can only confuse which screen owns the code.
 */
interface ActiveExchange {
  pk: string;
  controller: AbortController;
}

let active: ActiveExchange | null = null;

/**
 * Returns a release handle, or `null` when an exchange for `pk` is already
 * running. An exchange for a different link is aborted: the user moved on to a
 * newer code.
 */
export function claimPairingExchange(
  pk: string,
  controller: AbortController,
): { release(): void } | null {
  if (active && !active.controller.signal.aborted) {
    if (active.pk === pk) return null;
    active.controller.abort();
  }
  const entry: ActiveExchange = { pk, controller };
  active = entry;
  return {
    release() {
      if (active === entry) active = null;
    },
  };
}
