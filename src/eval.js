// npm run eval — does the ranking actually work?
//
// Everything else in this repo is a hypothesis. This file is the only thing
// that can falsify one. It takes the moments the feed ranked, the outcomes
// recorded hours later, and answers two questions:
//
//   1. PRECISION — of the moments the feed put at the top, how many turned out
//      to be among the best? Compared against the rate you would get by
//      picking at random, because "40%" means nothing until you know that
//      chance would have given you 10%.
//
//   2. LEAD — how long before the second independent clipper did we have it?
//      This is the number the product is actually selling. Precision without
//      lead is a very good way of telling you about a moment everyone already
//      has.
//
// A detector that improves neither does not ship, however good the idea was.

import { pathToFileURL } from 'node:url';

import { HORIZONS, openStore } from './store.js';
import { config } from './config.js';

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Seconds between the first clip of a moment and the first clip by somebody
 * else.
 *
 * Deliberately "somebody else": one person firing off four clips of the same
 * moment is one person, and counting that as competition would flatter every
 * number downstream. Null when nobody else ever showed up — which is not a
 * failure, it is either a moment nobody wanted or one the feed found alone.
 */
export function leadTimeSeconds(clips) {
  const ordered = [...clips]
    .filter((clip) => clip.created_at)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (ordered.length < 2) return null;

  const first = ordered[0];
  const rival = ordered.find((clip) => clip.creator_name && clip.creator_name !== first.creator_name);
  if (!rival) return null;
  return Math.max(0, (Date.parse(rival.created_at) - Date.parse(first.created_at)) / 1000);
}

/**
 * The scoreboard.
 *
 * `rows` are plain objects so this can be tested without a database:
 * { momentId, source, opportunity, views, leadTimeSeconds, saturationAtDetect,
 *   saturationAfter }
 */
export function evaluate(rows, { topN = 20, decile = 0.1 } = {}) {
  const scored = rows.filter((row) => Number.isFinite(row.opportunity) && Number.isFinite(row.views));
  if (scored.length < 2) {
    return { population: scored.length, enough: false };
  }

  // "Best" = top decile by views at the horizon. At least one moment always
  // qualifies, or a small sample would have an empty target set and a
  // guaranteed score of zero.
  const byViews = [...scored].sort((a, b) => b.views - a.views);
  const cut = Math.max(1, Math.round(scored.length * decile));
  const winners = new Set(byViews.slice(0, cut).map((row) => row.momentId));

  const byScore = [...scored].sort((a, b) => b.opportunity - a.opportunity);
  const top = byScore.slice(0, Math.min(topN, scored.length));
  const hits = top.filter((row) => winners.has(row.momentId)).length;

  const precision = hits / top.length;
  // What picking at random would have given you. The only honest comparison.
  const chance = cut / scored.length;

  const leads = (list) =>
    list.map((row) => row.leadTimeSeconds).filter((value) => Number.isFinite(value));

  const bySource = {};
  for (const row of scored) {
    const key = row.source || 'clips';
    bySource[key] ??= { count: 0, winners: 0, leads: [] };
    bySource[key].count += 1;
    if (winners.has(row.momentId)) bySource[key].winners += 1;
    if (Number.isFinite(row.leadTimeSeconds)) bySource[key].leads.push(row.leadTimeSeconds);
  }
  for (const stats of Object.values(bySource)) {
    stats.medianLead = median(stats.leads);
    delete stats.leads;
  }

  return {
    enough: true,
    population: scored.length,
    topN: top.length,
    winnersCut: cut,
    hits,
    precision,
    chance,
    // Above 1 means the ranking beats a coin flip. This is the headline.
    lift: chance ? precision / chance : null,
    medianLeadTop: median(leads(top)),
    medianLeadAll: median(leads(scored)),
    medianViewsTop: median(top.map((row) => row.views)),
    medianViewsAll: median(scored.map((row) => row.views)),
    bySource,
  };
}

/** Pull one horizon's worth of rows out of the store. */
export function loadRows(store, horizonName) {
  const moments = store.all(
    `select m.id              as momentId,
            m.source          as source,
            m.detected_at     as detectedAt,
            m.saturation_at_detect as saturationAtDetect,
            o.views           as views,
            o.saturation      as saturationAfter,
            (select ob.opportunity from observations ob
              where ob.moment_id = m.id order by ob.observed_at asc limit 1) as opportunity,
            (select ob.reaction from observations ob
              where ob.moment_id = m.id order by ob.observed_at asc limit 1) as reaction
       from moments m
       join outcomes o on o.moment_id = m.id and o.horizon = ?`,
    horizonName,
  );

  if (!moments.length) return [];

  const clipsByMoment = new Map();
  for (const clip of store.all('select moment_id, creator_name, created_at from clips')) {
    if (!clipsByMoment.has(clip.moment_id)) clipsByMoment.set(clip.moment_id, []);
    clipsByMoment.get(clip.moment_id).push(clip);
  }

  return moments.map((row) => ({
    ...row,
    leadTimeSeconds: leadTimeSeconds(clipsByMoment.get(row.momentId) || []),
  }));
}

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const secs = (value) => (value == null ? '—' : `${Math.round(value)}s`);

function report(horizonName, result) {
  console.log(`\n  horizon ${horizonName}`);

  if (!result.enough) {
    console.log(`    only ${result.population} scored moment(s) — not enough to say anything.`);
    return;
  }

  console.log(`    population        ${result.population} moments with an outcome`);
  console.log(
    `    precision@${result.topN}      ${pct(result.precision)}  (${result.hits}/${result.topN} in the top decile by views)`,
  );
  console.log(`    chance            ${pct(result.chance)}  picking at random`);
  console.log(
    `    lift              ${result.lift == null ? '—' : `${result.lift.toFixed(2)}x`}  ${
      result.lift > 1 ? 'the ranking beats chance' : 'the ranking does NOT beat chance'
    }`,
  );
  console.log(`    median views      top ${result.medianViewsTop} vs all ${result.medianViewsAll}`);
  console.log(
    `    median lead       top ${secs(result.medianLeadTop)} vs all ${secs(result.medianLeadAll)}`,
  );

  const sources = Object.entries(result.bySource);
  if (sources.length > 1) {
    console.log('    by source');
    for (const [name, stats] of sources) {
      console.log(
        `      ${name.padEnd(6)}      ${stats.count} moments, ${stats.winners} in top decile, median lead ${secs(stats.medianLead)}`,
      );
    }
  }
}

function main() {
  const store = openStore(config.storePath, { log: (m) => console.error(m) });
  if (!store) {
    console.error('Could not open the store. Is STORE_PATH writable?');
    process.exitCode = 1;
    return;
  }

  const counts = store.counts();
  console.log(`\n  ${config.storePath}`);
  console.log(
    `  ${counts.moments} moments · ${counts.clips} clips · ${counts.observations} observations · ${counts.outcomes} outcomes`,
  );

  if (!counts.outcomes) {
    // Say so plainly rather than printing a confident 0%.
    console.log('\n  No outcomes recorded yet, so there is nothing to score.');
    console.log('  Leave `npm start` running — the first horizon lands 15 minutes');
    console.log('  after the first moment is seen, and 24h is where views settle.\n');
    store.close();
    return;
  }

  for (const horizon of HORIZONS) {
    const rows = loadRows(store, horizon.name);
    if (!rows.length) continue;
    report(horizon.name, evaluate(rows));
  }

  console.log('\n  Read it as: lift above 1.0 means the ranking is doing something.');
  console.log('  Anything that claims to improve detection has to move these numbers.\n');
  store.close();
}

// Importable for tests, runnable as a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
