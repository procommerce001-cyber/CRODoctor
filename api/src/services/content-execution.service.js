'use strict';

// ---------------------------------------------------------------------------
// content-execution.service.js
//
// Hardened content patch execution scaffold for the Action Center.
//
// Contract:
//   - Supports ONLY content_change issues (applyType === 'content_change')
//   - Never writes to Shopify or touches live theme code
//   - preview=true  → validate + preview, log "previewed" row
//   - preview=false → validate + preview + patch, log "applied" row
//                     (no Shopify write yet — resultContent is computed and stored)
//
// Patch modes (per-issue, never auto-downgraded to a more destructive mode):
//   insert_after_anchor   — inserts the content block after a confirmed anchor
//                           in the existing body. Nothing is removed. Safest.
//   replace_matched_block — replaces a block that was previously applied and
//                           is still present in current content. Surgical.
//   replace_full_body     — used only when description is empty (< 50 text chars).
//                           A full description write. Will not fire on non-trivial
//                           content — failure is surfaced instead.
//
// Idempotency:
//   Applying the same (issueId + variantIndex) to the same product is blocked
//   when the applied content is still present in the current description
//   unchanged. Forces explicit acknowledgment of duplicate apply.
// ---------------------------------------------------------------------------

const { analyzeProduct } = require('./cro/analyzeProduct');
const { toCroProduct }   = require('./cro/formatters');

// ---------------------------------------------------------------------------
// APPLY_TYPE_MAP — mirrors action-center.service.js (single source to be
// extracted later if both modules grow; kept inline to avoid circular dep)
// ---------------------------------------------------------------------------
const APPLY_TYPE_MAP = {
  CONTENT_CHANGE:  'content_change',
  THEME_PATCH:     'theme_change',
  APP_CONFIG:      'manual',
  MERCHANT_ACTION: 'manual',
};

// ---------------------------------------------------------------------------
// PATCH_MODE_REGISTRY
//
// Authoritative per-issue patch strategy. Each entry defines:
//   field         : product field being modified (must exist on rawProduct)
//   preferredModes: ordered list of modes to attempt; first viable mode wins.
//                   NEVER auto-falls back from a surgical mode to a
//                   destructive one without an explicit `replace_full_body`
//                   entry in the list.
//   findAnchor    : fn(html) → AnchorResult for insert_after_anchor mode
//   wrapContent   : fn(text) → HTML string to insert or use as replacement body
//
// AnchorResult: { found: bool, position?: number, anchorText?: string, preview?: string }
// ---------------------------------------------------------------------------
const PATCH_MODE_REGISTRY = {
  weak_desire_creation: {
    field: 'bodyHtml',

    // Try insert first; only use replace_full_body when description is trivially empty.
    preferredModes: ['insert_after_anchor', 'replace_full_body'],

    findAnchor(html) {
      if (!html) return { found: false };

      // ── Primary: after the first </p> that follows ≥20 chars of text ──
      const firstPClose = html.indexOf('</p>');
      if (firstPClose !== -1) {
        const before = html.slice(0, firstPClose);
        const text   = before.replace(/<[^>]*>/g, '').trim();
        if (text.length >= 20) {
          return {
            found:      true,
            position:   firstPClose + 4,  // just after </p>
            anchorText: '</p>',
            preview:    text.slice(-100),
          };
        }
      }

      // ── Secondary: before the first <ul> or <ol> (feature list) ──
      const listMatch = html.match(/<(ul|ol)\b/i);
      if (listMatch) {
        const pos    = html.indexOf(listMatch[0]);
        const before = html.slice(0, pos);
        const text   = before.replace(/<[^>]*>/g, '').trim();
        if (text.length > 0) {
          return {
            found:      true,
            position:   pos,
            anchorText: `<${listMatch[1]}`,
            preview:    text.slice(-100),
          };
        }
      }

      // ── Tertiary: after last <br> / <br /> when no block structure exists ──
      if (!/<(p|ul|ol|h[1-6]|div)\b/i.test(html)) {
        const brMatch = [...html.matchAll(/<br\s*\/?>/gi)];
        if (brMatch.length > 0) {
          const lastBr   = brMatch[brMatch.length - 1];
          const position = lastBr.index + lastBr[0].length;
          const before   = html.slice(0, position);
          const text     = before.replace(/<[^>]*>/g, '').trim();
          if (text.length >= 20) {
            return {
              found:      true,
              position,
              anchorText: lastBr[0],
              preview:    text.slice(-100),
            };
          }
        }
      }

      return { found: false };
    },

    wrapContent(text) {
      return `<p>${text}</p>`;
    },
  },
};

