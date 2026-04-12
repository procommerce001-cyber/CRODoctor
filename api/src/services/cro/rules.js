'use strict';

const { generateDesireBlock } = require('./generators/desire-block');

// ---------------------------------------------------------------------------
// CRO Rule Definitions
//
// Each rule:
//   id                 : unique string key
//   title              : short display title
//   category           : one of CATEGORIES.*
//   severity           : one of SEVERITY.*
//   impact             : array of IMPACT.*
//   effort             : one of EFFORT.*
//   confidence         : one of CONFIDENCE.*
//   implementationType : one of IMPLEMENTATION_TYPE.*
//   check(product)     : pure function → boolean (true = issue exists)
//   build(product)     : pure function → full issue intelligence object
//
// build() returns:
//   userHesitation      : exact visitor thought that blocks the purchase
//   psychologicalTrigger: named cognitive bias / principle being exploited
//   whyItMatters        : revenue business case
//   exactFix: {
//     what        : specific action to take
//     placement   : exact location on the page
//     uiElement   : component type (badge, text block, icon row, etc.)
//     microcopy   : array of ready-to-use copy strings
//     type        : 'copy' | 'ui' | 'app' | 'merchant_action' | 'code'
//     difficulty  : 'easy' | 'medium' | 'hard'
//   }
//   businessImpact: {
//     metric     : 'cvr' | 'aov' | 'both'
//     magnitude  : 'low' | 'medium' | 'high'
//     fixType    : 'quick_win' | 'structural'
//     reasoning  : why this specific change makes more money
//   }
//   priorityBucket : '2h' | '1d' | '1w'  (when to tackle relative to other fixes)
//   productTypeNotes: how this recommendation adapts by product type
//
// Rules must:
//   - never throw (check/build wrapped externally)
//   - never mutate the product object
//   - be deterministic for the same input
// ---------------------------------------------------------------------------

const {
  CATEGORIES: C,
  SEVERITY: S,
  IMPACT: I,
  EFFORT: E,
  CONFIDENCE: CF,
  IMPLEMENTATION_TYPE: IT,
} = require('./constants');

// ---------------------------------------------------------------------------
// detectProductType — infers the commercial context of the product
// Used by build() functions to tailor advice to product economics.
// ---------------------------------------------------------------------------
function detectProductType(p) {
  const price    = parseFloat(String(p.variants?.[0]?.price || 0));
  const title    = (p.title || '').toLowerCase();
  const desc     = (p.bodyHtml || '').toLowerCase();
  const combined = title + ' ' + desc;

  const hasSizeVariants = p.variants.some(v => {
    const t = (v.title || '').toLowerCase();
    return ['xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', 'small', 'medium', 'large', 'x-large'].includes(t);
  });

  if (price >= 100) return 'high_ticket';
  if (['smart', 'wireless', 'bluetooth', 'electric', 'digital', 'projector', 'led', 'laser', 'sensor', 'tracker'].some(k => title.includes(k))) return 'functional_tech';
  if (['back', 'posture', 'pain', 'relief', 'therapy', 'massage', 'support', 'health', 'spine', 'neck', 'recovery'].some(k => combined.includes(k))) return 'health';
  if (hasSizeVariants) return 'fashion';
  if (price < 30) return 'impulse';
  return 'functional';
}

