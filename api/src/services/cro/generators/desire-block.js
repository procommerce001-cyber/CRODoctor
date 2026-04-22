'use strict';

// ---------------------------------------------------------------------------
// desire-block.js
//
// Fix generator for the weak_desire_creation rule.
//
// Architecture:
//   Compositional, not template-based.
//   Each paragraph is assembled from semantic role fragments:
//     anchor     → establishes the specific moment
//     tension    → the before-state still present
//     pivot      → what changes and when
//     resolution → the after-state
//     closer     → quiet realisation (optional, adds texture)
//
//   Each role has a fragment pool. The selector picks from the pool
//   using a lightweight hash of product data — so:
//     - same product → same two variants (reproducible)
//     - different products → different structure and fragment picks
//     - two variants are built from offset slot selections
//
//   The result varies in structure (role order), fragment choice, and
//   sentence rhythm. It does not repeat the product name. It avoids
//   marketing openers unless they are structurally unavoidable.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// productHash — deterministic integer from product title + price
// ---------------------------------------------------------------------------
function productHash(product) {
  const seed = `${product.title || ''}${product.variants?.[0]?.price || ''}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// extractSignals — pull semantic tokens from product data
// ---------------------------------------------------------------------------
function extractSignals(product) {
  const raw  = (product.bodyHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const text = raw.toLowerCase();

  let setting = null;
  if (/(office|desk|work from home|wfh|working)/i.test(text))         setting = 'desk';
  else if (/(sofa|couch|lounge|living room)/i.test(text))             setting = 'sofa';
  else if (/(bedroom|bed|sleep|night)/i.test(text))                   setting = 'bedroom';
  else if (/(gym|workout|training|exercise)/i.test(text))             setting = 'gym';
  else if (/(kitchen|cook|meal|prep)/i.test(text))                    setting = 'kitchen';
  else if (/(travel|commute|car|on the go|portable)/i.test(text))     setting = 'travel';

  let pain = null;
  const painMap = [
    [/(cold feet|cold toes|freezing feet|icy feet)/,           'cold feet'],
    [/(cold legs|cold lower body)/,                            'cold legs'],
    [/(back pain|lower back|back ache)/,                       'back pain'],
    [/(neck pain|neck ache|neck tension)/,                     'neck pain'],
    [/(poor posture|slouch|hunching)/,                         'bad posture'],
    [/(tired|fatigue|exhausted|drained)/,                      'fatigue'],
    [/(dry skin|dull skin|rough skin)/,                        'dry skin'],
    [/(dead phone|low battery|running out of battery)/,        'dead battery'],
    [/(muscle (pain|soreness|ache)|sore muscles)/,             'muscle soreness'],
    [/(poor sleep|can't sleep|trouble sleeping|insomnia)/,     'poor sleep'],
    [/(clutter|mess|disorganized|disorganised)/,               'clutter'],
    [/(shiver|freezing|cold|chilly)/,                          'the cold'],
  ];
  for (const [pattern, label] of painMap) {
    if (pattern.test(text)) { pain = label; break; }
  }

  let timeOfDay = null;
  if (/(morning|wake up|start the day|first thing)/i.test(text))     timeOfDay = 'morning';
  else if (/(evening|after work|end of the day|unwind)/i.test(text)) timeOfDay = 'evening';
  else if (/(winter|january|december|freezing outside)/i.test(text)) timeOfDay = 'winter';
  else if (/(night|before bed|late)/i.test(text))                    timeOfDay = 'night';

  let onset = null;
  const onsetMatch = raw.match(/(?:within\s+)?(\d+\s*(?:seconds?|minutes?|mins?))/i);
  if (onsetMatch) onset = onsetMatch[0].replace(/^within\s+/i, '');
  else if (/(instantly|immediately|straight away|right away)/i.test(text)) onset = 'seconds';

  let profile = 'generic';
  const corpus = text + (product.title || '').toLowerCase();
  if (/(warm|heat|cold feet|cold legs|thermal|leg warmer|foot warmer)/i.test(corpus))
    profile = 'thermal';
  else if (/(back|posture|spine|neck|shoulder|muscle|relief|recovery|corrector|support)/i.test(corpus))
    profile = 'pain_relief';
  else if (/(skin|serum|moistur|glow|radiant|complexion|beauty|collagen)/i.test(corpus))
    profile = 'beauty';
  else if (/(powerbank|power bank|battery|charge|laptop|screen|desk|productivity)/i.test(corpus))
    profile = 'tech';
  else if (/(sleep|insomnia|rest|fatigue|melatonin|pillow)/i.test(corpus))
    profile = 'sleep';
  else if (/(gym|workout|training|lift|run|sport|athlete)/i.test(corpus))
    profile = 'fitness';
  else if (/(organiz|rotat|storag|countertop|kitchen.*tower|tower.*kitchen|tray|caddy|rack|drain|unclog|clog|bamboo|declutter)/i.test(corpus))
    profile = 'home';

  return { setting, pain, timeOfDay, onset, profile };
}

// ---------------------------------------------------------------------------
// FRAGMENT POOLS
// Each entry is a function (s) => string | null
// s = signals object. Return null to skip (guard on missing signal).
// Functions that don't use s are marked (_s) to silence lint.
// ---------------------------------------------------------------------------

const FRAGMENTS = {

  // anchor — establishes the specific moment before the product enters the story
  anchor: {
    thermal: [
      (s) => s.setting === 'desk'
        ? `You sit down at your desk. It's the kind of ${s.timeOfDay === 'winter' ? 'winter' : 'cold'} morning where the room never quite warms up.`
        : `The ${s.timeOfDay === 'winter' ? 'cold' : 'day'} starts the same way it always does — you settle in, and within a few minutes your feet remind you they're there.`,
      (s) => `There's a version of ${s.timeOfDay === 'morning' ? 'this morning' : s.timeOfDay === 'evening' ? 'this evening' : 'the day'} where ${s.pain || 'the cold'} isn't the first thing you notice.`,
      (s) => s.setting === 'sofa'
        ? `You're on the sofa, you've finally stopped moving, and your feet are — as always — the one thing stopping you from actually relaxing.`
        : `Most ${s.timeOfDay === 'morning' ? 'mornings' : 'days'}, ${s.pain || 'cold feet'} are just background noise. You've stopped expecting it to be different.`,
      (_s) => `The moment you plug it in — before you've done anything else — the work has already started.`,
    ],
    pain_relief: [
      (_s) => `You sit down the way you always do. Then something is slightly different.`,
      (s) => `${s.setting === 'desk' ? 'Halfway through the morning,' : s.setting === 'gym' ? 'After the workout,' : 'At some point in the day,'} you notice you haven't moved to adjust position in a while.`,
      (s) => `${s.pain ? `The ${s.pain}` : 'The discomfort'} has been there long enough that you've stopped registering it as something that could change.`,
      (s) => `There's a version of ${s.setting === 'desk' ? 'a working day' : s.setting === 'gym' ? 'training' : 'the day'} where you're not managing anything.`,
    ],
    tech: [
      (s) => `${s.setting === 'desk' ? 'You open your laptop.' : 'You sit down.'} One cable. Everything charged. Nothing hunting for a plug that's in the wrong room.`,
      (s) => `The low battery notification doesn't appear${s.timeOfDay === 'morning' ? ' before 9am' : ' halfway through something important'}.`,
      (_s) => `There are mornings where the technology just works and you don't notice it, which is the point.`,
      (s) => `${s.setting === 'travel' ? 'On the way there,' : 'At some point,'} you check your phone and it's still at 80%.`,
    ],
    beauty: [
      (s) => `${s.timeOfDay === 'morning' ? 'First thing in the morning,' : 'At some point,'} you look at your skin in natural light — not filtered, not adjusted — and it's fine. Actually fine.`,
      (_s) => `Two minutes. That's the part people don't expect — that something this fast works this well.`,
      (_s) => `You stop looking in the mirror for reassurance. That's when you know something changed.`,
      (s) => `${s.pain ? `The ${s.pain}` : 'The thing you kept trying to fix'} — one day it's just less visible.`,
    ],
    sleep: [
      (_s) => `You wake up and your first thought isn't about how tired you still are.`,
      (s) => `${s.timeOfDay === 'night' ? 'You get into bed.' : 'You lie down.'} The usual mental loop doesn't start.`,
      (s) => `There's a version of ${s.timeOfDay === 'night' ? 'tonight' : 'this'} where you fall asleep and stay there.`,
      (_s) => `The alarm goes off. You notice you're already awake — have been for a few minutes — and you don't mind.`,
    ],
    fitness: [
      (s) => `${s.timeOfDay === 'morning' ? 'Morning training.' : 'After the workout.'} You're not dreading ${s.setting === 'gym' ? "tomorrow's session" : "how you'll feel tomorrow"}.`,
      (s) => `${s.pain ? `The ${s.pain}` : 'The soreness'} that normally shows up the morning after — it arrives differently.`,
      (_s) => `Recovery used to be the part between training that you just waited out.`,
      (_s) => `You put in the same work. The next day you wake up ready, not waiting to feel ready.`,
    ],
    home: [
      (s) => s.setting === 'kitchen'
        ? `You open a cupboard and something has to move for something else to come out. You've reorganised this more than once.`
        : `There's a version of this space that's clear and easy to move around in. Getting it to stay that way is the problem.`,
      (_s) => `The counter gets tidied. A few days later, it looks the same as before.`,
      (_s) => `You work around the same small problem every day until you stop registering it as a problem. That's when it starts costing you the most.`,
      (s) => s.pain === 'clutter'
        ? `The clutter isn't dramatic. It's just always slightly in the way — finding things, moving things, working around things.`
        : `There's a version of this room where things are easy to find and surfaces stay clear. You've just never quite made it stick.`,
    ],
    generic: [
      (s) => s.setting
        ? `${s.setting === 'desk' ? 'At your desk.' : s.setting === 'sofa' ? 'On the sofa.' : 'At home.'} The small thing you've been working around — it's just gone.`
        : `There's a version of the day where the thing you've been managing is no longer something you have to manage.`,
      (s) => s.pain
        ? `You stop working around ${s.pain}. Not dramatically — it just stops being a factor.`
        : `You stop adjusting. Stop compensating. Stop making the small daily trade-offs that add up to more than they should.`,
      (_s) => `The result isn't always the thing you expected — it's the thing you stopped noticing you were missing.`,
      (_s) => `Some purchases change the shape of a day. Not loudly. Just consistently.`,
    ],
  },

  tension: {
    thermal: [
      (s) => s.pain ? (s.pain === 'cold feet' ? `Cold feet are one of those things — annoying enough to be distracting, not dramatic enough to feel worth solving.` : `${s.pain.charAt(0).toUpperCase() + s.pain.slice(1)} — the thing you've been managing rather than fixing.`) : null,
      (_s) => `Standard heaters heat the room. The room is still cold at floor level. Your feet are still cold. You've known this for years.`,
      (_s) => `You've pulled a blanket over your legs. You've shuffled closer to the radiator. The fix has always been temporary.`,
      (_s) => null,
    ],
    pain_relief: [
      (s) => s.pain ? `${s.pain.charAt(0).toUpperCase() + s.pain.slice(1)} has been present long enough that you've built your posture, your routine, your seating position around it.` : null,
      (_s) => `You've tried adjusting your chair. You've tried stretching. You've tried ignoring it. None of them fix it — they just defer it.`,
      (_s) => null,
      (s) => `The thing about persistent ${s.pain || 'discomfort'} is that it stops feeling like a problem and starts feeling like a fact.`,
    ],
    tech: [
      (_s) => `The cable's in the wrong room. The battery died before the meeting ended. You know this pattern.`,
      (_s) => `Low battery anxiety is a real thing. You check your phone more when it's under 30%. You plan routes around charging points.`,
      (_s) => null,
      (_s) => `Managing devices takes a surprising amount of mental space. You don't notice until it stops.`,
    ],
    beauty: [
      (s) => s.pain ? `${s.pain.charAt(0).toUpperCase() + s.pain.slice(1)} — the thing you've tried to address with five different products.` : null,
      (_s) => `The morning routine keeps getting longer because nothing quite gets the job done alone.`,
      (_s) => null,
      (_s) => `You've noticed that skincare advertising always shows results on faces that didn't have the problem.`,
    ],
    sleep: [
      (_s) => `The lying-awake part isn't because you're not tired. It's because your brain doesn't know the difference between resting and processing.`,
      (_s) => null,
      (_s) => `You've tried earlier bedtimes. You've tried no screens. Some nights it works. Most nights it doesn't.`,
      (s) => `${s.pain || 'Poor sleep'} creates a compounding debt you never quite pay back.`,
    ],
    fitness: [
      (_s) => `The soreness after training isn't the problem. The two days of reduced output that follow it are.`,
      (_s) => null,
      (_s) => `Recovery is the part of training that gets ignored because it doesn't feel like training.`,
      (_s) => `You've plateaued. Not because the training programme is wrong, but because the recovery hasn't caught up.`,
    ],
    home: [
      (_s) => `You've reorganised. Bought the storage solution. Within a week it settles back into the same state.`,
      (s) => s.pain === 'clutter'
        ? `Clutter isn't a single event. It comes back unless the space is actually designed to prevent it.`
        : null,
      (_s) => `The fix works for a few days. Then it has to be redone. That's the real cost — not the mess itself, but the repetition.`,
      (_s) => null,
    ],
    generic: [
      (s) => s.pain
        ? `${s.pain.charAt(0).toUpperCase() + s.pain.slice(1)} — you've learned to work around it, which isn't the same as solving it.`
        : `The workaround has been in place long enough that it stopped feeling like a workaround.`,
      (_s) => `You've adapted your routine to accommodate something that shouldn't need accommodating.`,
      (_s) => `The friction has been present long enough that you've stopped categorising it as friction.`,
      (_s) => `It costs more than you notice — not in money, but in the small adjustments that become invisible habit.`,
    ],
  },

  pivot: {
    thermal: [
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)} — not the room, just your legs — the warmth starts.` : `Within a few minutes, the warmth is there. Quiet.`,
      (_s) => `No noise. No dry air recycled through a fan. Just heat, steady, where you actually need it.`,
      (s) => s.onset ? `You sit down, plug in, wait ${s.onset}. That's the whole process.` : `You sit down and plug in. That's it.`,
      (_s) => `The warmth doesn't arrive as a blast. It builds, settles, and stays.`,
    ],
    pain_relief: [
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)}, you notice you haven't moved to adjust position.` : `At some point, you notice you haven't moved to adjust position in a while.`,
      (_s) => `The relief isn't dramatic. It's just the absence of the thing that's been there.`,
      (_s) => `It works on the tension you carry without noticing — the kind that's been there so long it feels structural.`,
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)} of use, the ${s.pain || 'discomfort'} quiets.` : `Over a short session, the ${s.pain || 'discomfort'} quiets.`,
    ],
    tech: [
      (_s) => `One charge lasts through the day. You stop doing the battery check at 2pm.`,
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)}, you're at full power.` : `It charges fast. You stop planning around it.`,
      (_s) => `The interruption — the low battery, the wrong cable, the dead device — stops happening.`,
      (_s) => `You use your device. You don't manage it.`,
    ],
    beauty: [
      (_s) => `It absorbs quickly. There's no residue, no stage where you're waiting for it to stop being noticeable.`,
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)}, the texture is different.` : `In a short time, the texture changes.`,
      (_s) => `Two minutes in the morning. That's the investment.`,
      (_s) => `The cumulative effect is the thing. Not a single session — but you notice the single sessions less, until one day you notice the difference.`,
    ],
    sleep: [
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)}, the loop slows.` : `The mental loop slows.`,
      (_s) => `Your body temperature drops the way it's supposed to before sleep. The rest follows.`,
      (_s) => `The transition between awake and asleep becomes less effortful.`,
      (_s) => `You stop fighting yourself into sleep. It starts happening instead.`,
    ],
    fitness: [
      (s) => s.onset ? `Start ${s.onset} post-training. That's when recovery is most efficient.` : `Start straight after training.`,
      (_s) => `The inflammation that would normally build overnight — it doesn't compound the same way.`,
      (_s) => `Recovery isn't passive anymore. It's something that's happening.`,
      (_s) => `The soreness arrives smaller. Departs faster.`,
    ],
    home: [
      (s) => s.onset
        ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)} — the space works differently.`
        : `You set it up once. The space starts working the way you always wanted it to.`,
      (_s) => `Everything that didn't have a clear place now does. You didn't renovate anything.`,
      (_s) => `The friction disappears. Not because you cleaned — because the space is finally set up right.`,
      (_s) => `One small addition. The problem that was always slightly in the background — gone.`,
    ],
    generic: [
      (s) => s.onset ? `${s.onset.charAt(0).toUpperCase() + s.onset.slice(1)}, the thing you were managing simply isn't there anymore.` : `At some point in the first few days, the adjustment disappears.`,
      (_s) => `The background noise — the management, the compensation, the workaround — goes quiet.`,
      (_s) => `It works the first time. And then it just keeps working.`,
      (_s) => `You stop noticing it the way you stop noticing a good chair — which is exactly the point.`,
    ],
  },

  resolution: {
    thermal: [
      (_s) => `Your legs are warm. Your feet are warm. You are, for the first time since October, actually comfortable.`,
      (_s) => `You stop noticing your feet — which means you start noticing whatever you were supposed to be focusing on.`,
      (_s) => `The cold stops being a background variable. The work, the film, the conversation — that gets to be the foreground.`,
      (s) => s.setting === 'desk' ? `You stay at your desk for two hours and don't think about moving to a warmer room once.` : `You settle in and don't need to move again.`,
    ],
    pain_relief: [
      (s) => `You finish the ${s.setting === 'desk' ? 'working day' : s.setting === 'gym' ? 'session' : 'day'} and don't immediately need to compensate for it.`,
      (s) => `The ${s.pain || 'discomfort'} that was always the background of your day isn't the background anymore.`,
      (_s) => `You sit for a longer time. Stand for a longer time. Move more freely.`,
      (s) => `You stop thinking about your ${s.pain === 'back pain' ? 'back' : s.pain === 'neck pain' ? 'neck' : 'body'} during the parts of the day that have nothing to do with it.`,
    ],
    tech: [
      (_s) => `Your phone is at 72% at 6pm. You didn't think about it once today.`,
      (_s) => `The devices work. The work happens. You didn't lose an hour to cable management.`,
      (_s) => `The energy you used to spend on device logistics goes somewhere else.`,
      (_s) => `You just use your phone. All day.`,
    ],
    beauty: [
      (_s) => `You stop checking in the mirror as often. That's the signal — not a dramatic change, just a day where you're not monitoring your skin.`,
      (s) => `The ${s.pain || 'problem'} that made you self-conscious — it's less there.`,
      (_s) => `You look fine without doing anything additional. That compounds.`,
      (_s) => `A stranger mentions it. Or nobody does, and you realise you haven't been thinking about it.`,
    ],
    sleep: [
      (_s) => `You wake up before the alarm and don't feel cheated.`,
      (_s) => `The tiredness that follows you through the day — it's lighter.`,
      (_s) => `You have more of yourself available for the hours that matter.`,
      (_s) => `The day starts from a different baseline.`,
    ],
    fitness: [
      (_s) => `You train tomorrow. And the day after.`,
      (_s) => `The consistency that was breaking down — because two recovery days were becoming three — returns.`,
      (_s) => `You stop rationing your effort because you're not sure how long you'll pay for it.`,
      (_s) => `The progress that was stalling unstalls.`,
    ],
    home: [
      (s) => s.setting === 'kitchen'
        ? `The counter stays clear. The cupboard makes sense. You walk in and don't immediately start rearranging.`
        : `The space works the way you always wanted it to. It just took the right thing in the right place.`,
      (_s) => `You stop thinking about the space. That's when you know it's actually working.`,
      (_s) => `You find what you need without moving something else first. Small — but it adds up.`,
      (_s) => `The room feels different. Not because of anything dramatic. Because it finally works.`,
    ],
    generic: [
      (_s) => `The thing that was in the background isn't there anymore. Something else gets to be there instead.`,
      (_s) => `You get more of the day back — not dramatically, just consistently.`,
      (_s) => `The workaround disappears. After a while, you forget what you were working around.`,
      (s) => s.pain
        ? `The ${s.pain} — you remember it was a thing, and then you don't think about it again.`
        : `You notice the absence of something you'd stopped noticing was costing you anything.`,
    ],
  },

  closer: {
    thermal: [
      (_s) => `The kind of small change that makes everything else slightly easier.`,
      (_s) => `It sounds minor. It isn't.`,
      (_s) => `You didn't realise how much mental space the cold was occupying until it left.`,
      (_s) => null,
    ],
    pain_relief: [
      (_s) => `Small interventions. Long-term compound.`,
      (_s) => null,
      (_s) => `The ROI on comfort is real — you just can't see it until it's there.`,
      (_s) => null,
    ],
    tech: [
      (_s) => `Removing friction doesn't feel like adding value. Until you measure the output.`,
      (_s) => null,
      (_s) => `A charged device is a small thing. An always-charged device changes how you work.`,
      (_s) => `Low battery anxiety is invisible until it's gone.`,
    ],
    beauty: [
      (_s) => null,
      (_s) => `Confidence isn't a product. But some products earn the space they take up.`,
      (_s) => `The routine gets shorter because you need less of everything else.`,
      (_s) => null,
    ],
    sleep: [
      (_s) => `Sleep debt is real. Paying it back is slow. Not adding to it is where you start.`,
      (_s) => null,
      (_s) => `One better night changes the baseline for the next few.`,
      (_s) => `Everything is slightly harder when you're tired. Everything.`,
    ],
    fitness: [
      (_s) => `Consistent recovery enables consistent training. Consistent training is the whole game.`,
      (_s) => null,
      (_s) => `The ceiling moves when the floor gets more solid.`,
      (_s) => `Results are just consistent inputs. This makes the inputs more consistent.`,
    ],
    home: [
      (_s) => `The right thing in the right place changes how a room feels to be in.`,
      (_s) => null,
      (_s) => `Small changes to how a space is set up compound. This is one of those.`,
      (_s) => `One upgrade that makes everything around it feel more considered.`,
    ],
    generic: [
      (_s) => `The right purchase doesn't announce itself. It just makes everything around it slightly easier.`,
      (_s) => `Small frictions compound. So does removing them.`,
      (_s) => `Removing friction is the quietest kind of upgrade — you only notice it when you've made one.`,
      (_s) => `It's not a dramatic change. It's the kind that quietly makes everything else work a little better.`,
    ],
  },
};

