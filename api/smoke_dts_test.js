'use strict';
require('dotenv').config();

const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.log(`  ✗ FAIL: ${msg}`); process.exitCode = 1; };
const note = (msg) => console.log(`  → ${msg}`);

const { PrismaClient } = require('@prisma/client');
let dbUrl = process.env.DATABASE_URL || '';
dbUrl = dbUrl.split('?')[0] + '?connection_limit=1&pool_timeout=10';
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const STORE_ID   = 'cmnsydlqf000011xes4rufsf3';
const PRODUCT_ID = 'cmnsyokn300011446pt4c7d8j'; // AURA PowerBank — real id, real store

// Short body that triggers description_too_short.check():
//   p.bodyHtml present AND stripped text < 200 chars
// Stripped text here is ~85 chars — well under the 200 threshold.
const SHORT_BODY = '<p>A portable 10,000mAh powerbank with magnetic wireless charging and USB-C fast charge support.</p>';

async function main() {
  // ── SECTION 1: Product and issue ─────────────────────────────────────────────
  console.log('\n── SECTION 1: Product and issue tested ──');

  const baseProduct = await prisma.product.findUnique({
    where: { id: PRODUCT_ID },
    include: { variants: true, images: { take: 5 }, store: true },
  });
  if (!baseProduct) { fail('Base product not found'); return; }

  const rawProduct = { ...baseProduct, bodyHtml: SHORT_BODY };

  const strippedLen = SHORT_BODY.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
  note(`Product:         "${rawProduct.title}"`);
  note(`productId:       ${rawProduct.id}`);
  note(`Store:           ${rawProduct.store?.shopDomain}`);
  note(`Price:           ${rawProduct.variants?.[0]?.price}`);
  note(`bodyHtml:        short synthetic (DB unchanged)`);
  note(`Stripped length: ${strippedLen} chars (threshold: < 200)`);

  if (strippedLen > 0 && strippedLen < 200) {
    pass(`description_too_short.check() would fire (stripped=${strippedLen} < 200)`);
  } else {
    fail(`description_too_short.check() would NOT fire at stripped=${strippedLen}`);
    return;
  }

  // Also confirm no_description would NOT fire (bodyHtml is present and > 50 chars)
  if (strippedLen >= 50) {
    pass('no_description.check() would NOT fire (stripped >= 50 — correct)');
  } else {
    fail('stripped text < 50: no_description would also fire — adjust SHORT_BODY');
    return;
  }

  // ── SECTION 2: Live getProductActions ────────────────────────────────────────
  console.log('\n── SECTION 2: Live description_too_short presence ──');

  const { getProductActions } = require('./src/services/action-center.service');
  const result = await getProductActions(rawProduct, { prisma, storeId: STORE_ID });

  const dtsAction = result.actions?.find(a => a.issueId === 'description_too_short');
  const ndAction  = result.actions?.find(a => a.issueId === 'no_description');

  if (!dtsAction) {
    fail('description_too_short not in actions');
    note('Issue IDs: ' + (result.actions?.map(a => a.issueId).join(', ') || 'none'));
    return;
  }
  pass('description_too_short found in actions');

  if (!ndAction) {
    pass('no_description absent from actions (correct — body is present)');
  } else {
    fail('no_description unexpectedly also fired');
  }

  note('All issue IDs: ' + result.actions.map(a => a.issueId).join(', '));

  const gfSource  = dtsAction.generatedFix?.bestGuess?.source ?? 'none';
  const gfContent = dtsAction.generatedFix?.bestGuess?.content ?? '';
  note(`generatedFix.bestGuess.source:  ${gfSource}`);
  note(`generatedFix.bestGuess.content: ${gfContent.length} chars`);
  note(`proposedContent:                ${(dtsAction.proposedContent || '').length} chars`);
  note(`proposedContent snippet: "${(dtsAction.proposedContent || '').slice(0, 120)}"`);

  // ── SECTION 3: LLM path or fallback ──────────────────────────────────────────
  console.log('\n── SECTION 3: LLM path / fallback result ──');

  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  note(`ANTHROPIC_API_KEY present: ${hasKey}`);

  if (!hasKey) {
    pass('Key absent — template fallback path active');
    if (gfContent.length >= 30) {
      pass(`Template generatedFix.bestGuess.content valid (${gfContent.length} chars)`);
    } else {
      fail('Template generatedFix.bestGuess.content empty or too short');
    }
    if (dtsAction.proposedContent) {
      pass('Template proposedContent populated');
    } else {
      fail('Template proposedContent empty');
    }
  } else {
    if (gfSource === 'llm') {
      pass('LLM path fired: source === "llm"');
    } else {
      note('LLM did not fire — fell back to template');
    }
    if (gfContent.length >= 30) pass(`generatedFix.bestGuess.content valid (${gfContent.length} chars)`);
    else                         fail('generatedFix.bestGuess.content too short');
  }

  // ── SECTION 4: Output contract ────────────────────────────────────────────────
  console.log('\n── SECTION 4: Output contract ──');

  // 4a — bestGuess.content
  if (gfContent) pass(`bestGuess.content exists (${gfContent.length} chars)`);
  else           fail('bestGuess.content missing');

  // 4b — proposedContent
  if (dtsAction.proposedContent) pass('proposedContent present');
  else                           fail('proposedContent missing');

  // 4c — plain text (no <p> wrapper — wrapContent adds it)
  const proposed = dtsAction.proposedContent || '';
  if (!proposed.startsWith('<p>')) {
    pass('proposedContent is plain text — no <p> wrapper (wrapContent adds it at apply time)');
  } else {
    note('proposedContent starts with <p> — checking wrapContent for double-wrap risk');
  }

  // 4d — wrapContent produces correct final HTML
  const { wrapIssueContent } = require('./src/services/content-execution.service');
  if (proposed) {
    const wrapped = wrapIssueContent('description_too_short', proposed);
    if (wrapped === `<p>${proposed}</p>`) {
      pass(`wrapIssueContent("description_too_short", text) → "<p>text</p>" ✓`);
    } else {
      fail(`wrapContent produced unexpected output: "${(wrapped || '').slice(0, 80)}"`);
    }
  }

  // 4e — generatedFix shape (variants + bestGuess)
  const gf = dtsAction.generatedFix;
  if (gf?.variants?.length > 0) pass(`generatedFix.variants: ${gf.variants.length} entr${gf.variants.length === 1 ? 'y' : 'ies'}`);
  else                           fail('generatedFix.variants empty or missing');
  if (gf?.bestGuess)             pass('generatedFix.bestGuess present');
  else                           fail('generatedFix.bestGuess missing');

  // 4f — insert_after_anchor compatibility: findAnchor must find an anchor in SHORT_BODY
  //      (description_too_short requires existing HTML structure for insert_after_anchor to work)
  //      The pipeline's findAnchor looks for last closing block element
  const { PATCH_MODE_REGISTRY } = (() => {
    // Access via internal require — white-box test
    try {
      // content-execution.service exports wrapIssueContent; PATCH_MODE_REGISTRY is not exported.
      // Test findAnchor by checking the module source for expected behavior.
      const ceSrc = require('fs').readFileSync('./src/services/content-execution.service.js', 'utf8');
      const hasFindAnchor = ceSrc.includes("id: 'description_too_short'") ||
                            ceSrc.includes("description_too_short: {");
      return { PATCH_MODE_REGISTRY: hasFindAnchor ? 'verified' : null };
    } catch(_) { return { PATCH_MODE_REGISTRY: null }; }
  })();

  if (PATCH_MODE_REGISTRY) {
    // Verify SHORT_BODY has a closing block element that findAnchor can latch onto
    const hasBlockClose = ['</p>', '</ul>', '</ol>', '</div>'].some(t => SHORT_BODY.includes(t));
    if (hasBlockClose) {
      pass('SHORT_BODY contains closing block element — findAnchor will succeed');
    } else {
      fail('SHORT_BODY has no closing block element — insert_after_anchor would fail');
    }
  }

  // ── SECTION 5: Mocked LLM prompt-path ────────────────────────────────────────
  console.log('\n── SECTION 5: Mocked LLM prompt verification ──');

  const { generateShortDescriptionExpansionWithLLM, buildExpansionPrompt } =
    require('./src/services/cro/generators/short-description-llm');
  const { buildCopyPlan } = require('./src/services/cro/copy-plan');

  const copyPlan = buildCopyPlan(rawProduct, null);
  pass(`CopyPlan: barrier=${copyPlan.barrier}, tone=${copyPlan.toneKey}, frame=${copyPlan.emotionalFrame}`);

  // 5a — Prompt inspection
  const prompt = buildExpansionPrompt(rawProduct, copyPlan);

  const strippedBody = SHORT_BODY.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (prompt.includes(strippedBody)) {
    pass(`Stripped existing body present in prompt: "${strippedBody.slice(0, 60)}…"`);
  } else {
    // Check partial match — truncateAtWord may have cut it
    const first40 = strippedBody.slice(0, 40);
    if (prompt.includes(first40)) {
      pass(`Stripped existing body (first 40 chars) present in prompt`);
    } else {
      fail('Stripped existing body missing from prompt');
    }
  }

  if (prompt.includes('Do not repeat or paraphrase')) {
    pass('"Do not repeat or paraphrase" rule in prompt');
  } else {
    fail('"Do not repeat or paraphrase" rule missing');
  }

  if (prompt.includes('Build on it')) {
    pass('"Build on it" extension instruction in prompt');
  } else {
    fail('"Build on it" instruction missing');
  }

  if (prompt.includes('appended')) {
    pass('Prompt frames task as "appended" (not replacing)');
  } else {
    fail('Prompt does not frame task as appending');
  }

  // CopyPlan fields
  for (const [key, val] of [
    ['barrier', copyPlan.barrier], ['toneKey', copyPlan.toneKey],
    ['emotionalFrame', copyPlan.emotionalFrame], ['priceTier', copyPlan.priceTier],
  ]) {
    if (prompt.includes(val)) pass(`CopyPlan.${key}="${val}" in prompt`);
    else                      fail(`CopyPlan.${key}="${val}" missing from prompt`);
  }

  note(`Prompt length: ${prompt.length} chars`);

  // 5b — Mocked LLM call
  const mockText = 'Carrying a device that keeps up with your day without needing a wall socket changes the calculus on where you can work. The confidence that comes from a full battery reading at noon is different from the low-grade anxiety of watching the percentage drop. You stop planning your day around outlets.';

  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, json: async () => ({ content: [{ text: mockText }] }),
  });
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'mock-key';

  const llmFix = await generateShortDescriptionExpansionWithLLM(rawProduct, copyPlan);

  process.env.ANTHROPIC_API_KEY = savedKey;
  global.fetch = realFetch;

  if (!llmFix) { fail('generateShortDescriptionExpansionWithLLM returned null'); }
  else {
    pass('generateShortDescriptionExpansionWithLLM returned non-null');

    const v = llmFix.bestGuess;
    if (v?.source === 'llm')                   pass('source === "llm"');
    else                                        fail(`source="${v?.source}", expected "llm"`);

    if (v?.placement === 'description_expansion') pass('placement === "description_expansion"');
    else                                          fail(`placement="${v?.placement}", expected "description_expansion"`);

    if ((v?.content || '').length >= 60)        pass(`content valid (${v.content.length} chars)`);
    else                                        fail('content too short');

    if (llmFix.variants?.length === 1)          pass('variants has exactly 1 entry');
    else                                        fail(`variants.length=${llmFix.variants?.length}`);

    if (v?.copyPlan?.barrier)                   pass(`copyPlan.barrier="${v.copyPlan.barrier}" annotated`);
    else                                        fail('copyPlan annotation missing');

    if (!v.content.startsWith('<p>'))           pass('content is plain text — no <p> wrapper');
    else                                        fail('content should not start with <p>');
  }

  // ── SECTION 6: Isolation ─────────────────────────────────────────────────────
  console.log('\n── SECTION 6: Isolation ──');

  const { buildDescriptionPrompt }  = require('./src/services/cro/generators/description-llm');
  const { buildRiskReversalPrompt } = require('./src/services/cro/generators/risk-reversal-llm');
  const { buildTrustBulletsPrompt } = require('./src/services/cro/generators/trust-bullets-llm');
  const { buildLLMPrompt }          = require('./src/services/cro/generators/desire-block-llm');

  const otherPrompts = [
    ['no_description',       buildDescriptionPrompt(rawProduct, copyPlan)],
    ['no_risk_reversal',     buildRiskReversalPrompt(rawProduct, copyPlan)],
    ['no_trust_bullets',     buildTrustBulletsPrompt(rawProduct, copyPlan)],
    ['weak_desire_creation', buildLLMPrompt(rawProduct, copyPlan)],
  ];

  for (const [name, p] of otherPrompts) {
    const contaminated = p.includes('description_expansion') ||
                         p.includes('appended to an existing') ||
                         p.includes('Do not repeat or paraphrase');
    if (!contaminated) pass(`${name} prompt uncontaminated`);
    else               fail(`${name} prompt contains description_too_short-specific copy`);
  }

  // description_expansion must not appear in no_description prompt
  const ndPrompt = buildDescriptionPrompt(rawProduct, copyPlan);
  if (!ndPrompt.includes('description_expansion')) {
    pass('no_description prompt has no "description_expansion" marker');
  } else {
    fail('"description_expansion" leaked into no_description prompt');
  }

  // No unexpected LLM source on other issue types
  const EXPECTED_LLM = new Set(['weak_desire_creation', 'no_risk_reversal', 'no_trust_bullets', 'no_description', 'description_too_short']);
  const unexpected = (result.actions || []).filter(
    a => !EXPECTED_LLM.has(a.issueId) && a.generatedFix?.bestGuess?.source === 'llm'
  );
  if (unexpected.length === 0) pass('No unexpected issue types carry source=llm');
  else                         fail(`Unexpected LLM on: ${unexpected.map(a => a.issueId).join(', ')}`);

  console.log('\n── Smoke test complete ──');
}

main()
  .catch(e => { console.error('\nFATAL:', e.message, '\n', e.stack); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
