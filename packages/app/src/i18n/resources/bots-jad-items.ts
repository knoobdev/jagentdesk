// JAgentDesk-only bots strings for the items surfaces (spec 37), under `bots.jad.items`.
export const botsJadItemsStrings = {
  // Spec 37.3.7: the row and the item header while the three reviews have not passed.
  waitingForReview: "Waiting for review",
  // Spec 37.3.7 step 3: the owner's way past the reviews.
  markDoneAnyway: "Mark done anyway",
  // The Snooze until dialog's day field (Orca's picker draws a calendar).
  snoozeDate: "Date",
  snoozeRange: "Pick a time within the next 366 days.",
} as const;
