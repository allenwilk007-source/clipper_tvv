const REFRESH_MS = 15_000;

const els = {
  game: document.getElementById('game'),
  stats: document.getElementById('stats'),
  feed: document.getElementById('feed'),
  filters: document.getElementById('filters'),
  sort: document.getElementById('sort'),
  template: document.getElementById('card-template'),
};

let filter = 'all';
let sort = 'opportunity';
let latest = null;

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

  node.querySelector('.sat-count').textContent = moment.saturation;
  node.querySelector('.sat-label').textContent =
    moment.uniqueClippers === moment.saturation ? 'clippers' : 'clips';

  node.querySelector('.state').textContent = moment.state;

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
  bits.push(`${moment.clipsPerMinute}/min`);
  if (moment.viewers != null) bits.push(`${number(moment.viewers)} viewers`);
  bits.push(`${number(moment.clipViews)} clip views`);
  bits.push(ago(moment.minutesSinceLastClip));
  if (moment.firstClipper) bits.push(`first: ${moment.firstClipper}`);
  if (moment.basis === 'created') bits.push('VOD position pending');
  node.querySelector('.meta').innerHTML = bits.join('<span>·</span>');

  const open = node.querySelector('.open');
  open.href = moment.deepLink;
  open.textContent = moment.vodId ? 'Open at moment' : 'Open clip';

  return node;
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
