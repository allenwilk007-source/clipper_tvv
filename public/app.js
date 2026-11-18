const REFRESH_MS = 15_000;

const JOB_POLL_MS = 1200;

const els = {
  game: document.getElementById('game'),
  stats: document.getElementById('stats'),
  feed: document.getElementById('feed'),
  filters: document.getElementById('filters'),
  sort: document.getElementById('sort'),
  vertical: document.getElementById('vertical'),
  template: document.getElementById('card-template'),
};

let filter = 'all';
let sort = 'opportunity';
let latest = null;

// Cards are rebuilt from scratch on every feed poll, so clip state cannot live
// in the DOM or it would vanish mid-download. Keyed by moment id; `cards`
// tracks which node is currently showing each moment so a job update repaints
// one card instead of re-rendering (and re-sorting) the whole feed under the
// operator's cursor.
const clipJobs = new Map();
const cards = new Map();
let jobTimer = null;

const SORTERS = {
  opportunity: (a, b) => b.opportunity - a.opportunity,
  newest: (a, b) => Date.parse(b.lastClipAt) - Date.parse(a.lastClipAt),
  saturation: (a, b) => b.saturation - a.saturation,
  chat: (a, b) => b.chatZ - a.chatZ,
};

const number = (value) => (value ?? 0).toLocaleString();

function ago(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  return `${(minutes / 60).toFixed(1)}h ago`;
}

function notice(title, html, isError = false) {
  els.feed.innerHTML = '';
  const box = document.createElement('div');
  box.className = `notice${isError ? ' is-error' : ''}`;
  box.innerHTML = `<h2>${title}</h2>${html}`;
  els.feed.append(box);
}

function renderStats(meta, game) {
  els.game.textContent = game ? game.name : 'no category resolved';

  const chat = meta.chat?.enabled
    ? `${meta.chat.connectedShards}/${meta.chat.shards} sockets · ${meta.chat.channels} ch`
    : 'off';

  const cells = [
    ['Early', meta.counts.early ?? 0],
    ['Fresh', meta.counts.fresh],
    ['Warm', meta.counts.warm],
    ['Flooded', meta.counts.flooded],
    ['Clips scanned', number(meta.clipsScanned)],
    ['Live channels', number(meta.liveChannels)],
  ];

  els.stats.innerHTML = cells
    .map(([label, value]) => `<div><b>${value}</b>${label}</div>`)
    .join('');

  els.stats.insertAdjacentHTML(
    'beforeend',
    `<div><b>${meta.windowMinutes}m</b>window · chat ${chat}</div>`,
  );
}

function buildCard(moment) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.classList.add(`is-${moment.state}`);

  // Zero is the whole pitch for a chat-sourced moment, so say it as a word
  // rather than showing a "0" that reads like missing data.
  node.querySelector('.sat-count').textContent = moment.saturation === 0 ? '—' : moment.saturation;
  node.querySelector('.sat-label').textContent =
    moment.saturation === 0
      ? 'nobody yet'
      : moment.uniqueClippers === moment.saturation
        ? 'clippers'
        : 'clips';

  node.querySelector('.state').textContent =
    moment.state === 'early' ? 'chat only' : moment.state;

  const name = node.querySelector('.broadcaster');
  name.textContent = moment.broadcaster;
  name.href = `https://www.twitch.tv/${moment.broadcaster}`;

  const fresh = node.querySelector('.new-clips');
  fresh.textContent = moment.newClips > 0 ? `+${moment.newClips} since last poll` : '';

  const title = node.querySelector('.title');
  title.textContent = moment.title || moment.streamTitle || '';

  const bits = [];
  if (moment.chat?.spiking) {
    bits.push(`<span class="hot">chat ${moment.chatZ.toFixed(1)}σ</span>`);
  } else if (moment.chatZ > 0) {
    bits.push(`chat ${moment.chatZ.toFixed(1)}σ`);
  }
  if (moment.saturation > 0) bits.push(`${moment.clipsPerMinute}/min`);
  if (moment.viewers != null) bits.push(`${number(moment.viewers)} viewers`);
  bits.push(`${number(moment.clipViews)} clip views`);
  bits.push(ago(moment.minutesSinceLastClip));
  if (moment.firstClipper) bits.push(`first: ${moment.firstClipper}`);
  if (moment.basis === 'created') bits.push('VOD position pending');
  if (moment.offsetEstimated) bits.push('offset estimated');
  if (moment.shared) bits.push('<span class="shared">whole category spiked</span>');
  node.querySelector('.meta').innerHTML = bits.join('<span>·</span>');

  renderChatEvidence(node.querySelector('.chat-evidence'), moment);

  const open = node.querySelector('.open');
  open.href = moment.deepLink;
  open.textContent = moment.vodId ? 'Open at moment' : 'Open clip';

  const clip = node.querySelector('.clip');
  if (!canClip(moment)) {
    // Without a VOD id and offset there is nothing to cut from: these are the
    // moments whose position Twitch has not published yet.
    clip.disabled = true;
    clip.title = 'No VOD position yet — Twitch publishes it a minute or two late';
  } else {
    clip.addEventListener('click', () => startClip(moment));
  }

  cards.set(moment.id, node);
  paintClip(moment.id);

  return node;
}

