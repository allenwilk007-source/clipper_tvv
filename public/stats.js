// The stats dashboard.
//
// Polls /api/stats, which is itself behind a five-minute refresh floor, so the
// page can sit open without spending the uploader's YouTube quota. The poll
// here is deliberately slower than that floor: a faster one would only ever
// re-read the same cached answer.

const POLL_MS = 60_000;

const els = {
  updated: document.getElementById('updated'),
  refresh: document.getElementById('refresh'),
  state: document.getElementById('youtube-state'),
  body: document.getElementById('youtube-body'),
  row: document.getElementById('video-row'),
};

// A missing number is not zero. Hidden subscriber counts and hidden likes both
// arrive absent, and printing 0 would state something the API never said.
const num = (value) =>
  value === null || value === undefined ? '—' : Number(value).toLocaleString();

const duration = (seconds) => {
  if (!Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

function ago(iso) {
  if (!iso) return '';
  const minutes = (Date.now() - Date.parse(iso)) / 60000;
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

function notice(html, kind = '') {
  els.body.innerHTML = `<div class="notice${kind ? ` ${kind}` : ''}">${html}</div>`;
}

function renderTotals(channel) {
  const cells = [
    ['Subscribers', channel.subscribersHidden ? 'hidden' : num(channel.subscribers)],
    ['Total views', num(channel.views)],
    ['Videos', num(channel.videos)],
  ];
  return `
    <div class="channel">
      ${channel.thumbnail ? `<img class="channel-avatar" src="${channel.thumbnail}" alt="" />` : ''}
      <div class="channel-name">${channel.title || 'this channel'}</div>
    </div>
    <div class="totals">
      ${cells.map(([label, value]) => `<div><b>${value}</b>${label}</div>`).join('')}
    </div>`;
}

function renderVideos(videos) {
  if (!videos.length) {
    return '<p class="pending-note">No uploads on this channel yet.</p>';
  }
  const list = document.createElement('div');
  list.className = 'videos';

  for (const video of videos) {
    const node = els.row.content.firstElementChild.cloneNode(true);
    const thumb = node.querySelector('.video-thumb');
    thumb.href = video.url;
    const img = thumb.querySelector('img');
    if (video.thumbnail) img.src = video.thumbnail;
    else thumb.classList.add('is-blank');

    const title = node.querySelector('.video-title');
    title.textContent = video.title || video.id;
    title.href = video.url;

    const bits = [ago(video.publishedAt), duration(video.seconds)].filter(Boolean);
    // Anything not public is worth saying plainly — a private upload showing
    // no views is explained by its privacy, not by nobody watching.
    if (video.privacy && video.privacy !== 'public') bits.push(video.privacy);
    node.querySelector('.video-meta').textContent = bits.join(' · ');

    node.querySelector('.video-numbers').innerHTML = [
      ['views', num(video.views)],
      ['likes', num(video.likes)],
      ['comments', num(video.comments)],
    ]
      .map(([label, value]) => `<span><b>${value}</b>${label}</span>`)
      .join('');

    list.append(node);
  }
  return list.outerHTML;
}

function render(state) {
  const yt = state.youtube || {};

  if (!yt.keys) {
    els.state.textContent = 'needs keys';
    notice(
      `<h2>Not set up yet</h2>
       <p>Add <code>YOUTUBE_CLIENT_ID</code> and <code>YOUTUBE_CLIENT_SECRET</code> to
          <code>.env</code> and restart. See <code>docs/posting-setup.md</code>.</p>`,
    );
    return;
  }

  if (!yt.connected) {
    els.state.textContent = 'not connected';
    const why = yt.error?.message
      ? `<p>The last sign-in could not be used: ${yt.error.message}</p>`
      : '';
    notice(
      `<h2>Not connected</h2>${why}
       <p><a class="connect" href="/auth/youtube">Connect YouTube</a></p>`,
    );
    return;
  }

  els.state.textContent = yt.cached ? 'cached' : 'live';

  // An error beside good numbers means the refresh failed, not that the
  // figures are wrong — say which, rather than blanking the page.
  const banner = yt.error
    ? `<div class="notice is-error">
         <b>${yt.error.kind === 'quota' ? 'Quota reached' : 'Could not refresh'}.</b>
         ${yt.error.message}. Showing the last good numbers.
       </div>`
    : '';

  els.body.innerHTML = yt.channel
    ? banner + renderTotals(yt.channel) + renderVideos(yt.videos || [])
    : banner + '<p class="pending-note">Connected, but this account has no channel.</p>';
}

async function poll({ force = false } = {}) {
  try {
    const res = await fetch(`/api/stats${force ? '?force=1' : ''}`);
    if (!res.ok) throw new Error(`stats returned ${res.status}`);
    const state = await res.json();
    render(state);
    els.updated.textContent = state.youtube?.fetchedAt
      ? `updated ${ago(state.youtube.fetchedAt)}`
      : '';
  } catch (err) {
    els.state.textContent = 'offline';
    notice(
      `<h2>Cannot reach the server</h2><p>${err.message}</p>
       <p>Is <code>npm start</code> still running?</p>`,
      'is-error',
    );
  }
}

els.refresh.addEventListener('click', () => {
  els.refresh.disabled = true;
  poll({ force: true }).finally(() => {
    els.refresh.disabled = false;
  });
});

poll();
setInterval(poll, POLL_MS);
