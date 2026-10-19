const DRAFT_LAUNCH_MODES = new Set(["manual", "auto", "immediate"]);
const CAMPAIGN_LAUNCH_MODES = new Set(["manual", "auto", "test"]);

export function normalizeDraftLaunchMode(mode) {
  return DRAFT_LAUNCH_MODES.has(mode) ? mode : "auto";
}

export function normalizeCampaignLaunchMode(mode) {
  return CAMPAIGN_LAUNCH_MODES.has(mode) ? mode : null;
}

export function isImmediateDraftQueueItem(item) {
  return item?.mode === "immediate"
    && Boolean(item.outreach_draft_id)
    && !item.campaign_id
    && Number(item.outreach_step_position) === 1;
}