const canClip = (moment) => Boolean(moment.vodId) && Number.isFinite(moment.offsetSeconds);

const CLASS_LABELS = {
  clipit: 'chat asked for a clip',
  funny: 'laughing',
  hype: 'hype',
  tension: 'tension',
  shock: 'shock',
};

/**
 * What chat actually did, under the card.
 *
 * An unconfirmed moment has to show its working: nobody has clipped it, the
 * offset is a guess, and the only reason it is on screen at all is this. The
 * operator deserves to see the evidence rather than a number asking to be
 * trusted.
 */
function renderChatEvidence(box, moment) {
  const chat = moment.chat;
  const classes = chat?.classes || {};
  const fired = Object.entries(classes)
    .filter(([, value]) => value.count > 0 && value.z > 1)
    .sort((a, b) => b[1].z - a[1].z)
    .slice(0, 3);

  if (!fired.length && !moment.unconfirmed) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  box.textContent = '';

  if (moment.unconfirmed) {
    const warn = document.createElement('b');
    warn.textContent = 'Unconfirmed — no clips yet. ';
    box.append(warn);
  }

  if (!fired.length) {
    box.append(document.createTextNode('Chat spiked.'));
    return;
  }

  box.append(
    document.createTextNode(
      fired.map(([name, value]) => `${CLASS_LABELS[name] || name} ×${value.count}`).join(', '),
    ),
  );
  if (chat?.copypasta > 0.3) {
    box.append(document.createTextNode(` · ${Math.round(chat.copypasta * 100)}% copypasta`));
  }
}

function paintClip(momentId) {
  const node = cards.get(momentId);
  const job = clipJobs.get(momentId);
  if (!node) return;

  const button = node.querySelector('.clip');
  const status = node.querySelector('.clip-status');

  if (!job) {
    status.hidden = true;
    return;
  }

  const busy = job.state === 'queued' || job.state === 'running';
  button.disabled = busy;
  button.textContent = busy ? 'Clipping…' : job.state === 'done' ? 'Clip again' : 'Retry clip';

  status.hidden = false;
  status.className = `clip-status is-${job.state}`;

  // textContent, not innerHTML: a failure message is yt-dlp's words about a
  // Twitch page, and those are not ours to trust with markup.
  status.textContent = '';
  const say = (text, tag = 'span') => {
    const el = document.createElement(tag);
    el.textContent = text;
    status.append(el);
  };

  if (job.state === 'done') {
    say('Saved ');
    say(job.path, 'code');
    if (job.verticalPath) {
      say(' · 9:16 ');
      say(job.verticalPath, 'code');
    }
    return;
  }
  if (job.state === 'failed') {
    say(`Clip failed: ${job.message}`);
    return;
  }

  const percent = job.state === 'running' && job.progress ? ` ${job.progress}%` : '';
  say(`${job.state}${percent} — ${job.message || 'working'}`);
}

