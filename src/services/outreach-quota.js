function remaining(limit, used) {
  if (limit === null || limit === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, Number(limit) - Math.max(0, Number(used) || 0));
}

export function quotaRemaining({
  globalLimit,
  globalUsed,
  mailboxLimit = null,
  mailboxUsed = 0,
  campaignLimit = null,
  campaignUsed = 0,
}) {
  return Math.max(0, Math.min(
    remaining(globalLimit, globalUsed),
    remaining(mailboxLimit, mailboxUsed),
    remaining(campaignLimit, campaignUsed),
  ));
}

export function shouldReserveOutreachQuota({ dryRun, mode }) {
  return !dryRun && mode !== "test";
}
