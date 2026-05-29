export const PREVIEW_UNAVAILABLE_MSG =
  'Preview is unavailable right now. Please try again before applying this change.';

export function isManualBlockReason(reason: string | null): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r.includes('applytype is') && r.includes('manual');
}

export function blockReasonLabel(reason: string | null): string {
  if (!reason) return 'This change cannot be applied right now — please try again shortly.';
  const r = reason.toLowerCase();
  if (isManualBlockReason(reason))
    return "This recommendation requires manual setup and can't be previewed automatically.";
  if (r.includes('open_measurement') || r.includes('measurement window'))
    return 'A change is already being measured on this product. You can apply another change after the current test finishes.';
  if (r.includes('trust_mismatch') || r.includes('refund'))
    return 'Paused — this product has an elevated return rate. Apply once refunds stabilize.';
  if (r.includes('not_approved') || r.includes('review'))
    return 'This fix is still pending review before it can be applied.';
  if (r.includes('already_applied') || r.includes('already applied'))
    return 'This improvement is already live on your store.';
  return reason;
}

export function proposedContentLabel(patchMode: string | null): string {
  return patchMode === 'replace_full_body'
    ? 'New version that will appear on your product page'
    : 'What will be added to your product page';
}
