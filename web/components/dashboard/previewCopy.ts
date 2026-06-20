export const PREVIEW_UNAVAILABLE_MSG =
  'Preview is unavailable right now. Please try again before applying this change.';

// ── Beta-safe merchant-facing copy (UX Phase 1) ──────────────────────────────
// Centralised so Apply/Rollback wording stays consistent across the feed and the
// inspector panel. Copy only — no behaviour is driven from here.
export const PREVIEW_DISCLAIMER =
  "This is a preview. Your store hasn't changed yet.";
export const APPLY_SUCCESS_TITLE = '✓ Live on Shopify.';
export const APPLY_SUCCESS_SUB =
  'This change is now on your product page. You can undo it anytime.';
export const ROLLBACK_SUCCESS = '✓ Reverted. Your previous version is restored.';
export const APPLY_FAILED_MSG =
  "We couldn't apply this change. Your store was not modified. Try again, or contact support if it keeps happening.";
export const ROLLBACK_FAILED_MSG =
  "We couldn't undo this automatically. Your change may still be live. Try again before editing manually.";

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