// ---------------------------------------------------------------------------
// stripHtmlText — strip HTML tags and collapse whitespace to plain text
// ---------------------------------------------------------------------------
function stripHtmlText(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// detectPatchMode
//
// Determines the correct patch mode for this apply call.
// Checks for a re-apply case first (replace_matched_block), then walks the
// preferredModes list until one is viable.
//
// Returns PatchPlan:
//   { mode, anchorUsed, anchorPosition, anchorPreview,
//     matchedBlock, matchedBlockPreview, error }
//
// error is set (and mode is null) when no safe mode is available.
// ---------------------------------------------------------------------------
function detectPatchMode(issueId, currentContent, lastAppliedExecution) {
  const reg = PATCH_MODE_REGISTRY[issueId];
  if (!reg) {
    return { mode: null, error: `No patch registry entry for issueId "${issueId}".` };
  }

  // ── Re-apply check: is the previously applied content still present? ──
  // If so, use replace_matched_block for surgical replacement.
  if (lastAppliedExecution && currentContent) {
    const wrapped  = reg.wrapContent(lastAppliedExecution.newContent);
    const rawText  = lastAppliedExecution.newContent;
    const matched  = currentContent.includes(wrapped) ? wrapped
                   : currentContent.includes(rawText)  ? rawText
                   : null;
    if (matched) {
      return {
        mode:                'replace_matched_block',
        anchorUsed:          null,
        anchorPosition:      null,
        anchorPreview:       null,
        matchedBlock:        matched,
        matchedBlockPreview: matched.slice(0, 150),
      };
    }
  }

  // ── Walk preferred modes ──
  for (const mode of reg.preferredModes) {
    if (mode === 'insert_after_anchor') {
      const anchor = reg.findAnchor(currentContent);
      if (anchor.found) {
        return {
          mode:                'insert_after_anchor',
          anchorUsed:          anchor.anchorText,
          anchorPosition:      anchor.position,
          anchorPreview:       anchor.preview,
          matchedBlock:        null,
          matchedBlockPreview: null,
        };
      }
      // Anchor not found; continue to next mode only if it's safe.
      // But do NOT silently proceed if the next mode is destructive and
      // the description is non-trivial.
      const textLength = stripHtmlText(currentContent).length;
      if (textLength >= 50) {
        // Non-trivial description with no detectable anchor → hard fail.
        return {
          mode: null,
          error:
            'insert_after_anchor failed: no anchor found in existing description. ' +
            'Description has content (≥50 text chars) so replace_full_body would be ' +
            'destructive. Manual intervention required — edit the description to add ' +
            'an opening paragraph before the feature list, then re-run.',
        };
      }
      // Description is trivially short; allow fallthrough to replace_full_body.
    }

    if (mode === 'replace_full_body') {
      const textLength = stripHtmlText(currentContent).length;
      if (textLength < 50) {
        return {
          mode:                'replace_full_body',
          anchorUsed:          null,
          anchorPosition:      null,
          anchorPreview:       null,
          matchedBlock:        null,
          matchedBlockPreview: null,
        };
      }
      // Non-trivial content hit replace_full_body without going through a
      // surgical mode. Explicit hard stop — no silent destructive fallback.
      return {
        mode: null,
        error:
          'replace_full_body is not safe: description has content (≥50 text chars) ' +
          'and no surgical patch mode succeeded. Would destroy existing content. ' +
          'Add an opening paragraph to the description to unlock insert_after_anchor.',
      };
    }
  }

  return { mode: null, error: 'No viable patch mode found for this issue.' };
}

// ---------------------------------------------------------------------------
// validatePatch
//
// Per-mode validation. Returns { valid: true } or { valid: false, error }.
// Called after detectPatchMode, before applyPatch.
// ---------------------------------------------------------------------------
function validatePatch(plan, currentContent, proposedContent) {
  if (!plan.mode) {
    return { valid: false, error: plan.error || 'Patch mode could not be determined.' };
  }

  if (!proposedContent || proposedContent.trim().length === 0) {
    return { valid: false, error: 'proposedContent is empty. Cannot apply patch.' };
  }

  // Guard against unsafe HTML in generated content (should never happen since
  // the generator is deterministic prose, but belt-and-suspenders).
  if (/<script|<iframe|javascript:/i.test(proposedContent)) {
    return { valid: false, error: 'proposedContent contains unsafe HTML. Rejected.' };
  }

  if (plan.mode === 'replace_full_body') {
    // Nothing extra — content emptiness already confirmed by detectPatchMode.
    return { valid: true };
  }

  if (plan.mode === 'insert_after_anchor') {
    if (plan.anchorPosition === null || plan.anchorPosition === undefined) {
      return { valid: false, error: 'Anchor position not resolved. Cannot insert.' };
    }
    // Confirm anchor is still at the expected position in live content
    const anchorStillPresent = currentContent
      ? currentContent.includes(plan.anchorUsed)
      : false;
    if (!anchorStillPresent) {
      return {
        valid: false,
        error: `Anchor "${plan.anchorUsed}" no longer found in current content. ` +
               'Content may have changed since preview. Re-preview required.',
      };
    }
    return { valid: true };
  }

  if (plan.mode === 'replace_matched_block') {
    if (!plan.matchedBlock) {
      return { valid: false, error: 'Matched block reference is empty. Cannot replace.' };
    }
    if (!currentContent || !currentContent.includes(plan.matchedBlock)) {
      return {
        valid: false,
        error:
          'Matched block is no longer present in current content. ' +
          'The description may have been edited manually. Re-preview required.',
      };
    }
    return { valid: true };
  }

  return { valid: false, error: `Unknown patch mode: ${plan.mode}` };
}

// ---------------------------------------------------------------------------
// applyPatch
//
// Constructs the full resulting body_html from the patch plan.
// Must only be called after validatePatch returns { valid: true }.
// Returns the new full body string.
// ---------------------------------------------------------------------------
function applyPatch(plan, currentContent, proposedContent, issueId) {
  const reg     = PATCH_MODE_REGISTRY[issueId];
  const wrapped = reg.wrapContent(proposedContent);

  switch (plan.mode) {
    case 'replace_full_body':
      return wrapped;

    case 'insert_after_anchor': {
      const pos = plan.anchorPosition;
      const before = currentContent.slice(0, pos);
      const after  = currentContent.slice(pos);
      return `${before}\n${wrapped}${after}`;
    }

    case 'replace_matched_block':
      return currentContent.replace(plan.matchedBlock, wrapped);

    default:
      throw new Error(`Cannot apply unknown patch mode: ${plan.mode}`);
  }
}

// ---------------------------------------------------------------------------
// assessPatchSafety
//
// Returns { patchSafety, failureRisk } for the preview response.
// ---------------------------------------------------------------------------
function assessPatchSafety(plan, currentTextLength) {
  switch (plan.mode) {
    case 'replace_matched_block':
      return {
        patchSafety: 'high',
        failureRisk: 'Low — exact match confirmed. Only the previously applied block will be replaced in-place.',
      };

    case 'insert_after_anchor':
      return {
        patchSafety: 'high',
        failureRisk: `Low — content will be inserted after confirmed anchor "${plan.anchorUsed}". Nothing is removed.`,
      };

    case 'replace_full_body':
      return {
        patchSafety:  currentTextLength === 0 ? 'medium' : 'low',
        failureRisk:  currentTextLength === 0
          ? 'Low — description is empty. Content block will become the full body.'
          : 'Medium — short existing description will be replaced entirely.',
      };

    default:
      return { patchSafety: 'low', failureRisk: 'Unknown mode — do not apply.' };
  }
}

// ---------------------------------------------------------------------------
// checkIdempotency
//
// Finds the most recent "applied" execution for (storeId, productId, issueId,
// selectedVariantIndex). Blocks re-apply when the applied content is still
// present in the current description unchanged.
//
// Returns:
//   { blocked: false, lastAppliedExecution: null | row }
//   { blocked: true,  reason, lastAppliedAt, lastExecutionId, lastAppliedExecution }
// ---------------------------------------------------------------------------
async function checkIdempotency(prisma, storeId, productId, issueId, selectedVariantIndex, currentContent) {
  const lastApplied = await prisma.contentExecution.findFirst({
    where:   { storeId, productId, issueId, selectedVariantIndex, status: 'applied' },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, newContent: true, createdAt: true },
  });

  if (!lastApplied) return { blocked: false, lastAppliedExecution: null };

  const reg          = PATCH_MODE_REGISTRY[issueId];
  const wrappedPrev  = reg ? reg.wrapContent(lastApplied.newContent) : null;
  const stillPresent = currentContent && (
    (wrappedPrev  && currentContent.includes(wrappedPrev))  ||
    currentContent.includes(lastApplied.newContent)
  );

  if (stillPresent) {
    return {
      blocked:              true,
      reason:               `This fix (issueId="${issueId}", variantIndex=${selectedVariantIndex}) was already applied and its content is still present in the product description unchanged. Re-apply would be a no-op. To apply a different variant, change selectedVariantIndex. To force a re-apply after manual edits, the content must differ from what was last applied.`,
      lastAppliedAt:        lastApplied.createdAt,
      lastExecutionId:      lastApplied.id,
      lastAppliedExecution: lastApplied,
    };
  }

  return { blocked: false, lastAppliedExecution: lastApplied };
}