// ---------------------------------------------------------------------------
// pickFragment — select from a pool using hash offset, skip null returns
// ---------------------------------------------------------------------------
function pickFragment(pool, signals, hashOffset) {
  if (!pool || pool.length === 0) return null;
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const idx    = (hashOffset + attempt) % pool.length;
    const fn     = pool[idx];
    if (typeof fn !== 'function') continue;
    const result = fn(signals);
    if (result !== null && result !== undefined) return result.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// assembleVariant — build one paragraph from role sequence
// ---------------------------------------------------------------------------
function assembleVariant(signals, hash, structureKey) {
  const profile = signals.profile;

  const structures = {
    A: ['anchor', 'pivot', 'resolution', 'closer'],
    B: ['tension', 'anchor', 'pivot', 'resolution'],
    C: ['anchor', 'tension', 'pivot', 'resolution'],
    D: ['pivot', 'anchor', 'resolution', 'closer'],
  };

  const roles     = structures[structureKey] || structures.A;
  const sentences = [];

  for (let i = 0; i < roles.length; i++) {
    const role     = roles[i];
    const rolePool = FRAGMENTS[role]?.[profile] || FRAGMENTS[role]?.generic;
    if (!rolePool) continue;
    const offset   = (hash + i * 7) % rolePool.length;
    const fragment = pickFragment(rolePool, signals, offset);
    if (fragment) sentences.push(fragment);
  }

  return sentences
    .join('  ')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

// ---------------------------------------------------------------------------
// scoreParagraph — basic quality gate
// ---------------------------------------------------------------------------
function scoreParagraph(text) {
  if (!text || text.length < 60)    return false;
  if (text.split(/[.!?]/).length < 2) return false;
  return true;
}

// ---------------------------------------------------------------------------
// generateDesireBlock — main export
// ---------------------------------------------------------------------------
function generateDesireBlock(product) {
  const signals = extractSignals(product);
  const hash    = productHash(product);

  const structureKeys = ['A', 'B', 'C', 'D'];
  const primaryKey    = structureKeys[hash % structureKeys.length];
  const secondaryKey  = structureKeys[(hash + 2) % structureKeys.length];

  let rawA = assembleVariant(signals, hash,      primaryKey);
  let rawB = assembleVariant(signals, hash + 13, secondaryKey);

  if (!scoreParagraph(rawA)) rawA = assembleVariant(signals, hash + 3,  'C');
  if (!scoreParagraph(rawB) || rawB === rawA) rawB = assembleVariant(signals, hash + 19, 'D');

  const makeVariant = (content, structure) => ({
    content,
    structure,
    profile:    signals.profile,
    confidence: signals.profile === 'generic' ? 'low' : 'medium',
    placement:  'between_pain_and_features',
    tokens: {
      setting:   signals.setting,
      timeOfDay: signals.timeOfDay,
      pain:      signals.pain,
      onset:     signals.onset,
    },
  });

  const vA = makeVariant(rawA, primaryKey);
  const vB = makeVariant(rawB, secondaryKey);

  return { variants: [vA, vB], bestGuess: vA };
}

module.exports = { generateDesireBlock, extractSignals, productHash };
