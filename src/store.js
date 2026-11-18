// Persistence, and the only reason it exists: a label.
//
// The ranking formula in moments.js is a hand-tuned guess. A good one, but a
// guess — no moment it has ever ranked highly has been checked against whether
// the clip went on to do anything. Without that check there is no way to tell a
// signal that works from one that merely sounds right, and no honest way to
// tune a constant.
//
// So every moment, clip and poll goes in here, and the clips of moments we have
// already seen get re-polled hours later to find out what happened. That turns
// "I think this ranks well" into a number (see eval.js).
//
// node:sqlite is in the standard library as of Node 22, which is the whole
// reason it is used: persistence without breaking the zero-dependency rule.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// When to look back at a moment and ask what became of it. 15m catches the
// flood forming, 24h is where a clip's view count has mostly settled.
export const HORIZONS = [
  { name: '15m', seconds: 15 * 60 },
  { name: '1h', seconds: 60 * 60 },
  { name: '6h', seconds: 6 * 60 * 60 },
  { name: '24h', seconds: 24 * 60 * 60 },
];

const SCHEMA = `
create table if not exists moments (
  id             text primary key,
  game_id        text,
  broadcaster_id text,
  broadcaster    text,
  vod_id         text,
  offset_seconds integer,
  source         text,
  title          text,
  detected_at    text not null,
  first_clip_at  text,
  saturation_at_detect integer
);

create table if not exists clips (
  id            text primary key,
  moment_id     text not null,
  creator_name  text,
  created_at    text,
  view_count    integer,
  first_seen_at text not null
);
create index if not exists clips_by_moment on clips(moment_id);

create table if not exists observations (
  moment_id       text not null,
  observed_at     text not null,
  saturation      integer,
  unique_clippers integer,
  clip_views      integer,
  chat_z          real,
  reaction        real,
  viewers         integer,
  opportunity     real
);
create index if not exists observations_by_moment on observations(moment_id);

create table if not exists outcomes (
  moment_id   text not null,
  horizon     text not null,
  recorded_at text not null,
  views       integer,
  saturation  integer,
  primary key (moment_id, horizon)
);
`;

// node:sqlite refuses to bind `undefined`, and a single missing field would
// otherwise throw in the middle of a poll and lose the whole write. Absent and
// null mean the same thing here, so make them the same thing.
const nul = (value) => (value === undefined ? null : value);
const int = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
const real = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal');
    this.db.exec('pragma synchronous = normal');
    this.db.exec(SCHEMA);

    // Prepared once and reused: this runs on every poll, every 30 seconds,
    // for every moment in the window.
    this.q = {
      insertMoment: this.db.prepare(`
        insert into moments
          (id, game_id, broadcaster_id, broadcaster, vod_id, offset_seconds,
           source, title, detected_at, first_clip_at, saturation_at_detect)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          vod_id = coalesce(excluded.vod_id, moments.vod_id),
          offset_seconds = coalesce(excluded.offset_seconds, moments.offset_seconds),
          -- a moment first seen in chat and later confirmed by clips is both
          source = case when moments.source = excluded.source then moments.source else 'both' end
      `),
      insertClip: this.db.prepare(`
        insert into clips (id, moment_id, creator_name, created_at, view_count, first_seen_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(id) do update set view_count = excluded.view_count
      `),
      insertObservation: this.db.prepare(`
        insert into observations
          (moment_id, observed_at, saturation, unique_clippers, clip_views,
           chat_z, reaction, viewers, opportunity)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      clipIds: this.db.prepare('select id from clips where moment_id = ?'),
      insertOutcome: this.db.prepare(`
        insert into outcomes (moment_id, horizon, recorded_at, views, saturation)
        values (?, ?, ?, ?, ?)
        on conflict(moment_id, horizon) do update set
          recorded_at = excluded.recorded_at,
          views = excluded.views,
          saturation = excluded.saturation
      `),
      due: this.db.prepare(`
        select id from moments
        where detected_at <= ?
          and not exists (
            select 1 from outcomes o where o.moment_id = moments.id and o.horizon = ?
          )
        order by detected_at asc
        limit ?
      `),
      counts: this.db.prepare(`
        select
          (select count(*) from moments) as moments,
          (select count(*) from clips) as clips,
          (select count(*) from observations) as observations,
          (select count(*) from outcomes) as outcomes
      `),
    };
  }

  /**
   * One poll's worth of state.
   *
   * `detected_at` is deliberately only written on insert: it is when *we* first
   * saw the moment, which is the number the product is judged on, so a later
   * poll must never overwrite it.
   */
  recordPoll({ moments, clipsById = new Map(), gameId = null, at = new Date() }) {
    const now = at.toISOString();
    this.db.exec('begin');
    try {
      for (const moment of moments) {
        this.q.insertMoment.run(
          moment.id,
          nul(gameId),
          nul(moment.broadcasterId),
          nul(moment.broadcaster),
          nul(moment.vodId),
          int(moment.offsetSeconds),
          moment.source || 'clips',
          moment.title || null,
          now,
          moment.firstClipAt || null,
          int(moment.saturation) ?? 0,
        );

        for (const clipId of moment.clipIds || []) {
          const clip = clipsById.get(clipId);
          if (!clip) continue;
          this.q.insertClip.run(
            clip.id,
            moment.id,
            clip.creator_name || null,
            clip.created_at || null,
            int(clip.view_count) ?? 0,
            now,
          );
        }

        this.q.insertObservation.run(
          moment.id,
          now,
          int(moment.saturation) ?? 0,
          int(moment.uniqueClippers) ?? 0,
          int(moment.clipViews) ?? 0,
          real(moment.chatZ) ?? 0,
          real(moment.reaction ?? moment.chat?.reaction ?? moment.chatZ) ?? 0,
          int(moment.viewers),
          real(moment.opportunity) ?? 0,
        );
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  /** Moments old enough for a horizon that have not been checked at it yet. */
  dueForOutcome(horizon, { now = Date.now(), limit = 20 } = {}) {
    const cutoff = new Date(now - horizon.seconds * 1000).toISOString();
    return this.q.due.all(cutoff, horizon.name, Math.max(1, Math.round(limit))).map((row) => row.id);
  }

  clipIdsFor(momentId) {
    return this.q.clipIds.all(momentId).map((row) => row.id);
  }

  /**
   * What became of a moment. `clips` is whatever Twitch still returns for the
   * ids we stored — a clip that has been deleted simply stops coming back, and
   * the shrinking count is itself the honest answer.
   */
  recordOutcome({ momentId, horizon, clips, at = new Date() }) {
    const now = at.toISOString();
    let views = 0;
    for (const clip of clips) {
      views += clip.view_count ?? 0;
      this.q.insertClip.run(
        clip.id,
        momentId,
        clip.creator_name || null,
        clip.created_at || null,
        int(clip.view_count) ?? 0,
        now,
      );
    }
    this.q.insertOutcome.run(momentId, horizon.name, now, views, clips.length);
  }

  counts() {
    return this.q.counts.get();
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Never let bookkeeping take the feed down with it. A broken store is a lost
 * experiment; a broken feed is the product.
 */
export function openStore(path, { log = () => {} } = {}) {
  try {
    return new Store(path);
  } catch (err) {
    log(`store disabled: ${err.message}`);
    return null;
  }
}
