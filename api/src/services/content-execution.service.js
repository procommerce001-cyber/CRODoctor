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
const { APPLY_TYPE_MAP } = require('./cro/constants');

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
  no_description: {
    field: 'bodyHtml',
    preferredModes: ['replace_full_body'],
    wrapContent(text) {
      return `<p>${text}</p>`;
    },
  },

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

  no_risk_reversal: {
    field: 'bodyHtml',
    // Additive-only. No replace_full_body — adds reassurance, never overwrites description.
    // No anchor found → detectPatchMode returns null → eligibleToApply: false (graceful block).
    preferredModes: ['insert_after_anchor'],

    findAnchor(html) {
      if (!html) return { found: false };

      const L          = html.length;
      const candidates = collectSafeCloses(html); // top-level-safe only
      const lo         = Math.floor(L * 0.40);
      const hi         = Math.floor(L * 0.70);
      const inBand     = c => c.pos >= lo && c.pos <= hi;

      // ── Priority 1: after a COMPLETE top-level list (</ul>/</ol>) ending in
      //    the 40%–70% band — the cleanest break, right after the benefits /
      //    features section. Latest such list wins (most context before it). ──
      const listCloses = candidates.filter(c => (c.tag === '</ul>' || c.tag === '</ol>') && inBand(c));
      if (listCloses.length) {
        return makeAnchor(html, listCloses[listCloses.length - 1], 'high');
      }

      // ── Priority 2: after any complete top-level block in the 40%–70% band —
      //    for descriptions with long paragraphs and no mid list. ──
      const midBlocks = candidates.filter(inBand);
      if (midBlocks.length) {
        return makeAnchor(html, midBlocks[midBlocks.length - 1], 'high');
      }

      // ── Priority 3: first top-level-safe block after 25% — ensures the block
      //    follows the main product explanation even when one long top-level
      //    list spans the middle (no safe anchor lands inside the band). ──
      const after25   = Math.floor(L * 0.25);
      const earlySafe = candidates.find(c => c.pos >= after25);
      if (earlySafe) {
        return makeAnchor(html, earlySafe, 'medium');
      }

      // ── Fallback: after the last top-level-safe closing block (low confidence). ──
      if (candidates.length) {
        return makeAnchor(html, candidates[candidates.length - 1], 'low');
      }

      // ── Final safety net: no top-level-safe anchor anywhere (unusual / nested
      //    markup). Append after the last closing block of any kind so the output
      //    is still valid HTML rather than failing the apply. ──
      let lastPos = -1;
      let lastTag = null;
      for (const tag of STANDALONE_BLOCK_TAGS) {
        const idx = html.lastIndexOf(tag);
        if (idx > lastPos) { lastPos = idx; lastTag = tag; }
      }
      if (lastPos !== -1) {
        const pos = lastPos + lastTag.length;
        return {
          found:      true,
          position:   pos,
          anchorText: lastTag,
          confidence: 'low',
          preview:    html.slice(Math.max(0, lastPos - 80), pos),
        };
      }

      return { found: false };
    },

    // Generator emits full HTML (<p><strong>…</strong></p>\n<ul>…</ul>) — pass through as-is.
    // Wrapping in <p> would create <p><p>…</p></p> which browsers auto-correct to <p></p><p>…
    wrapContent(text) {
      return text;
    },
  },

  no_trust_bullets: {
    field: 'bodyHtml',
    // Additive-only. Places trust bullets near the top of the description so
    // they are visible to the majority of visitors.
    // No anchor found → eligibleToApply: false (graceful block).
    preferredModes: ['insert_after_anchor'],

    findAnchor(html) {
      if (!html) return { found: false };

      // ── Primary: immediately before the first TOP-LEVEL feature list
      //    (<ul>/<ol>), provided ≥50 text chars of context precede it. Insert
      //    after the top-level closing tag that ends the intro copy so trust
      //    bullets sit between the opening copy and the whole list — never
      //    inside it, and never before a list that is itself nested. ──
      const listRe = /<(ul|ol)\b/gi;
      let lm;
      while ((lm = listRe.exec(html)) !== null) {
        const listPos = lm.index;
        if (!isTopLevelSafe(html, listPos)) continue; // skip nested lists
        const before  = html.slice(0, listPos);
        const textLen = before.replace(/<[^>]*>/g, '').trim().length;
        if (textLen < 50) { break; }
        let bestPos = -1;
        let bestTag = null;
        for (const tag of STANDALONE_BLOCK_TAGS) {
          const idx = before.lastIndexOf(tag);
          if (idx !== -1 && idx > bestPos) { bestPos = idx; bestTag = tag; }
        }
        if (bestPos !== -1) {
          const pos = bestPos + bestTag.length;
          if (isTopLevelSafe(html, pos)) {
            return {
              found:      true,
              position:   pos,
              anchorText: bestTag,
              confidence: 'high',
              preview:    html.slice(Math.max(0, bestPos - 80), pos),
            };
          }
        }
        break; // first top-level list handled; fall through to paragraph anchors
      }

      // ── Secondary: after the first TOP-LEVEL </p> with ≥20 text chars before
      //    it — a clean standalone paragraph break near the top. ──
      let pFrom = 0;
      let pIdx;
      while ((pIdx = html.indexOf('</p>', pFrom)) !== -1) {
        const pos     = pIdx + 4;
        const before  = html.slice(0, pIdx);
        const textLen = before.replace(/<[^>]*>/g, '').trim().length;
        if (textLen >= 20 && isTopLevelSafe(html, pos)) {
          return {
            found:      true,
            position:   pos,
            anchorText: '</p>',
            confidence: 'medium',
            preview:    before.replace(/<[^>]*>/g, '').trim().slice(-100),
          };
        }
        pFrom = pIdx + 4;
      }

      // ── Fallback: after the last top-level-safe closing block (low confidence). ──
      const candidates = collectSafeCloses(html);
      if (candidates.length) {
        return makeAnchor(html, candidates[candidates.length - 1], 'low');
      }

      // ── Final safety net: last closing block of any kind, so output stays valid. ──
      let lastPos = -1;
      let lastTag = null;
      for (const tag of STANDALONE_BLOCK_TAGS) {
        const idx = html.lastIndexOf(tag);
        if (idx > lastPos) { lastPos = idx; lastTag = tag; }
      }
      if (lastPos !== -1) {
        const pos = lastPos + lastTag.length;
        return {
          found:      true,
          position:   pos,
          anchorText: lastTag,
          confidence: 'low',
          preview:    html.slice(Math.max(0, lastPos - 80), pos),
        };
      }

      return { found: false };
    },

    // generatedFix.bestGuess.content is already a <ul> — pass through as-is.
    wrapContent(text) {
      return text;
    },
  },

  no_size_guide: {
    field: 'bodyHtml',
    // Additive-only. Appends size-guide block after the last block element.
    // No anchor found → eligibleToApply: false (graceful block).
    preferredModes: ['insert_after_anchor'],

    findAnchor(html) {
      if (!html) return { found: false };

      const blockTags = ['</p>', '</ul>', '</ol>', '</div>', '</h6>', '</h5>', '</h4>', '</h3>', '</h2>', '</h1>', '</blockquote>'];
      let lastPos = -1;
      let lastTag = null;

      for (const tag of blockTags) {
        const idx = html.lastIndexOf(tag);
        if (idx > lastPos) { lastPos = idx; lastTag = tag; }
      }

      if (lastPos !== -1) {
        const pos = lastPos + lastTag.length;
        return {
          found:      true,
          position:   pos,
          anchorText: lastTag,
          preview:    html.slice(Math.max(0, lastPos - 80), pos),
        };
      }

      return { found: false };
    },

    // generatedFix.bestGuess.content is already structured HTML — pass through as-is.
    wrapContent(text) {
      return text;
    },
  },

  description_too_short: {
    field: 'bodyHtml',
    // Append-only. Never fires replace_full_body — description_too_short requires
    // existing content (check gates on bodyHtml present + < 200 text chars).
    preferredModes: ['insert_after_anchor'],

    findAnchor(html) {
      if (!html) return { found: false };

      // Append expansion block after the last closing block element.
      const blockTags = ['</p>', '</ul>', '</ol>', '</div>', '</h6>', '</h5>', '</h4>', '</h3>', '</h2>', '</h1>', '</blockquote>'];
      let lastPos = -1;
      let lastTag = null;

      for (const tag of blockTags) {
        const idx = html.lastIndexOf(tag);
        if (idx > lastPos) { lastPos = idx; lastTag = tag; }
      }

      if (lastPos !== -1) {
        const pos = lastPos + lastTag.length;
        return {
          found:      true,
          position:   pos,
          anchorText: lastTag,
          preview:    html.slice(Math.max(0, lastPos - 80), pos),
        };
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
// normalizeHtmlForCompare / safeHtmlEquivalent
//
// Shopify reformats saved product body_html — it inserts/removes newlines and
// whitespace *between* block tags (e.g. it turns the compact "<ul><li>" we write
// into "<ul>\n<li>"). The stored ContentExecution.resultContent is the pre-write
// compact string, while the live/local body carries Shopify's reformatted copy,
// so a strict byte compare in the rollback guard reports a false "manual edit".
//
// normalizeHtmlForCompare removes ONLY harmless formatting:
//   - normalizes line endings
//   - strips whitespace that sits purely between two tags (">  <" → "><")
//   - collapses remaining whitespace runs (inside text nodes) to a single space
// It preserves all tags, attributes, and text — so real drift still differs:
//   changed text, missing/duplicated data-cro-block, removed paragraphs, added
//   content, or changed links/attributes all survive normalization and block.
// ---------------------------------------------------------------------------
function normalizeHtmlForCompare(html) {
  return String(html ?? '')
    .replace(/\r\n/g, '\n')   // normalize line endings
    .replace(/>\s+</g, '><')  // drop whitespace between adjacent tags (Shopify reformatting)
    .replace(/\s+/g, ' ')     // collapse remaining whitespace runs within text nodes
    .trim();
}

// Returns true when two HTML strings are equal, or differ ONLY by the harmless
// Shopify whitespace normalization above. Never treats text/structure changes as
// equivalent. Used solely by the rollback manual-edit guard.
function safeHtmlEquivalent(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return normalizeHtmlForCompare(a) === normalizeHtmlForCompare(b);
}

// ---------------------------------------------------------------------------
// Context-aware anchor safety
//
// Standalone CRO blocks (no_risk_reversal, no_trust_bullets) must be inserted
// as a top-level sibling — never nested inside a list, table, definition list,
// figure, blockquote, <select>, or an existing CRO block. The old heuristic
// picked the nearest closing tag by character position alone, so it could land
// the block between two <li> items because a </p> *inside* that <li> was the
// closest closing tag before the target percentage.
//
// openElementsAt walks every tag from the start of the document up to `pos` and
// returns the stack of still-open elements at that offset. isTopLevelSafe then
// rejects any position whose open-element stack contains a structured container
// or a CRO block. Pure string scanning — deterministic, no DOM, no side effects,
// and tolerant of unclosed inner tags (exact on well-formed Shopify HTML).
// ---------------------------------------------------------------------------
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose interior is a structured section a standalone block must not
// be inserted into.
const STRUCTURED_CONTAINER_TAGS = new Set([
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'dl', 'dt', 'dd', 'figure', 'figcaption', 'blockquote', 'picture', 'select', 'option',
]);

// Block-level closing tags eligible as standalone-insertion anchors.
const STANDALONE_BLOCK_TAGS = [
  '</p>', '</ul>', '</ol>', '</div>', '</h6>', '</h5>', '</h4>',
  '</h3>', '</h2>', '</h1>', '</blockquote>',
];

function openElementsAt(html, pos) {
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index >= pos) break;
    const isClose     = m[1] === '/';
    const tag         = m[2].toLowerCase();
    const attrs       = m[3] || '';
    const selfClosing = /\/\s*$/.test(attrs) || VOID_ELEMENTS.has(tag);
    if (isClose) {
      // Pop back to the matching open tag, tolerating unclosed inner elements.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
    } else if (!selfClosing) {
      stack.push({ tag, isCroBlock: /data-cro-block/i.test(attrs) });
    }
  }
  return stack;
}

// True when inserting at `pos` would NOT land inside a structured section
// (list/table/definition list/figure/blockquote/select) or an existing CRO block.
function isTopLevelSafe(html, pos) {
  if (pos == null || pos < 0) return false;
  return !openElementsAt(html, pos).some(
    el => STRUCTURED_CONTAINER_TAGS.has(el.tag) || el.isCroBlock,
  );
}

// All top-level-safe block-closing positions in `html`, sorted by position.
// Each: { tag, idx (start of closing tag), pos (insertion offset just after it) }.
function collectSafeCloses(html) {
  const candidates = [];
  for (const tag of STANDALONE_BLOCK_TAGS) {
    let from = 0;
    let idx;
    while ((idx = html.indexOf(tag, from)) !== -1) {
      const pos = idx + tag.length;
      if (isTopLevelSafe(html, pos)) candidates.push({ tag, idx, pos });
      from = idx + tag.length;
    }
  }
  candidates.sort((a, b) => a.pos - b.pos);
  return candidates;
}

function makeAnchor(html, c, confidence) {
  return {
    found:      true,
    position:   c.pos,
    anchorText: c.tag,
    confidence,            // non-persisted hint; ignored by detectPatchMode/storage
    preview:    html.slice(Math.max(0, c.idx - 80), c.pos),
  };
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
      // Use a replacer function — raw replacement strings interpret `$` as
      // backreference patterns (e.g. `$&`, `$1`) which would silently corrupt
      // generated prose content that contains dollar signs.
      return currentContent.replace(plan.matchedBlock, () => wrapped);

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
function gate(actionItem, { preview = false } = {}) {
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
  if (!preview && actionItem.reviewStatus !== 'approved') {
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
  const { eligible, reason } = gate(actionItem, { preview });

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
      ? issueId === 'no_trust_bullets'
        ? `Reassurance block will be appended after "${plan.anchorUsed}". Existing content preserved.`
        : issueId === 'no_size_guide'
        ? `Size guide block will be appended after "${plan.anchorUsed}". Existing content preserved.`
        : `Content block will be inserted after anchor "${plan.anchorUsed}". Existing content preserved.`
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

// ---------------------------------------------------------------------------
// buildResultContent
//
// Computes the full merged bodyHtml for a content_change apply using the same
// PATCH_MODE_REGISTRY pipeline as preview. Called by applyContentChange so
// that preview and apply always produce identical output.
//
// Returns the merged HTML string, or throws with a descriptive message when no
// safe patch mode is available (caller should abort the apply and surface the
// error rather than falling back to a destructive merge).
// ---------------------------------------------------------------------------
function buildResultContent(issueId, currentContent, proposedContent) {
  const plan = detectPatchMode(issueId, currentContent, null);
  if (!plan.mode) {
    const err = new Error(plan.error || 'No viable patch mode for this issue.');
    err.patchError = true;
    throw err;
  }
  const validation = validatePatch(plan, currentContent, proposedContent);
  if (!validation.valid) {
    const err = new Error(validation.error || 'Patch validation failed.');
    err.patchError = true;
    throw err;
  }
  return applyPatch(plan, currentContent, proposedContent, issueId);
}

// ---------------------------------------------------------------------------
// wrapIssueContent
//
// Returns the HTML-wrapped form of `text` for the given issueId using the
// same PATCH_MODE_REGISTRY.wrapContent() used internally by applyPatch.
// Exported so the apply path can compute the exact block shape that will
// appear in resultContent — used to locate and annotate the inserted block
// with exposure-tracking markers without re-running the full patch pipeline.
// ---------------------------------------------------------------------------
function wrapIssueContent(issueId, text) {
  const reg = PATCH_MODE_REGISTRY[issueId];
  if (!reg) return text;
  return reg.wrapContent(text);
}

// Exported so callers can cheaply determine whether an issueId requires a
// proposedContent snapshot at approval time without re-running the CRO engine.
// A content_change issue is only auto-applicable if it has a PATCH_MODE_REGISTRY
// entry — this set is therefore the authoritative list for that check.
const CONTENT_CHANGE_ISSUE_IDS = new Set(Object.keys(PATCH_MODE_REGISTRY));

module.exports = {
  previewContentExecution,
  previewRollback,
  getExecutionHistory,
  buildResultContent,
  wrapIssueContent,
  safeHtmlEquivalent,
  CONTENT_CHANGE_ISSUE_IDS,
};
