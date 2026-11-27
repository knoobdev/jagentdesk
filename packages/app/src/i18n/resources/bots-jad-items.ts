// JAgentDesk-only bots strings for the items surfaces (spec 37), under `bots.jad.items`.
export const botsJadItemsStrings = {
  // Orca dfdb4fda en.json `components.native-chat.question.skip`: a Needs you question's Skip.
  skipQuestion: "Skip",
  // Spec 37.3.7: the row and the item header while the three reviews have not passed.
  waitingForReview: "Waiting for review",
  // Spec 37.3.7 step 3: the owner's way past the reviews.
  markDoneAnyway: "Mark done anyway",
  // The Snooze until dialog's day field (Orca's picker draws a calendar).
  snoozeDate: "Date",
  snoozeRange: "Pick a time within the next 366 days.",
  // Spec 37.4.2: a folded run of the bot's changes to one item, after its last change.
  noteRunChanges_one: "· {{count}} change",
  noteRunChanges_other: "· {{count}} changes",
  activity: {
    // A link whose worker or automation is gone and has no name: Orca leaves the name out.
    linkedUnnamed: "linked something to this item",
  },
} as const;