// ---------------------------------------------------------------------------
// resolveProposedContent
// ---------------------------------------------------------------------------
function resolveProposedContent(generatedFix, selectedVariantIndex) {
  if (!generatedFix) return null;
  const idx = typeof selectedVariantIndex === 'number' ? selectedVariantIndex : 0;
  if (idx === 0) return generatedFix.bestGuess?.content ?? null;
  return generatedFix.variants?.[idx]?.content ?? null;
}

// ---------------------------------------------------------------------------
// loadRawProduct — shared product loader with variant + image includes
// ---------------------------------------------------------------------------
async function loadRawProduct(prisma, productId, storeId) {
  return prisma.product.findFirst({
    where: { id: productId, storeId },
    include: {
      variants: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, shopifyVariantId: true, title: true, sku: true,
          price: true, compareAtPrice: true, inventoryQuantity: true, availableForSale: true,
        },
      },
      images: {
        orderBy: { position: 'asc' },
        select: { id: true, src: true, altText: true, position: true },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// resolveActionItem
// Re-runs the CRO engine, finds the issue, builds the minimal gating shape
// with reviewStatus merged from the DB.
// ---------------------------------------------------------------------------
async function resolveActionItem(prisma, storeId, productId, issueId, rawProduct) {
  const croProduct = toCroProduct(rawProduct);
  const analysis   = analyzeProduct(croProduct);

  const allIssues = [
    ...analysis.criticalBlockers,
    ...analysis.revenueOpportunities,
    ...analysis.quickWins,
  ];

  const issue = allIssues.find(i => i.issueId === issueId);
  if (!issue) return null;

  const applyType    = APPLY_TYPE_MAP[issue.implementationType] || 'manual';
  const canAutoApply = applyType === 'content_change' && !!(issue.generatedFix?.bestGuess?.content);

  const dbRecord = await prisma.actionItem.findUnique({
    where:  { storeId_productId_issueId: { storeId, productId, issueId } },
    select: { reviewStatus: true },
  });

  return {
    issueId,
    applyType,
    canAutoApply,
    reviewStatus: dbRecord?.reviewStatus ?? 'pending',
    generatedFix: issue.generatedFix ?? null,
  };
}

// ---------------------------------------------------------------------------
// gate — approval + capability checks (unchanged from v1)
// ---------------------------------------------------------------------------
function gate(actionItem) {
  if (!actionItem) {
    return { eligible: false, reason: 'Issue not found on this product.' };
  }
  if (actionItem.applyType !== 'content_change') {
    return {
      eligible: false,
      reason: `applyType is "${actionItem.applyType}". Only content_change issues are supported by this endpoint.`,
    };
  }
  if (!actionItem.canAutoApply) {
    return {
      eligible: false,
      reason: 'canAutoApply is false. This issue does not have a generated fix ready for execution.',
    };
  }
  if (actionItem.reviewStatus !== 'approved') {
    return {
      eligible: false,
      reason: `reviewStatus is "${actionItem.reviewStatus}". Issue must be approved before it can be applied.`,
    };
  }
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// previewContentExecution
//
// Main entry point for POST /products/:id/apply.
//
// Flow:
//   1.  Load raw product
//   2.  Re-run CRO engine → resolve action item + gate check
//   3.  Resolve proposed content from generatedFix variant
//   4.  Idempotency check (blocks duplicate no-op applies)
//   5.  Detect patch mode (insert_after_anchor → replace_full_body; never
//       silently degrades to destructive mode on non-trivial content)
//   6.  Validate patch (per-mode checks against live content)
//   7.  Assess patch safety
//   8.  If preview=false: apply patch in memory, log "applied" row with resultContent
//       If preview=true:  log "previewed" row (no resultContent stored)
//   9.  Return preview object
// ---------------------------------------------------------------------------
async function previewContentExecution(prisma, {
  storeId,
  productId,
  issueId,
  selectedVariantIndex = 0,
  preview = true,
}) {
  // ── 1. Load product ──────────────────────────────────────────────────────
  const rawProduct = await loadRawProduct(prisma, productId, storeId);
  if (!rawProduct) {
    throw Object.assign(new Error('Product not found in this store.'), { statusCode: 404 });
  }

  const currentContent = rawProduct[PATCH_MODE_REGISTRY[issueId]?.field ?? 'bodyHtml'] ?? null;

  // ── 2. Gate ──────────────────────────────────────────────────────────────
  const actionItem          = await resolveActionItem(prisma, storeId, productId, issueId, rawProduct);
  const { eligible, reason } = gate(actionItem);

  if (!eligible) {
    return {
      productId, issueId,
      currentContent, proposedContent: null,
      selectedVariantIndex,
      patchMode: null, anchorUsed: null, matchedBlockPreview: null,
      patchSafety: null, failureRisk: null,
      diffSummary: null,
      eligibleToApply: false,
      blockReason: reason,
    };
  }

  // ── 3. Resolve proposed content ──────────────────────────────────────────
  const proposedContent = resolveProposedContent(actionItem.generatedFix, selectedVariantIndex);
  if (!proposedContent) {
    throw Object.assign(
      new Error(`selectedVariantIndex ${selectedVariantIndex} does not resolve to a valid generatedFix variant.`),
      { statusCode: 400 },
    );
  }

  // ── 4. Idempotency check ─────────────────────────────────────────────────
  const idempotency = await checkIdempotency(
    prisma, storeId, productId, issueId, selectedVariantIndex, currentContent,
  );
  if (idempotency.blocked) {
    return {
      productId, issueId,
      currentContent, proposedContent,
      selectedVariantIndex,
      patchMode: null, anchorUsed: null, matchedBlockPreview: null,
      patchSafety: null, failureRisk: null,
      diffSummary: null,
      eligibleToApply: false,
      blockReason:    idempotency.reason,
      idempotencyBlock: {
        lastAppliedAt:   idempotency.lastAppliedAt,
        lastExecutionId: idempotency.lastExecutionId,
      },
    };
  }

  // ── 5. Detect patch mode ─────────────────────────────────────────────────
  const plan = detectPatchMode(issueId, currentContent, idempotency.lastAppliedExecution);

  if (!plan.mode) {
    return {
      productId, issueId,
      currentContent, proposedContent,
      selectedVariantIndex,
      patchMode: null, anchorUsed: null, matchedBlockPreview: null,
      patchSafety: 'low', failureRisk: plan.error,
      diffSummary: null,
      eligibleToApply: false,
      blockReason: plan.error,
    };
  }

  // ── 6. Validate patch ────────────────────────────────────────────────────
  const validation = validatePatch(plan, currentContent, proposedContent);
  if (!validation.valid) {
    return {
      productId, issueId,
      currentContent, proposedContent,
      selectedVariantIndex,
      patchMode: plan.mode, anchorUsed: plan.anchorUsed,
      matchedBlockPreview: plan.matchedBlockPreview,
      patchSafety: 'low', failureRisk: validation.error,
      diffSummary: null,
      eligibleToApply: false,
      blockReason: validation.error,
    };
  }

  // ── 7. Safety assessment ─────────────────────────────────────────────────
  const currentTextLength      = stripHtmlText(currentContent).length;
  const { patchSafety, failureRisk } = assessPatchSafety(plan, currentTextLength);

  // ── Diff summary ─────────────────────────────────────────────────────────
  const currentWords  = stripHtmlText(currentContent).split(/\s+/).filter(Boolean).length;
  const proposedWords = proposedContent.split(/\s+/).filter(Boolean).length;

  const diffSummary = {
    operation:     plan.mode === 'replace_full_body'     ? 'replace_body'
                 : plan.mode === 'insert_after_anchor'   ? 'insert'
                 : plan.mode === 'replace_matched_block' ? 'replace_block'
                 : 'unknown',
    currentChars:  currentContent ? currentContent.length : 0,
    currentWords,
    proposedChars: proposedContent.length,
    proposedWords,
    note: plan.mode === 'replace_full_body'
      ? 'Full description will be written (was empty or trivially short).'
      : plan.mode === 'insert_after_anchor'
      ? `Desire block will be inserted after anchor "${plan.anchorUsed}". Existing content preserved.`
      : `Previously applied block will be replaced with the new variant in-place.`,
  };

  // ── 8. Log + compute result ───────────────────────────────────────────────
  let resultContent = null;
  if (!preview) {
    resultContent = applyPatch(plan, currentContent, proposedContent, issueId);
  }

  await prisma.contentExecution.create({
    data: {
      storeId,
      productId,
      issueId,
      selectedVariantIndex,
      patchMode:       plan.mode,
      anchorUsed:      plan.anchorUsed ?? null,
      matchedBlock:    plan.matchedBlock ?? null,
      previousContent: preview ? null : currentContent,
      newContent:      proposedContent,
      resultContent:   preview ? null : resultContent,
      status:          preview ? 'previewed' : 'applied',
    },
  });

  // ── 9. Return ─────────────────────────────────────────────────────────────
  return {
    productId,
    issueId,
    currentContent,
    proposedContent,
    selectedVariantIndex,
    patchMode:           plan.mode,
    anchorUsed:          plan.anchorUsed ?? null,
    matchedBlockPreview: plan.matchedBlockPreview ?? null,
    patchSafety,
    failureRisk,
    diffSummary,
    eligibleToApply:     true,
    ...(preview ? {} : { resultContent }),
  };
}

// ---------------------------------------------------------------------------
// previewRollback
//
// Called by POST /products/:id/rollback.
// Finds the most recent "applied" execution for the product+issueId
// (or a specific executionId). Returns a preview of what rollback would
// restore. Preview-only — no Shopify write, no "rolled_back" row logged yet.
//
// The rollback operation is always: replace full bodyHtml with previousContent.
// ---------------------------------------------------------------------------
async function previewRollback(prisma, { storeId, productId, issueId, executionId }) {
  // ── Find the target execution ────────────────────────────────────────────
  const where = executionId
    ? { id: executionId, storeId, productId, issueId, status: 'applied' }
    : { storeId, productId, issueId, status: 'applied' };

  const execution = executionId
    ? await prisma.contentExecution.findFirst({
        where,
        select: {
          id: true, issueId: true, patchMode: true, selectedVariantIndex: true,
          newContent: true, previousContent: true, resultContent: true, createdAt: true,
        },
      })
    : await prisma.contentExecution.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, issueId: true, patchMode: true, selectedVariantIndex: true,
          newContent: true, previousContent: true, resultContent: true, createdAt: true,
        },
      });

  if (!execution) {
    return {
      productId, issueId,
      eligibleToRollback: false,
      blockReason: executionId
        ? `No applied execution found with id "${executionId}" for this product and issueId.`
        : `No applied execution found for issueId "${issueId}" on this product. Nothing to roll back.`,
    };
  }

  if (!execution.previousContent) {
    return {
      productId, issueId,
      executionId: execution.id,
      eligibleToRollback: false,
      blockReason:
        'The target execution does not have a previousContent snapshot. ' +
        'This can happen if the execution was logged in preview mode only. ' +
        'Rollback requires an applied execution with a stored previousContent.',
    };
  }

  // ── Load current content for comparison ──────────────────────────────────
  const rawProduct = await loadRawProduct(prisma, productId, storeId);
  const field          = PATCH_MODE_REGISTRY[issueId]?.field ?? 'bodyHtml';
  const currentContent = rawProduct ? (rawProduct[field] ?? null) : null;

  // ── Diff summary ─────────────────────────────────────────────────────────
  const currentWords  = stripHtmlText(currentContent).split(/\s+/).filter(Boolean).length;
  const rollbackWords = stripHtmlText(execution.previousContent).split(/\s+/).filter(Boolean).length;

  return {
    productId,
    issueId,
    executionId:          execution.id,
    originalPatchMode:    execution.patchMode,
    appliedAt:            execution.createdAt,
    selectedVariantIndex: execution.selectedVariantIndex,
    currentContent,
    rollbackContent:      execution.previousContent,
    patchMode:            'rollback',
    patchSafety:          'high',
    failureRisk:          'Low — restores to known-good previousContent snapshot from the execution log.',
    diffSummary: {
      operation:      'rollback',
      currentChars:   currentContent ? currentContent.length : 0,
      currentWords,
      rollbackChars:  execution.previousContent.length,
      rollbackWords,
      note: 'Full description will be replaced with the snapshot taken before the original apply.',
    },
    eligibleToRollback: true,
  };
}

// ---------------------------------------------------------------------------
// getExecutionHistory
// Returns all ContentExecution rows for a (storeId, productId), newest first.
// ---------------------------------------------------------------------------
async function getExecutionHistory(prisma, storeId, productId) {
  const rows = await prisma.contentExecution.findMany({
    where:   { storeId, productId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, issueId: true, selectedVariantIndex: true,
      patchMode: true, anchorUsed: true,
      status: true, newContent: true, createdAt: true,
    },
  });

  return { productId, storeId, total: rows.length, executions: rows };
}

module.exports = {
  previewContentExecution,
  previewRollback,
  getExecutionHistory,
};