async function startClip(moment) {
  clipJobs.set(moment.id, { state: 'queued', progress: 0, message: 'queued' });
  paintClip(moment.id);

  try {
    const res = await fetch('/api/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vodId: moment.vodId,
        offsetSeconds: moment.offsetSeconds,
        broadcaster: moment.broadcaster,
        momentId: moment.id,
        vertical: els.vertical.checked,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || `server returned ${res.status}`);
    clipJobs.set(moment.id, body.job);
  } catch (err) {
    clipJobs.set(moment.id, { state: 'failed', message: err.message });
  }

  paintClip(moment.id);
  watchJobs();
}

/** One ticker for every in-flight job, stopped as soon as none are left. */
function watchJobs() {
  if (jobTimer) return;
  jobTimer = setInterval(async () => {
    const active = [...clipJobs].filter(
      ([, job]) => job.id && (job.state === 'queued' || job.state === 'running'),
    );
    if (!active.length) {
      clearInterval(jobTimer);
      jobTimer = null;
      return;
    }
    for (const [momentId, job] of active) {
      try {
        const res = await fetch(`/api/clip/${job.id}`);
        if (!res.ok) continue;
        const body = await res.json();
        clipJobs.set(momentId, body.job);
      } catch {
        // A dropped poll is not a failed job; the next tick will catch up.
      }
      paintClip(momentId);
    }
  }, JOB_POLL_MS);
}

function render() {
  if (!latest) return;
  const { moments, meta, game } = latest;
  renderStats(meta, game);

  if (meta.lastError) {
    notice(
      'Last poll failed',
      `<p>${meta.lastError.message}</p><p>Showing the most recent good data. Retrying every ${meta.pollSeconds}s.</p>`,
      true,
    );
    return;
  }

  const shown = moments
    .filter((m) => filter === 'all' || m.state === filter)
    .sort(SORTERS[sort]);

  if (!shown.length) {
    const why = moments.length
      ? 'Nothing in this filter right now.'
      : `No clips in the last ${meta.windowMinutes} minutes. Either the category is quiet, or the game has not launched yet.`;
    notice('Empty feed', `<p>${why}</p>`);
    return;
  }

  const frag = document.createDocumentFragment();
  cards.clear();
  for (const moment of shown.slice(0, 150)) frag.append(buildCard(moment));
  els.feed.innerHTML = '';
  els.feed.append(frag);
}

async function poll() {
  try {
    // Pass the page's own query through, so /?demo=1 reaches the API.
    const res = await fetch(`/api/feed${location.search}`);
    if (res.status === 503) {
      const body = await res.json();
      els.game.textContent = 'not configured';
      els.stats.innerHTML = '';
      notice(
        'Twitch credentials needed',
        `<p>${body.message}</p>
         <ol>
           <li>Register an app at <code>dev.twitch.tv/console/apps</code></li>
           <li><code>cp .env.example .env</code></li>
           <li>Paste the Client ID and Client Secret into <code>.env</code></li>
           <li>Restart with <code>npm start</code></li>
         </ol>`,
        true,
      );
      return;
    }
    if (!res.ok) throw new Error(`feed returned ${res.status}`);
    latest = await res.json();
    render();
  } catch (err) {
    notice('Cannot reach the server', `<p>${err.message}</p><p>Is <code>npm start</code> still running?</p>`, true);
  }
}

els.filters.addEventListener('click', (event) => {
  const button = event.target.closest('.chip');
  if (!button) return;
  filter = button.dataset.filter;
  for (const chip of els.filters.children) chip.classList.toggle('is-on', chip === button);
  render();
});

els.sort.addEventListener('change', () => {
  sort = els.sort.value;
  render();
});

poll();
setInterval(poll, REFRESH_MS);