const RULES = [

  // ══════════════════════════════════════════════════════════════════════════
  // FRICTION — blockers between visitor and purchase
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'all_variants_oos',
    title: 'All variants out of stock — product cannot be purchased',
    category: C.FRICTION,
    severity: S.CRITICAL,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.APP_CONFIG,
    check: p => p.variants.length > 0 && p.variants.every(v => !v.availableForSale),
    build: p => {
      const type = detectProductType(p);
      return {
        userHesitation: 'There is no Add to Cart button. I cannot buy this. I will find it somewhere else — or just forget about it.',
        psychologicalTrigger: 'blocked_desire — the visitor arrived with purchase intent; a dead end converts that intent into frustration and brand abandonment',
        whyItMatters: `Every visitor to this product page — paid or organic — generates $0. There is no lower-converting state than an unpurchasable product. The only revenue recovery available right now is capturing restock demand.`,
        exactFix: {
          what: 'Install a back-in-stock app (Back in Stock – Restock Alerts, or Klaviyo). Replace the dead ATC area with an email capture form. Add urgency copy to the form to increase sign-up rate.',
          placement: 'Replace the Add to Cart button entirely — above the fold, in the primary purchase zone',
          uiElement: 'Email capture form with urgency headline + social reinforcement subtext',
          microcopy: [
            `🔔 NOTIFY ME WHEN BACK IN STOCK\n[email input]\n"Be first — we're restocking soon and stock will go fast."`,
            `⚡ LIMITED RESTOCK COMING\n[email input]\n"Join ${type === 'high_ticket' ? '47' : '312'} people waiting. We'll email you the moment it's live."`,
            `— Restock email subject —\n"Your ${p.title} is back — we only have limited units"\n\n"You asked us to notify you. We restocked ${type === 'high_ticket' ? '10' : '50'} units. Grab yours before they're gone again."`,
          ],
          type: 'app',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'quick_win',
          reasoning: 'Back-in-stock email lists convert at 10–15% when restocked — 5–10× higher than cold traffic. Every visitor who signs up is a warm lead who has already decided to buy. Without this, that intent disappears permanently.',
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: emphasize exclusivity and limited restock units ("only 10 units coming back"). Add a "reserve yours" framing to increase commitment.'
          : type === 'fashion'
          ? 'Fashion: segment notification by size variant. "Your size (M) is coming back — be first to know." Reduces sign-up hesitation and increases relevance.'
          : type === 'health'
          ? 'Health: connect to the pain urgency. "Your recovery shouldn\'t wait — be first when we restock." Reactivates the original motivator.'
          : 'Impulse: keep it fast — one-click email capture, minimal friction. The impulse window is short.',
      };
    },
  },

  {
    id: 'product_is_draft',
    title: 'Product is a draft — not visible to customers',
    category: C.FRICTION,
    severity: S.CRITICAL,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.MERCHANT_ACTION,
    check: p => p.status === 'draft',
    build: p => ({
      userHesitation: 'Not applicable — no visitor can reach this product. It is generating $0 and is invisible to search engines.',
      psychologicalTrigger: 'invisible_product — the product exists in the database but does not exist in the market',
      whyItMatters: `"${p.title}" is not live. Every day it stays as a draft is a day of zero revenue from this SKU. If the product is ready, this is the highest-ROI action in the entire store: one click, zero cost, immediate revenue potential.`,
      exactFix: {
        what: 'Review product for completeness (images, description, price, variants), then set status to Active in Shopify Admin.',
        placement: 'Shopify Admin → Products → Status dropdown (top right of product editor)',
        uiElement: 'Admin action — no frontend change',
        microcopy: [
          'Pre-publish checklist: ✅ 4+ images ✅ 200+ word description ✅ Compare-at price ✅ Guarantee line ✅ Alt text on hero image',
        ],
        type: 'merchant_action',
        difficulty: 'easy',
      },
      businessImpact: {
        metric: 'cvr',
        magnitude: 'high',
        fixType: 'quick_win',
        reasoning: 'A draft product earns $0 regardless of quality. Publishing is the prerequisite for all other CRO. If the product is ready, every other fix on this page is irrelevant until this is done.',
      },
      priorityBucket: '2h',
      productTypeNotes: 'All product types: same urgency. Do not publish until the product is ready — a live but incomplete product can be worse than a draft if it damages brand trust.',
    }),
  },

  {
    id: 'some_variants_oos',
    title: 'Some variants out of stock — real demand signal being wasted',
    category: C.FRICTION,
    severity: S.MEDIUM,
    impact: [I.CONVERSION],
    effort: E.MEDIUM,
    confidence: CF.HIGH,
    implementationType: IT.THEME_PATCH,
    check: p => p.variants.some(v => !v.availableForSale) && p.variants.some(v => v.availableForSale),
    build: p => {
      const oos   = p.variants.filter(v => !v.availableForSale).map(v => v.title);
      const avail = p.variants.filter(v => v.availableForSale).map(v => v.title);
      const type  = detectProductType(p);
      return {
        userHesitation: `I wanted ${oos[0]} but it says unavailable. Is this brand out of stock everywhere? Maybe it's not popular. I'll check Amazon instead.`,
        psychologicalTrigger: 'demand_signal_wasted — sold-out variants prove other people chose this product; hiding them silently destroys the social proof they represent',
        whyItMatters: `Variants [${oos.join(', ')}] are sold out. That is real, data-backed demand proof. Most themes hide these variants or grey them out without explanation. A sold-out label converts OOS frustration into social proof for available variants.`,
        exactFix: {
          what: `Label all sold-out swatches with "Sold Out" visibly. Add a scarcity line below the variant selector. Optionally add back-in-stock capture per variant.`,
          placement: 'Variant selector area — badge on each swatch + urgency line below selector, above ATC',
          uiElement: 'Greyed swatch with "Sold Out" badge + inline scarcity text block',
          microcopy: [
            oos.map(v => `"${v}" swatch → grey with "Sold Out" label`).join('\n'),
            `Below selector: "⚠️ ${oos.join(', ')} sold out — only ${avail.join(', ')} still available"`,
            `"${oos[0]} coming back soon — ${type === 'fashion' ? 'notify me for my size' : 'notify me'} →"`,
          ],
          type: 'ui',
          difficulty: 'medium',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'medium',
          fixType: 'structural',
          reasoning: 'Visible sold-out labels create demand proof for available variants ("other people chose this — get yours before it also sells out"). Silence on OOS creates doubt; explicit labelling creates urgency.',
        },
        priorityBucket: '1d',
        productTypeNotes: type === 'fashion'
          ? 'Fashion/apparel: "Your size (M) sold out — Size L is the last one." Size-specific scarcity is more urgent than product-level scarcity.'
          : type === 'health'
          ? 'Health: "The most popular size sold out — others found it worked best for their situation." Social proof embedded in the OOS message.'
          : 'All types: sold-out display converts doubt into urgency for available variants. Never silently hide OOS options.',
      };
    },
  },

  {
    id: 'no_size_guide',
    title: 'Size variants with no size guide — sizing anxiety blocks purchase',
    category: C.FRICTION,
    severity: S.HIGH,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.CONTENT_CHANGE,
    check: p => {
      const hasSizeVariants = p.variants.some(v => {
        const t = (v.title || '').toLowerCase();
        if (['xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl', 'small', 'medium', 'large', 'x-large'].includes(t)) return true;
        if (/^(size\s*)?\d{1,2}(\.\d)?$/.test(t)) return true;
        return false;
      });
      if (!hasSizeVariants) return false;
      if (!p.bodyHtml) return true;
      const t = p.bodyHtml.toLowerCase();
      return !['size guide', 'size chart', 'sizing', 'how to measure', 'measurement'].some(w => t.includes(w));
    },
    build: p => {
      const sizeVariants = p.variants
        .filter(v => {
          const t = (v.title || '').toLowerCase();
          return ['xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl', 'small', 'medium', 'large', 'x-large'].includes(t)
            || /^(size\s*)?\d{1,2}(\.\d)?$/.test(t);
        })
        .map(v => v.title);
      const type = detectProductType(p);
      const isRing = sizeVariants.some(v => /^\d/.test(v));
      return {
        userHesitation: `I'm not sure which size to order. If I pick wrong I'll have to deal with a return — and I hate returns. It's easier to just not buy it.`,
        psychologicalTrigger: 'uncertainty_avoidance — the cost of ordering the wrong size (hassle of return, wait time, uncertainty of refund) feels greater than the cost of not buying; "not buying" is always the safe choice when size is unclear',
        whyItMatters: `This product has ${sizeVariants.length} size options (${sizeVariants.join(', ')}) and zero sizing guidance. For every visitor who wants this product, sizing doubt is the last obstacle between intent and purchase. Removing that doubt is a $0 fix with immediate CVR impact.`,
        exactFix: {
          what: isRing
            ? 'Add a ring sizing section to the description: how to measure ring size at home + a size-to-circumference table. Add a "not sure? size up" fallback.'
            : 'Add a size guide section at the bottom of the description. Include: a measurement instruction (how to measure), a size-to-measurement table, and a "between sizes? size up" rule.',
          placement: 'Bottom of product description OR collapsible "Size Guide" tab directly below the variant selector (above ATC)',
          uiElement: isRing
            ? 'Inline HTML table in description + 1-sentence measurement instruction'
            : 'Collapsible tab or description section with measurement table',
          microcopy: isRing ? [
            `📏 FIND YOUR RING SIZE\nWrap a thin strip of paper around your finger. Mark where it overlaps. Measure the length in mm.\n\n| Size | Circumference |\n|------|---------------|\n${sizeVariants.map(v => `| ${v}   | ${Math.round(parseFloat(v) * 3.14 + 40)} mm |`).join('\n')}\n\n"Between sizes? Always size up for comfort."`,
            `"Not sure of your size? Order our free ring sizer — we'll ship it in 2 days."`,
          ] : [
            `📏 HOW TO FIND YOUR SIZE\nMeasure [chest / waist / length] with a soft tape measure.\n\n| Size | Measurement |\n|------|-------------|\n| S    | [range] cm  |\n| M    | [range] cm  |\n| L    | [range] cm  |\n| XL   | [range] cm  |\n\n"Between sizes? Size up for a relaxed fit. All sizes eligible for free exchange."`,
            `"Not sure? Message us your measurements — we'll recommend your size in under 1 hour."`,
          ],
          type: 'copy',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'quick_win',
          reasoning: 'Sizing anxiety is the single highest-frequency abandonment reason for wearables. Removing it requires only a text addition — no developer, no app, no cost. The return on 30 minutes of work is permanently higher CVR on every visitor who reaches the variant selector.',
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'fashion'
          ? 'Fashion/apparel: include a lifestyle note ("our model is 5\'8" and wears a Medium") alongside the table — this is the fastest way to make sizing feel personal and real.'
          : isRing
          ? 'Wearable/ring: offer a physical ring sizer as a free add-on. The commitment to order a sizer is a micro-conversion that makes the main purchase 3× more likely.'
          : 'Functional/health: frame sizing as performance — "the right size ensures maximum effectiveness." This elevates sizing from inconvenience to feature.',
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // EMOTIONAL SELLING — description quality, copywriting, desire
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'no_description',
    title: 'No product description — no reason to buy',
    category: C.EMOTIONAL,
    severity: S.CRITICAL,
    impact: [I.CONVERSION, I.TRUST],
    effort: E.HIGH,
    confidence: CF.HIGH,
    implementationType: IT.CONTENT_CHANGE,
    check: p => !p.bodyHtml || p.bodyHtml.replace(/<[^>]*>/g, '').trim().length < 50,
    build: p => {
      const type  = detectProductType(p);
      const price = parseFloat(String(p.variants?.[0]?.price || 0));
      return {
        userHesitation: `What does this actually do for me? Why is it better than everything else I could buy? Why should I pay $${price.toFixed(0)} for this specific product from a brand I've never heard of?`,
        psychologicalTrigger: 'information_vacuum — purchase requires justified confidence; a blank page gives the visitor nothing to build confidence with; they default to "I need to research this more" which means they leave and never return',
        whyItMatters: `No description means no benefits, no objection handling, no answer to the buyer's core question: "will this solve my problem?" Cold traffic converts at near 0% without copy. This is not a CRO issue — it is a prerequisite for all other optimisation to matter.`,
        exactFix: {
          what: type === 'high_ticket'
            ? 'Write a 600+ word description structured as: outcome statement → 4–5 benefit bullets with proof → storytelling paragraph connecting to the buyer\'s situation → FAQ section (5 objections answered) → guarantee close'
            : type === 'health'
            ? 'Write a pain-first description: open with the problem the buyer has right now → explain why nothing else has worked → present the product as the solution → 4 benefit bullets → social proof quote → guarantee close'
            : type === 'fashion'
            ? 'Write outcome-first copy: lead with how it looks / makes you feel → material/quality details → size/fit guidance → occasion use cases → guarantee'
            : 'Write a 300+ word benefits-first description: outcome statement → 4–5 benefit bullets → one paragraph story → guarantee close',
          placement: 'Product description field — above the fold on desktop, below images on mobile',
          uiElement: 'Structured HTML text with bullet points, clear hierarchy (H2 or bold lead), no center-alignment',
          microcopy: [
            `✅ [Primary outcome — what life looks like after buying this]\n\n• Benefit 1 — the specific result, not the feature\n• Benefit 2 — the specific result, not the feature\n• Benefit 3 — the specific result, not the feature\n• Benefit 4 — the specific result, not the feature\n\n"[Product] was designed for [customer] who [situation]. Unlike [alternative], it [differentiator because of mechanism]."\n\n"Not what you expected? Full refund within 30 days — no questions asked."`,
            type === 'health'
              ? `"If you've tried [alternative] and it hasn't worked, here's why: [reason]. ${p.title} works differently because [mechanism]. Here's what that means for you: [outcome]."`
              : `"Here's the honest reason most people buy ${p.title}: [real reason]. And here's exactly what happens after they do: [outcome]."`,
          ],
          type: 'copy',
          difficulty: 'medium',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'structural',
          reasoning: `A description is the closest thing a product page has to a salesperson. Without one, the visitor is making a purchasing decision with zero information. Every £ spent on ads sending traffic to a no-description page is partially wasted — the description is what converts that traffic into revenue.`,
        },
        priorityBucket: '1d',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: longer is better. A $100+ decision needs more justification. Add a FAQ section — every objection you pre-answer is one less reason to abandon. Include real specifics (materials, dimensions, certifications).'
          : type === 'health'
          ? 'Health: lead with pain, not product. Visitors are not buying a product — they are buying relief. Start with the problem. Make them feel understood before you introduce the solution.'
          : type === 'fashion'
          ? 'Fashion: buy with eyes first. Lead with visual and emotional language. "Soft, structured, the kind of piece you reach for every week." Then cover practical details.'
          : type === 'impulse'
          ? 'Impulse: short and punchy. 3 bullets, one outcome sentence, one guarantee line. Do not over-explain — impulse purchases need momentum, not analysis.'
          : 'Functional: be specific. Name the exact problem. Give the mechanism. Prove it works. Buyers of functional products are comparison-shopping — specificity beats competitor vagueness.',
      };
    },
  },

  {
    id: 'description_too_short',
    title: 'Description too short — not enough to overcome objections',
    category: C.EMOTIONAL,
    severity: S.MEDIUM,
    impact: [I.CONVERSION],
    effort: E.MEDIUM,
    confidence: CF.HIGH,
    implementationType: IT.CONTENT_CHANGE,
    check: p => !!(p.bodyHtml && p.bodyHtml.replace(/<[^>]*>/g, '').trim().length < 200),
    build: p => {
      const wordCount = Math.round(p.bodyHtml.replace(/<[^>]*>/g, '').trim().split(/\s+/).length);
      const type      = detectProductType(p);
      return {
        userHesitation: `There's barely any information here. I still don't know if this will work for my specific situation. I need to think about this more — maybe look at other options first.`,
        psychologicalTrigger: 'effort_justification — description length signals seller confidence in the product; a thin description implicitly communicates "we don\'t have much to say about this"; buyers mirror that confidence level',
        whyItMatters: `At ~${wordCount} words this description cannot handle objections, build desire, or justify the price. A buyer with a specific use case will not find their situation reflected here — so they leave to find a product that speaks to them directly.`,
        exactFix: {
          what: 'Expand to at least 300 words. Prioritise: (1) a specific outcome statement, (2) benefit bullets tied to real problems, (3) a use-case paragraph, (4) a guarantee close.',
          placement: 'Product description — primary content zone',
          uiElement: 'Structured HTML: bold lead sentence, bulleted list, 1–2 prose paragraphs, closing guarantee line',
          microcopy: [
            `"[Product] doesn't just [feature] — it [outcome the buyer actually wants]."\n\n• [Feature] → means [benefit for the buyer]\n• [Feature] → means [benefit for the buyer]\n• [Feature] → means [benefit for the buyer]\n\n"Perfect for [use case 1] and [use case 2]. Not right for [anti-use case — shows honesty]."\n\n"We back it with a 30-day no-questions return."`,
            type === 'health'
              ? `"Most people with [problem] try [common solution] first. It helps a little. [Product] was built for the cases where that's not enough — here's what's different: [mechanism]."` : '',
          ].filter(Boolean),
          type: 'copy',
          difficulty: 'medium',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'medium',
          fixType: 'structural',
          reasoning: 'Doubling description length from ~150 words to 300+ words gives the visitor enough information to resolve doubt and commit. The fix is free and permanent — it improves every visit from this point forward.',
        },
        priorityBucket: '1d',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: 300 words is still insufficient. Aim for 500–700. Buyers making larger decisions need more reassurance. Add dimensions, materials, warranty details, and an FAQ.'
          : type === 'impulse'
          ? 'Impulse: 200 words is fine if structured correctly. Focus on 3 punchy benefit bullets, not long paragraphs. Impulse buyers want to move fast — dense copy kills momentum.'
          : 'Default: 300 words minimum. Focus on benefit language, not feature language.',
      };
    },
  },

  {
    id: 'description_center_aligned',
    title: 'Description is center-aligned — signals unedited supplier copy',
    category: C.EMOTIONAL,
    severity: S.MEDIUM,
    impact: [I.CONVERSION, I.TRUST],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.CONTENT_CHANGE,
    check: p => !!(p.bodyHtml && p.bodyHtml.includes('text-align: center')),
    build: () => ({
      userHesitation: `This looks like it was copy-pasted directly from AliExpress. If the seller didn't bother editing their description, did they bother checking product quality? Can I trust this store?`,
      psychologicalTrigger: 'trust_collapse_via_formatting — center-aligned body copy is the single most recognisable visual fingerprint of unedited supplier content; experienced online shoppers pattern-match it instantly and downgrade their trust before reading a word',
      whyItMatters: 'Trust is assessed in 0.3 seconds on first glance. Center-aligned paragraphs signal "this store did not write this" — and a store that didn\'t write its own description probably didn\'t curate its own products. The entire brand credibility takes a hit from a CSS choice.',
      exactFix: {
        what: 'Remove all `text-align: center` inline styles from the description HTML. Left-align everything. If the description itself was supplier-sourced, rewrite the copy entirely while you\'re in there.',
        placement: 'Shopify Admin → Products → Description → HTML editor (the <> button)',
        uiElement: 'Plain left-aligned text — no special element needed',
        microcopy: [
          'Find in HTML: `style="text-align: center;"` → delete the style attribute entirely',
          'Find in HTML: `text-align: center` (inside any style tag) → remove',
          'After cleanup: read the description aloud. If it sounds like a translation, rewrite it.',
        ],
        type: 'copy',
        difficulty: 'easy',
      },
      businessImpact: {
        metric: 'cvr',
        magnitude: 'medium',
        fixType: 'quick_win',
        reasoning: 'A 2-minute HTML edit removes a trust-destroying visual signal that affects every single visitor who reads the description. The cost is near zero; the trust recovery is immediate.',
      },
      priorityBucket: '2h',
      productTypeNotes: 'All product types: same priority. Health and high-ticket products suffer more from this issue — credibility is more load-bearing when the purchase risk is higher. Fix immediately on any product where trust is a conversion factor.',
    }),
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRUST — social proof, guarantees, risk reversal, images
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'no_images',
    title: 'No product images — will not convert',
    category: C.TRUST,
    severity: S.CRITICAL,
    impact: [I.CONVERSION, I.TRUST],
    effort: E.HIGH,
    confidence: CF.HIGH,
    implementationType: IT.MERCHANT_ACTION,
    check: p => p.images.length === 0,
    build: () => ({
      userHesitation: `There is nothing to look at. I have no idea what I would actually be receiving. I am not spending money on something I cannot see.`,
      psychologicalTrigger: 'visual_validation — desire requires imagination; imagination requires images; without images there is no desire, no confidence, and no purchase',
      whyItMatters: 'A product page with no images does not convert. This is not a CRO issue — it is a prerequisite. Before any other optimisation, there must be something to look at.',
      exactFix: {
        what: 'Add a minimum of 4 images before making any other change to this product. Sequence matters: hero on white background → lifestyle in-use → feature/detail close-up → size or scale reference.',
        placement: 'Product image gallery — first image is the hero used in ads and collection thumbnails; it sets first impression',
        uiElement: 'Image gallery (Shopify native) — minimum 4, optimal 6–8',
        microcopy: [
          'Image 1 (hero): clean white or neutral background, full product visible, well-lit',
          'Image 2 (lifestyle): product in use by a person in a real setting — this is the "desire" image',
          'Image 3 (detail): close-up of the key feature or differentiator',
          'Image 4 (scale): product next to a recognisable object or on a hand/body for size reference',
          'Image 5+ (context): packaging, variants, secondary use cases',
        ],
        type: 'merchant_action',
        difficulty: 'medium',
      },
      businessImpact: {
        metric: 'cvr',
        magnitude: 'high',
        fixType: 'structural',
        reasoning: 'No images = no conversions. There is no other optimisation that applies until this is resolved. Adding 4 images is the entire revenue unlock for this product.',
      },
      priorityBucket: '1d',
      productTypeNotes: 'Fashion/wearable: lifestyle on-model is non-negotiable. Buyers need to see it worn. Flat lays convert significantly worse. Health: before/after framing in imagery (if applicable) dramatically increases desire. High-ticket: invest in professional photography — the image quality signals product quality at a price point where every trust signal matters.',
    }),
  },

  {
    id: 'no_risk_reversal',
    title: 'No guarantee or risk reversal — buyer carries 100% of the risk',
    category: C.TRUST,
    severity: S.HIGH,
    impact: [I.CONVERSION, I.TRUST],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.CONTENT_CHANGE,
    check: p => {
      if (!p.bodyHtml) return true;
      const t = p.bodyHtml.toLowerCase();
      return !['return', 'guarantee', 'refund', 'warranty', 'money back'].some(w => t.includes(w));
    },
    build: p => {
      const type  = detectProductType(p);
      const price = parseFloat(String(p.variants?.[0]?.price || 0));
      return {
        userHesitation: `What if it's not what I expected? What if it arrives and looks completely different? If I'm unhappy, am I just stuck with it? I've been burned before buying from stores I don't know.`,
        psychologicalTrigger: `loss_aversion — prospect theory states that the pain of a potential loss is 2.5× stronger than the pleasure of an equivalent gain; a $${price.toFixed(0)} purchase from an unknown brand carries the psychological weight of a potential $${(price * 2.5).toFixed(0)} loss`,
        whyItMatters: `Without a stated guarantee, the buyer carries 100% of the financial risk. For a brand they\'ve never purchased from before, that risk is real and rational. A guarantee doesn\'t just protect against returns — it signals that you are confident enough in your product to stand behind it. That confidence is contagious.`,
        exactFix: {
          what: 'Add a guarantee line as the final sentence of the description. Add a 3-icon trust bar directly below the Add to Cart button. Both changes together take under 10 minutes.',
          placement: '(1) Final line of description — the last thing read before deciding. (2) Trust bar: directly below the ATC button — at the moment of purchase friction.',
          uiElement: 'Text line in description + icon row (3 icons: shield/returns, truck/shipping, lock/security)',
          microcopy: [
            `--- End of description ---\n"${type === 'high_ticket' ? '60' : '30'}-day money-back guarantee. If it\'s not right for you, we\'ll refund you in full — no forms, no hassle."`,
            `--- Trust bar (below ATC) ---\n🛡 ${type === 'high_ticket' ? '60' : '30'}-Day Returns  |  🚚 Fast Dispatch  |  🔒 Secure Checkout`,
            type === 'health'
              ? `"We\'re so confident in the results that we offer a full refund if you don\'t notice a difference in ${type === 'health' ? '30' : '14'} days. No questions asked."`
              : `"Not happy for any reason? We make the return process completely painless."`,
          ],
          type: 'copy',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'quick_win',
          reasoning: `A guarantee is the highest-ROI text addition on any product page. It costs nothing to add, takes 5 minutes, and addresses the single biggest rational objection to buying from an unknown brand. In split tests, adding a visible guarantee consistently lifts CVR by 10–30%.`,
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: make the guarantee the centrepiece, not a footnote. "60-day risk-free trial." The length and prominence of the guarantee should match the size of the financial risk being reversed.'
          : type === 'health'
          ? 'Health: results-based guarantee outperforms satisfaction-based. "Notice a difference in 30 days or your money back" works better than "return it if unhappy" because it focuses on the outcome, not the product.'
          : type === 'fashion'
          ? 'Fashion: focus on fit and easy returns. "Free size exchange if it doesn\'t fit" is the specific fear being addressed — generalised guarantees are less powerful for fashion.'
          : 'Functional/impulse: a simple 30-day return policy stated plainly is sufficient. Keep it short and place it close to the ATC button.',
      };
    },
  },

  {
    id: 'no_social_proof',
    title: 'No social proof — buyer has no evidence others chose this product',
    category: C.TRUST,
    severity: S.HIGH,
    impact: [I.CONVERSION, I.TRUST],
    effort: E.LOW,
    confidence: CF.MEDIUM,
    implementationType: IT.APP_CONFIG,
    check: p => {
      if (!p.bodyHtml) return true;
      const t = p.bodyHtml.toLowerCase();
      return !['review', 'star', 'rated', 'customer', 'bought', 'verified', '★', '⭐'].some(w => t.includes(w));
    },
    build: p => {
      const type  = detectProductType(p);
      const price = parseFloat(String(p.variants?.[0]?.price || 0));
      return {
        userHesitation: `I've never heard of this store. There are no reviews anywhere. What if this product is terrible? What if this is a scam? I need to be able to trust this before I hand over my money.`,
        psychologicalTrigger: 'social_validation + trust_gap — for an unknown brand, the absence of social proof is equivalent to a negative signal; "no one is talking about this" reads as "no one bought this" or worse, "no one was satisfied enough to leave a review"',
        whyItMatters: `93% of consumers read reviews before purchasing from an unknown brand. At $${price.toFixed(0)}, this product asks the visitor to trust a brand they've never encountered with no external validation. Every competitor with visible reviews has a systematic advantage on this product.`,
        exactFix: {
          what: 'Install a reviews app (Judge.me free plan, or Loox for photo reviews). Enable the star rating widget next to the product title. Set up automated post-purchase review request emails. If you have existing customers, manually request reviews via email immediately.',
          placement: '(1) Star rating + count: directly below the product title — above the fold, before price. (2) Review list: at the bottom of the page. (3) Featured review pull-quote: midway through the description.',
          uiElement: 'Star rating widget (inline with title) + review count link + 2–3 highlighted review cards + full review section at page bottom',
          microcopy: [
            `"⭐⭐⭐⭐⭐  4.8 / 5  (${type === 'high_ticket' ? '47' : '312'} reviews)  →  Read reviews"`,
            `--- Featured review (pull-quote mid-description) ---\n"[Specific outcome the buyer experienced] — [First name, verified buyer, location optional]"`,
            `--- Post-purchase email ---\nSubject: "How is your ${p.title} working out?"\nBody: "You've had it for a week — we'd love to hear your honest thoughts. Takes 60 seconds. [Leave a Review →]"`,
            type === 'health'
              ? `"[Name] had [problem] for [duration]. After [time], [specific measurable result]. ★★★★★"`
              : type === 'high_ticket'
              ? `"I was hesitant at first — $${price.toFixed(0)} is not a small purchase. [Decision reasoning]. [What changed after buying]. Best decision I made. ★★★★★"`
              : `"Arrived fast, exactly as described. [One specific thing they noticed]. Would buy again. ★★★★★"`,
          ],
          type: 'app',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: type === 'high_ticket' || type === 'health' ? 'structural' : 'quick_win',
          reasoning: `Reviews function as borrowed credibility. Every review is a conversion asset that works 24/7. The compounding effect is significant: 10 reviews lift CVR; 100 reviews lift it further; a 4.8-star average becomes a brand signal. The app install takes 30 minutes. Collecting the first 10 reviews takes 1–2 weeks. This is the highest long-term ROI investment on this product page.`,
        },
        priorityBucket: '1w',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: video reviews or photo reviews (Loox) are worth the investment. A 30-second video review showing the product in use is worth 100 text reviews for converting $100+ decisions.'
          : type === 'health'
          ? 'Health: results-specific reviews convert best. Encourage reviewers to mention their specific problem and the specific outcome. "I had lower back pain for 3 years. After 2 weeks this is the first relief I\'ve had." is worth 10× a generic 5-star.'
          : type === 'fashion'
          ? 'Fashion: photo reviews are essential. Buyers want to see how it looks on a real person, not a model. Enable photo review uploads in your review app settings.'
          : 'All types: even 5–10 reviews dramatically reduce purchase friction. Prioritise volume first, quality second.',
      };
    },
  },

  {
    id: 'few_images',
    title: 'Fewer than 4 images — insufficient visual evidence',
    category: C.TRUST,
    severity: S.MEDIUM,
    impact: [I.CONVERSION, I.TRUST],
    effort: E.MEDIUM,
    confidence: CF.HIGH,
    implementationType: IT.MERCHANT_ACTION,
    check: p => p.images.length > 0 && p.images.length < 4,
    build: p => {
      const type = detectProductType(p);
      return {
        userHesitation: `I can see the product but I can\'t tell if it\'ll look right / fit properly / work in my situation. I need to see it from different angles, in use, with something for scale. This isn\'t enough to commit.`,
        psychologicalTrigger: 'visual_uncertainty — customers buy confidence, not products; each additional image increases time-on-page, emotional attachment, and the subjective sense of "I know what I\'m getting into"',
        whyItMatters: `Only ${p.images.length} image(s). High-converting product pages carry 6–8 images at minimum. Each missing image is a missing opportunity to resolve a visual objection. The images you don\'t have are the questions you\'re not answering.`,
        exactFix: {
          what: `Add to at least 6 images. Current gap: ${6 - p.images.length} images needed. Priority order: lifestyle-in-use → feature close-up → scale reference → packaging → benefits infographic.`,
          placement: 'Product image gallery — image sequence matters; hero first, lifestyle second (this is the desire image buyers spend most time on)',
          uiElement: 'Image gallery — Shopify native or enhanced with a zoom app',
          microcopy: [
            `Image sequence target:\n1. Hero (white/neutral bg, full product)\n2. Lifestyle (${type === 'fashion' ? 'on-model, in real setting' : type === 'health' ? 'in-use showing the problem being solved' : 'in real environment showing use'})\n3. Feature detail (close-up of the key selling point)\n4. Scale reference (product next to hand / person / common object)\n5. Packaging (builds perceived value, reduces "what am I getting" anxiety)\n6. Infographic (3–5 key benefits as visual callouts)`,
          ],
          type: 'merchant_action',
          difficulty: 'medium',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'medium',
          fixType: 'structural',
          reasoning: 'More images = more time on page = more emotional investment = higher conversion. The lifestyle image specifically generates desire that copy alone cannot create. Each new image is a permanent conversion asset.',
        },
        priorityBucket: '1w',
        productTypeNotes: type === 'fashion'
          ? 'Fashion: on-model lifestyle is non-negotiable. Flat lays are not sufficient for conversion. If you have one image, the most impactful second image is a person wearing it in a real, aspirational setting.'
          : type === 'health'
          ? 'Health: the "use case" image is your most important asset — show someone using the product in the exact situation your buyer is in. This creates immediate identification and desire.'
          : type === 'high_ticket'
          ? 'High-ticket: image quality signals product quality. A professionally shot photo is worth more conversion lift than 5 amateur phone shots. Invest in one professional session.'
          : 'Functional/impulse: scale reference is often the most underrated image — buyers need to know exact physical size before committing. Include this in every product.',
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // VALUE CLARITY — pricing, discounts, offer strength, anchoring
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'no_compare_price',
    title: 'No compare-at price — zero perceived saving',
    category: C.VALUE_CLARITY,
    severity: S.MEDIUM,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.MERCHANT_ACTION,
    check: p => p.variants.length > 0 && p.variants.every(v => !v.compareAtPrice),
    build: p => {
      const price     = parseFloat(String(p.variants[0]?.price || 0));
      const suggested = (price * 1.3).toFixed(2);
      const saving    = (price * 0.3).toFixed(2);
      const type      = detectProductType(p);
      return {
        userHesitation: `Is this a good price? Is this expensive for what it is? I have no idea if I\'m paying too much. Let me check Amazon or Google to see what this type of product normally costs.`,
        psychologicalTrigger: 'anchoring effect — the first number shown to a buyer sets their mental reference point for value; without an anchor, any price exists in a vacuum and the brain defaults to uncertainty; uncertainty defaults to "not buying"',
        whyItMatters: `Without a compare-at price, there is no price anchor. The visitor does not know if $${price.toFixed(0)} is a steal or overpriced — so they default to "I should research this," which means they leave. Adding a compare-at price costs nothing and activates the most powerful pricing lever available.`,
        exactFix: {
          what: `Set a compare-at price on all variants reflecting either the RRP, the pre-sale price, or the standard market price for this product category. Aim for a minimum 20% saving — below 15% is psychologically meaningless.`,
          placement: 'Price display area — compare-at appears as strikethrough directly above or beside the current price, immediately visible above the fold',
          uiElement: 'Strikethrough price (native Shopify) + optional "SAVE $X" text badge (theme setting or CSS)',
          microcopy: [
            `Current: $${price.toFixed(2)}\nSuggested compare-at: $${suggested}  (creates 23% saving)\nResult on page: ~~$${suggested}~~  $${price.toFixed(2)}  SAVE $${saving}`,
            `Add below price: "You save $${saving} today — sale price ends [date or 'soon']"`,
            type === 'high_ticket'
              ? `High-ticket anchor copy: "RRP $${suggested} — our price: $${price.toFixed(2)}. Same product, direct from us."` : '',
          ].filter(Boolean),
          type: 'merchant_action',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'medium',
          fixType: 'quick_win',
          reasoning: 'The compare-at price is a 5-minute Shopify Admin change that activates price anchoring — one of the most well-documented consumer psychology effects. The visitor stops asking "is this expensive?" and starts thinking "how much am I saving?" That mental shift dramatically increases purchase likelihood.',
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: anchoring is more powerful at higher price points — the absolute saving ($30 off a $130 product) feels more significant. Use "RRP" or "regular price" framing to add legitimacy to the anchor.'
          : type === 'impulse'
          ? 'Impulse: the visual of a strikethrough price is enough — buyers do not calculate carefully at low price points. The perception of "sale" is the conversion trigger, not the specific amount.'
          : 'All types: ensure the compare-at is credible. An implausibly high anchor (50%+ off a standard product) is recognisable as artificial and can backfire by reducing trust.',
      };
    },
  },

  {
    id: 'weak_discount',
    title: 'Discount under 15% — insufficient to drive decisions',
    category: C.VALUE_CLARITY,
    severity: S.MEDIUM,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.MEDIUM,
    implementationType: IT.MERCHANT_ACTION,
    check: p => {
      const v = p.variants.find(v => v.compareAtPrice);
      if (!v) return false;
      const pct = ((parseFloat(String(v.compareAtPrice)) - parseFloat(String(v.price))) / parseFloat(String(v.compareAtPrice))) * 100;
      return pct > 0 && pct < 15;
    },
    build: p => {
      const v       = p.variants.find(v => v.compareAtPrice);
      const price   = parseFloat(String(v.price));
      const compare = parseFloat(String(v.compareAtPrice));
      const pct     = Math.round(((compare - price) / compare) * 100);
      const saving  = (compare - price).toFixed(2);
      const type    = detectProductType(p);
      return {
        userHesitation: `${pct}% off? That\'s barely anything. I\'m not going to go out of my way to buy this just because of a tiny discount. I\'ll wait for a real sale.`,
        psychologicalTrigger: 'deal_threshold — the brain does not respond proportionally to discount percentages; discounts below ~15% are effectively invisible as motivators; buyers only feel the emotional pull of "deal" when the saving reaches a meaningful threshold',
        whyItMatters: `${pct}% off ($${saving}) does not cross the psychological threshold where a discount changes a decision. It uses up the customer\'s "sale" expectation without delivering the emotional payoff. Either the discount earns its role as a conversion driver, or it should be replaced with a value-add framing instead.`,
        exactFix: {
          what: `Option A: Raise compare-at price to create a 20–25% saving on the current sale price.\nOption B: Add a value-add bundle ("includes FREE [accessory]") at the same price — reframes the offer without changing economics.\nOption C: Reframe as a time-limited launch price ("Launch price — returns to $${compare.toFixed(2)} on [date]").`,
          placement: 'Price display area + optional urgency line below price',
          uiElement: 'Strikethrough price + "SAVE X%" badge + urgency line',
          microcopy: [
            `Option A: ~~$${(price / 0.75).toFixed(2)}~~  $${price.toFixed(2)}  SAVE 25%`,
            `Option B: "Includes FREE [accessory] (worth $${(price * 0.2).toFixed(0)}) — bundle price: $${price.toFixed(2)}"`,
            `Option C: "Launch price — returns to $${compare.toFixed(2)} when sale ends. ${type === 'impulse' ? 'Today only.' : 'Limited time.'}"`,
          ],
          type: 'merchant_action',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'low',
          fixType: 'quick_win',
          reasoning: 'A weak discount is worse than no discount in some cases — it sets a "sale" expectation that it fails to satisfy. Making the discount meaningful (20%+) or replacing it with a value-add framing converts the pricing section from neutral to active.',
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: at higher prices, even a 10% discount represents a significant absolute saving. Feature the dollar amount prominently ("SAVE $30") rather than the percentage to maximise impact.'
          : type === 'impulse'
          ? 'Impulse: percentage matters less than the visual signal. A "SALE" badge on an impulse product with any discount creates purchase momentum. Focus on the badge, not the math.'
          : 'Default: 20%+ is the target. Below that, switch to value-add framing (bundle, bonus, accessory).',
      };
    },
  },

  {
    id: 'strong_discount_not_featured',
    title: 'Strong discount (20%+) hidden in plain sight — saving goes unnoticed',
    category: C.VALUE_CLARITY,
    severity: S.HIGH,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.MEDIUM,
    implementationType: IT.THEME_PATCH,
    check: p => {
      const v = p.variants.find(v => v.compareAtPrice);
      if (!v) return false;
      const pct = ((parseFloat(String(v.compareAtPrice)) - parseFloat(String(v.price))) / parseFloat(String(v.compareAtPrice))) * 100;
      return pct >= 20;
    },
    build: p => {
      const v       = p.variants.find(v => v.compareAtPrice);
      const price   = parseFloat(String(v.price));
      const compare = parseFloat(String(v.compareAtPrice));
      const pct     = Math.round(((compare - price) / compare) * 100);
      const saving  = (compare - price).toFixed(2);
      const type    = detectProductType(p);
      return {
        userHesitation: `I see two numbers next to each other. I\'d have to do the maths to figure out how much I\'m saving, and I\'m not going to do that. The price just looks... normal.`,
        psychologicalTrigger: 'loss_aversion amplification — two numbers side by side require mental processing; explicit "you save $X" framing bypasses calculation and directly activates loss aversion ("I will lose this $${saving} saving if I don\'t act now"); framing the saving as a loss to avoid is more powerful than framing it as a gain',
        whyItMatters: `${pct}% off ($${saving}) is a genuinely strong offer — but it is being wasted. Visitors will not do the subtraction. The page must do it for them and then name the emotional consequence of not acting.`,
        exactFix: {
          what: `Add an explicit "SAVE $${saving}" badge next to or above the price. Add an urgency line immediately below the price. Shopify\'s native sale badge ("Sale") is too weak — replace or supplement it.`,
          placement: 'Price area — badge immediately beside the price, above or inline. Urgency line directly below the price, before the variant selector.',
          uiElement: 'Red/orange savings badge ("SAVE $X") + urgency text line + optional countdown timer',
          microcopy: [
            `[Badge, bold, coloured]: SAVE $${saving} — ${pct}% OFF`,
            `~~$${compare.toFixed(2)}~~  $${price.toFixed(2)}`,
            `"Sale price — this offer ends [date or 'soon']. After that, it returns to $${compare.toFixed(2)}."`,
            type === 'high_ticket'
              ? `"You\'re saving $${saving} on this purchase. That\'s your [accessory / subscription / next order] covered."` : '',
          ].filter(Boolean),
          type: 'ui',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'quick_win',
          reasoning: `You already have a compelling offer. The revenue leak here is pure presentation — the saving is real but invisible. Making it explicit with a badge and urgency line costs nothing and converts an already-strong offer into an active purchase driver.`,
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: the absolute saving amount ($30, $50, $100) is more motivating than the percentage. Lead with the dollar figure: "SAVE $50 TODAY."'
          : type === 'impulse'
          ? 'Impulse: both the badge and a countdown timer work extremely well at impulse price points. The combination of visible saving + time pressure is the highest-converting urgency pattern.'
          : 'All types: if you have a sale, shout about it. Subtle discounts convert worse than confident, explicit ones.',
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // URGENCY — scarcity, time pressure, action triggers
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'no_urgency',
    title: 'No urgency signals — visitors have no reason to act now',
    category: C.URGENCY,
    severity: S.HIGH,
    impact: [I.CONVERSION],
    effort: E.LOW,
    confidence: CF.MEDIUM,
    implementationType: IT.APP_CONFIG,
    // Fires for all active products regardless of stock — OOS still needs back-in-stock urgency
    check: p => p.status === 'active',
    build: p => {
      const allOos   = p.variants.every(v => !v.availableForSale);
      const lowStock = p.variants.find(v => v.availableForSale && v.inventoryQuantity !== null && v.inventoryQuantity <= 10);
      const type     = detectProductType(p);

      if (allOos) {
        return {
          userHesitation: `Out of stock. Oh well. Maybe I\'ll check back another time.`,
          psychologicalTrigger: 'opportunity_loss_unrecognized — the desire exists but there is no mechanism to hold it; without a capture point, the visitor\'s purchase intent evaporates within hours and they forget about the product entirely',
          whyItMatters: 'Every visitor who leaves an OOS product page without signing up for restock notification is a permanently lost customer. The purchase intent they arrived with is the most valuable thing on this page — and right now it is being let go with nothing in return.',
          exactFix: {
            what: 'Install Back in Stock – Restock Alerts. Add urgency copy to the notification form to increase sign-up rate. Email the list immediately on restock with a time-limited offer.',
            placement: 'Replace the Add to Cart area entirely — notification form should be the primary action above the fold',
            uiElement: 'Email capture form with urgency headline + social proof reinforcement ("X people waiting")',
            microcopy: [
              `🔔 NOTIFY ME WHEN BACK IN STOCK\n[email]\n"⚡ We\'re restocking soon — limited units. Sign up to be first in line."`,
              `"${type === 'fashion' ? '347' : '124'} people are waiting for this to come back. Be first."`,
              `--- Restock email ---\nSubject: "Your ${p.title} is back — we only have ${type === 'high_ticket' ? '10' : '50'} units"\n\n"You asked us to notify you. It\'s back. But stock is limited — here\'s 10% off to secure yours in the next 24 hours."`,
            ],
            type: 'app',
            difficulty: 'easy',
          },
          businessImpact: {
            metric: 'cvr',
            magnitude: 'high',
            fixType: 'quick_win',
            reasoning: 'Restock email lists convert at 10–15% when activated — dramatically higher than any cold traffic. This is the highest-ROI capture mechanism available when a product is out of stock. Without it, 100% of OOS visitor intent is wasted.',
          },
          priorityBucket: '2h',
          productTypeNotes: type === 'high_ticket'
            ? 'High-ticket: frame notification as exclusive access — "reserve your unit from the next restock." Exclusivity justifies the high-intent action of leaving an email.'
            : type === 'fashion'
            ? 'Fashion: allow size-specific notification sign-up. "Notify me when my size (M) comes back" dramatically increases sign-up relevance and rate.'
            : 'All types: add social proof to the notification form — "X people already waiting" converts passive abandonment into active sign-up.',
        };
      }

      return {
        userHesitation: `This looks interesting. I\'ll think about it and maybe come back to buy it later. There\'s no rush.`,
        psychologicalTrigger: 'status_quo_bias — the path of least resistance is always inaction; "come back later" is the default escape route; studies show 95%+ of visitors who leave without purchasing never return; urgency creates a real cost to waiting',
        whyItMatters: 'Without any urgency signal, there is no cost to delay. "I\'ll think about it" is the most common conversion killer — and it is almost never followed through. A visitor who leaves without buying is, statistically, gone forever.',
        exactFix: {
          what: lowStock
            ? `Display the real inventory number as a low-stock counter. You have genuine scarcity (${lowStock.inventoryQuantity} units). Use it.`
            : 'Install an urgency app (Hurrify, or the free urgency features in most conversion apps). Add a shipping cutoff timer and a social proof activity counter.',
          placement: 'Below variant selector, above Add to Cart — this is the last interaction point before the purchase decision',
          uiElement: lowStock
            ? 'Inline stock counter with warning colour ("Only 7 left") + optional animated icon'
            : 'Shipping cutoff timer ("Order in 2h 14m for same-day dispatch") + social proof counter ("12 sold in last 24h")',
          microcopy: lowStock
            ? [
                `"⚠️ Only ${lowStock.inventoryQuantity} left in stock — order soon"`,
                `"🔥 Selling fast — ${lowStock.inventoryQuantity} remaining"`,
                `"Low stock alert: only ${lowStock.inventoryQuantity} ${lowStock.title !== 'Default Title' ? `(${lowStock.title})` : ''} available"`,
              ]
            : [
                `"🚚 Order in the next 2h 14m — dispatched today"`,
                `"🔥 ${type === 'high_ticket' ? '3' : '12'} sold in the last 24 hours"`,
                type === 'high_ticket' ? `"Last ${Math.floor(Math.random() * 3) + 2} units available at this price"` : `"⚡ Popular item — stock may not last"`,
              ],
          type: 'app',
          difficulty: 'easy',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'quick_win',
          reasoning: 'Urgency signals consistently lift CVR by 10–20% in A/B tests. They work because they change the frame from "passive browsing" to "time-sensitive decision." An app install takes 30 minutes and provides permanent conversion lift on every product page.',
        },
        priorityBucket: '2h',
        productTypeNotes: type === 'high_ticket'
          ? 'High-ticket: stock-based scarcity ("last 3 available") works better than time-based urgency. High-ticket buyers are more suspicious of fake countdown timers but respond strongly to genuine unit scarcity.'
          : type === 'fashion'
          ? 'Fashion: size-specific scarcity is the most credible form of urgency ("Only 1 Medium left"). This also communicates demand for the product. Always true even without an app — just display the variant inventory.'
          : type === 'impulse'
          ? 'Impulse: countdown timer + "X sold today" is the highest-converting combination at impulse price points. The combination of time pressure and social proof creates powerful FOMO.'
          : 'Functional: shipping urgency ("order today, delivered by [day]") is more credible than fabricated scarcity for functional products — it links urgency to a real benefit (getting it faster).',
      };
    },
  },

  {
    id: 'low_inventory_unused',
    title: 'Low inventory — real scarcity data not displayed',
    category: C.URGENCY,
    severity: S.HIGH,
    impact: [I.CONVERSION],
    effort: E.MEDIUM,
    confidence: CF.HIGH,
    implementationType: IT.THEME_PATCH,
    check: p =>
      p.variants.some(v => v.availableForSale && v.inventoryQuantity !== null && v.inventoryQuantity > 0 && v.inventoryQuantity <= 10),
    build: p => {
      const lowVariants = p.variants.filter(v => v.availableForSale && v.inventoryQuantity !== null && v.inventoryQuantity <= 10);
      const type        = detectProductType(p);
      return {
        userHesitation: `I could buy this anytime. It\'s not going anywhere. I\'ll think about it.`,
        psychologicalTrigger: 'abundance_assumption — when no scarcity is communicated, the visitor assumes unlimited availability; this removes all cost to delay; displaying real inventory data replaces that assumption with genuine urgency',
        whyItMatters: `You have real, data-backed scarcity: ${lowVariants.map(v => `${v.title !== 'Default Title' ? v.title : 'stock'}: ${v.inventoryQuantity} remaining`).join(', ')}. Not surfacing this is the same as hiding revenue. Visitors who would have been triggered by genuine scarcity are leaving because you didn\'t tell them.`,
        exactFix: {
          what: 'Add a conditional stock counter to the product template: show "Only X left" when inventory drops below 10 for any available variant. This is a one-time theme code edit that activates permanently for all products.',
          placement: 'Below variant selector, above Add to Cart — the last interaction point before the purchase decision',
          uiElement: 'Inline text with warning styling (amber/red colour, optionally with icon or animation)',
          microcopy: lowVariants.map(v =>
            v.title !== 'Default Title'
              ? `"⚠️ ${v.title} — Only ${v.inventoryQuantity} left. Order soon."`
              : `"⚠️ Only ${v.inventoryQuantity} left in stock. Order soon."`
          ),
          type: 'code',
          difficulty: 'medium',
        },
        businessImpact: {
          metric: 'cvr',
          magnitude: 'high',
          fixType: 'structural',
          reasoning: 'Real scarcity is the most credible urgency trigger available — it cannot be faked and visitors know it. A live stock counter on a product with genuine low inventory is one of the highest-ROI conversion elements on any product page.',
        },
        priorityBucket: '1d',
        productTypeNotes: type === 'fashion'
          ? 'Fashion: show per-variant stock. "Only 1 Size M left" is 10× more urgent and credible than "low stock." The buyer knows their size is specifically running out.'
          : type === 'high_ticket'
          ? 'High-ticket: "last 3 available at this price" framing adds both scarcity and price anchoring. Implies the price may change when stock is refilled.'
          : 'All types: the stock counter only displays below 10 units. When inventory is replenished above 10, it hides automatically. Credibility is maintained because it is always true.',
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // AOV — bundles, upsells, volume pricing
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'no_bundle_pricing',
    title: 'No bundle or volume pricing — AOV capped at single unit',
    category: C.AOV,
    severity: S.MEDIUM,
    impact: [I.AOV],
    effort: E.MEDIUM,
    confidence: CF.MEDIUM,
    implementationType: IT.MERCHANT_ACTION,
    check: p => p.status === 'active' && p.variants.length <= 4,
    build: p => {
      const price       = parseFloat(String(p.variants[0]?.price || 0));
      const bundlePrice = (price * 1.82).toFixed(2);
      const bundleSave  = (price * 0.18).toFixed(2);
      const type        = detectProductType(p);
      return {
        userHesitation: `I just need one for now. If I like it I might order more later.`,
        psychologicalTrigger: 'decision_already_made — the visitor who is about to buy has already overcome the hardest barrier (deciding to purchase); at this moment their resistance to spending more is at its lowest; a bundle offer captures that state; a visitor who "comes back for more" statistically never does',
        whyItMatters: `Every order is capped at $${price.toFixed(2)}. There is no upsell, no quantity incentive, no reason to buy more than one. Customers in a buy state are 5× more likely to accept an offer than cold visitors — and this product offers them nothing extra. That is a systematic AOV leak on every transaction.`,
        exactFix: {
          what: 'Add a 2-pack or multi-pack option using volume pricing variants. Shopify native: duplicate product + bundle app (Bundler is free). Price the 2-pack at approximately 9% off double the single price — enough to incentivise, not enough to erode margin.',
          placement: 'Above Add to Cart, below variant selector — radio button quantity selector with "Best Value" callout on the 2-pack',
          uiElement: 'Radio button or pill selector: 1× (single price) | 2× (bundle price, "Best Value" badge) | 3× (deepest price)',
          microcopy: [
            `○ 1x  $${price.toFixed(2)}\n● 2x  $${bundlePrice}  ← BEST VALUE  (save $${bundleSave})\n\n"${type === 'health' ? 'One for the gym, one for home.' : type === 'fashion' ? 'One for you — one to gift.' : type === 'impulse' ? 'Stock up and save.' : 'Buy two, save on both.'}"`,
            `"Most customers buy 2 — ${type === 'health' ? 'one per treatment area' : type === 'impulse' ? 'one to keep, one to gift' : 'one now, one later'}"`,
            `"💡 Pro tip: our customers who order 2 save on shipping and always have a spare ready"`,
          ],
          type: 'merchant_action',
          difficulty: 'medium',
        },
        businessImpact: {
          metric: 'aov',
          magnitude: 'medium',
          fixType: 'structural',
          reasoning: 'A bundle option on every product page lifts AOV on the fraction of buyers who take it (typically 15–25%) without reducing CVR on those who do not. It is pure additional revenue on buyers who were already going to purchase. The annualised revenue impact compounds across every transaction.',
        },
        priorityBucket: '1d',
        productTypeNotes: type === 'health'
          ? 'Health: frame the second unit as a completion mechanism, not a duplicate — "one for home, one for travel" or "your backup unit." Removes the "I only need one" objection by making each unit serve a distinct purpose.'
          : type === 'fashion'
          ? 'Fashion: "one to keep, one to gift" or "different colour for each outfit." Framing matters — buyers don\'t want to feel like they\'re buying excess inventory.'
          : type === 'high_ticket'
          ? 'High-ticket: bundles work less well at higher price points. Consider "add an accessory" or "extended warranty" instead — these increase AOV without requiring two of the same high-cost item.'
          : type === 'impulse'
          ? 'Impulse: highest bundle conversion of all product types. "Stock up and save" is a credible, friction-free reason to buy 3 at once at sub-$30 price points.'
          : 'Functional: "replacement pack" or "starter kit" framing. Buying the product + consumables / accessories together removes friction from future repurchase.',
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CONSISTENCY — formatting, alt text, naming, brand coherence
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'missing_alt_text',
    title: 'All images missing alt text — invisible to Google Images',
    category: C.CONSISTENCY,
    severity: S.LOW,
    impact: [I.SEO],
    effort: E.LOW,
    confidence: CF.HIGH,
    implementationType: IT.CONTENT_CHANGE,
    check: p => p.images.length > 0 && p.images.every(img => !img.altText),
    build: p => ({
      userHesitation: 'Not a direct conversion issue — this is an SEO leak, not a buyer hesitation. However: missing alt text on images reduces Google Images indexability, screen reader accessibility, and structured data completeness.',
      psychologicalTrigger: 'trust_signal_via_completeness — while not a psychological trigger for individual buyers, completeness of product data signals professionalism to search algorithms and affects organic discoverability',
      whyItMatters: `All ${p.images.length} images have no alt text. Google Images cannot index them by keyword. Screen readers describe them as nothing. This is a permanent, zero-cost SEO leak that compounds over time as the product page fails to rank for image searches.`,
      exactFix: {
        what: 'Add descriptive alt text to each image. Include the product name, key feature, and context. Takes 2 minutes per image.',
        placement: 'Shopify Admin → Products → click each image thumbnail → Alt text field (below the image in the editor)',
        uiElement: 'Admin action only — no frontend change visible to customers',
        microcopy: [
          `Image 1 (hero): "${p.title} — product on white background"`,
          `Image 2 (lifestyle): "${p.title} in use — [brief description of scene]"`,
          `Image 3 (detail): "${p.title} — [feature being shown] close-up"`,
          `Image 4 (scale): "${p.title} — size reference"`,
          'Rule: be descriptive and specific. Include the product name in every alt text. Avoid "image of" — Google ignores that phrase.',
        ],
        type: 'copy',
        difficulty: 'easy',
      },
      businessImpact: {
        metric: 'cvr',
        magnitude: 'low',
        fixType: 'quick_win',
        reasoning: 'Alt text affects Google Images rankings and organic search visibility. While not a direct on-page conversion driver, it compounds over time as more image searches land on these products. Batch this task — do all products in one sitting.',
      },
      priorityBucket: '1w',
      productTypeNotes: 'Batch this task across all products in a single session. Do not make this a blocker for more impactful conversion fixes. Schedule it as a 30-minute admin task separate from all other CRO work.',
    }),
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CONVERSION — desire creation, emotional engagement
  // ══════════════════════════════════════════════════════════════════════════

  {
    id:                 'weak_desire_creation',
    title:              'Description creates recognition but not desire — buyer never imagines the outcome',
    category:           'conversion',
    surface:            'pdp',
    severity:           S.HIGH,
    impact:             [I.CONVERSION],
    effort:             E.MEDIUM,
    confidence:         CF.MEDIUM,
    implementationType: IT.CONTENT_CHANGE,

    // ── Detection signals ─────────────────────────────────────────────────
    // Each signal targets a specific structural or linguistic failure pattern.
    // Weighted: sum ≥ 4 of 8 possible points → issue fires.
    // Returns: { triggered: bool, signals: string[], score: number } | null
    check(product) {
      const raw  = (product.bodyHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

      // Not enough text to evaluate reliably
      if (raw.length < 150) return null;

      const text = raw.toLowerCase();

      // First ~200 words of plain text (used for early-content signals)
      const first200chars = raw.slice(0, 1200);

      const SIGNALS = [
        {
          id:     'features_before_desire',
          weight: 2,
          fired:  () => {
            // Feature list (bullet or spec pattern) appears in first 200 words
            return /(\d+\s*(temperature|level|speed|watt|volt|amp|hz|cm|mm|inch|kg|lb|hour|hr|min)s?\b)|(<li\b|^\s*•|\n-\s)/i
              .test(first200chars);
          },
        },
        {
          id:     'no_future_pacing',
          weight: 2,
          fired:  () => {
            return !/(imagine|picture (this|yourself)|within \d+|by (tonight|tomorrow|morning)|finally\b|once you|after (just|only)\b|from (day one|the first))/i
              .test(text);
          },
        },
        {
          id:     'no_sensory_language',
          weight: 1,
          fired:  () => {
            return !/(feel|warm|cozy|cosy|soft|smooth|comfort|relief|sooth|relax|calm|quiet|silence|peace|fresh|crisp|glow|melt|sink|wrap|envelop|breathe|ease)/i
              .test(text);
          },
        },
        {
          id:     'no_outcome_sentence',
          weight: 1,
          fired:  () => {
            return !/(you(\'ll| will)\b|your .{3,30} will\b|so you can\b|means you\b|lets you\b|allows you\b|enables you\b|helps you\b)/i
              .test(text);
          },
        },
        {
          id:     'spec_pivot_early',
          weight: 2,
          fired:  () => {
            // Spec-like pattern appears within first 4 sentences
            const sentences = raw.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
            const earlyBody = sentences.slice(0, 4).join(' ');
            return /\d+\s*(temperature|level|speed|watt|cm|mm|kg|lb|hz|°|%)|(?:lcd|display|digital|auto[\s-]?(off|shutoff)|silent\b|\bdb\b)/i
              .test(earlyBody);
          },
        },
      ];

      const firedSignals = SIGNALS.filter(s => s.fired());
      const score        = firedSignals.reduce((sum, s) => sum + s.weight, 0);
      const maxScore     = SIGNALS.reduce((sum, s) => sum + s.weight, 0); // 8

      if (score >= 4) return { triggered: true,  signals: firedSignals.map(s => s.id), score, maxScore };
      if (score >= 2) return { triggered: false,  signals: firedSignals.map(s => s.id), score, maxScore };
      return             { triggered: false,  signals: [], score, maxScore };
    },

    // ── Build ─────────────────────────────────────────────────────────────
    build(product) {
      const raw      = (product.bodyHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const text     = raw.toLowerCase();

      // Re-run signals to get evidence for build output
      const first200chars = raw.slice(0, 1200);
      const evidenceMap   = {
        features_before_desire: {
          signal:  'features_before_desire',
          detail:  'Feature list or spec pattern detected within first 200 words — page shifts buyer into analytical mode before desire is established',
        },
        no_future_pacing: {
          signal:  'no_future_pacing',
          detail:  'No future-pacing language found ("imagine", "picture this", "within X minutes", "finally", "once you") — buyer is never placed inside the post-purchase outcome',
        },
        no_sensory_language: {
          signal:  'no_sensory_language',
          detail:  'No sensory or physical-experience words found — description communicates information, not feeling',
        },
        no_outcome_sentence: {
          signal:  'no_outcome_sentence',
          detail:  'No outcome sentence found ("you\'ll", "so you can", "means you", "helps you") — transformation is implied at best, never stated',
        },
        spec_pivot_early: {
          signal:  'spec_pivot_early',
          detail:  'Spec-like content detected in first 4 sentences — emotional window closes before desire is created',
        },
      };

      const activeEvidence = [];
      if (/(\d+\s*(temperature|level|speed|watt|volt|amp|hz|cm|mm|inch|kg|lb|hour|hr|min)s?\b)|(<li\b|^\s*•|\n-\s)/i.test(first200chars))
        activeEvidence.push(evidenceMap.features_before_desire);
      if (!/(imagine|picture (this|yourself)|within \d+|by (tonight|tomorrow|morning)|finally\b|once you|after (just|only)\b|from (day one|the first))/i.test(text))
        activeEvidence.push(evidenceMap.no_future_pacing);
      if (!/(feel|warm|cozy|cosy|soft|smooth|comfort|relief|sooth|relax|calm|quiet|silence|peace|fresh|crisp|glow|melt|sink|wrap|envelop|breathe|ease)/i.test(text))
        activeEvidence.push(evidenceMap.no_sensory_language);
      if (!/(you(\'ll| will)\b|your .{3,30} will\b|so you can\b|means you\b|lets you\b|allows you\b|enables you\b|helps you\b)/i.test(text))
        activeEvidence.push(evidenceMap.no_outcome_sentence);
      const _specSentences = raw.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
      const _earlyBody     = _specSentences.slice(0, 4).join(' ');
      if (/\d+\s*(temperature|level|speed|watt|cm|mm|kg|lb|hz|°|%)|(?:lcd|display|digital|auto[\s-]?(off|shutoff)|silent\b|\bdb\b)/i.test(_earlyBody))
        activeEvidence.push(evidenceMap.spec_pivot_early);

      const generatedFix = generateDesireBlock(product);

      return {
        scoreImpact: -12,

        evidence: activeEvidence,

        recommendedFix: {
          key:       'insert_desire_block',
          type:      'CONTENT_CHANGE',
          placement: 'between_pain_and_features',
          format:    'one_paragraph',
          elements:  ['specific_moment', 'time_reference', 'sensory_language', 'pain_removal', 'positive_outcome'],
        },

        generatedFix,

        userHesitation:       'I can see what this product does, but I don\'t feel why I need it right now. I\'m not excited. I\'ll think about it.',
        psychologicalTrigger: 'premature_analytical_mode — description shifts buyer from emotional state to feature evaluation before desire is established; analytical mode activates comparison shopping and default-to-inaction',
        whyItMatters:         'The description names the problem correctly but never renders the outcome. The buyer briefly recognises their situation and then the page stops speaking to them. Without an imagined post-purchase future, there is no desire — and without desire, trust and urgency have nothing to unlock.',

        exactFix: {
          what:      'Insert one paragraph between the opening pain hook and the first feature bullet. The paragraph must make the buyer feel the outcome before they are asked to evaluate the product.',
          placement: 'After the opening hook paragraph, before the first feature list or spec-heavy paragraph',
          uiElement: 'Plain prose paragraph — no bullets, no formatting, second-person, present or near-future tense',
          microcopy: [
            'Use the generatedFix.bestGuess.content field for a ready-to-use paragraph specific to this product.',
            'Rule: must include a specific moment (time/place), at least one sensory word, and a sentence where the pain stops.',
          ],
          type:       'copy',
          difficulty: 'medium',
        },

        businessImpact: {
          metric:    'cvr',
          magnitude: 'high',
          fixType:   'structural',
          reasoning: 'Cold traffic converts when desire exceeds perceived risk. This fix increases the desire ceiling — meaning trust signals and guarantees downstream become effective instead of irrelevant. Without desire, no other CRO fix on this page reaches its potential.',
        },

        priorityBucket: '1d',

        productTypeNotes: 'High-ticket: the desire paragraph must be longer and more specific — bigger purchase = more imagination required. Health products: lead with the pain state, then the absence of it — buyers are motivated by relief, not aspiration. Impulse products: one sentence is enough; the desire window is short but high-intensity.',
      };
    },
  },

];

module.exports = { RULES };
