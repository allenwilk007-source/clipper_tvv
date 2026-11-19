# Connecting TikTok, YouTube and Instagram

The panel's TikTok, YouTube and Instagram buttons can only put a finished short
straight onto a platform through that platform's own API, and each API needs a
**developer app** registered by the account owner. That part is yours: only you
can sign in to the consoles, and the keys belong to your accounts. Once a set of
keys is in `.env`, the upload for that platform gets built and tested against
your real account.

**Never paste keys or secrets into a chat.** Put them in `.env` only. It is
git-ignored and never leaves this PC.

Do **YouTube first**. It is the only one whose sign-in can come back to
`http://localhost`, so it can be built and tested end to end on this machine.
TikTok and Instagram want an `https://` return address, which needs one more
piece of setup (see their sections).

Console labels move around. If a step's wording does not match exactly, look
for the nearest equivalent.

---

## YouTube (start here)

1. Open **console.cloud.google.com** and create a project, say "Clip poster".
2. **APIs & Services → Library**: search for **YouTube Data API v3** and
   enable it.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - Audience: **External**. Leave it in **Testing**.
   - App name and support email: anything you like.
   - Data access / scopes: add `https://www.googleapis.com/auth/youtube.upload`.
   - Test users: **add your own Google account**, the one that owns the channel.
4. **Clients → Create client**:
   - Application type: **Web application**.
   - Authorized redirect URI: `http://localhost:3000/auth/youtube/callback`
5. Copy the **Client ID** and **Client secret** into `.env`:

   ```
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   ```

What to expect:

- **Uploads stay private** until Google audits the project, which you request
  through the YouTube API Services audit form. Until then the button uploads
  the short as a private video with its title, description and tags, and opens
  it in YouTube Studio. You can review it there; making it public needs the
  audit.
- **Daily quota.** The default is 10,000 units a day, and one upload costs
  1,600, so about six uploads a day. More needs a quota increase request.
- While the app is in Testing, the sign-in lasts **7 days**, then you click
  Connect again.

---

## TikTok

1. Open **developers.tiktok.com**, log in with your TikTok account, and go to
   **Manage apps → Connect an app**.
2. Add the products **Login Kit** and **Content Posting API**.
3. Ask for the scopes **`user.info.basic`**, **`user.info.stats`**,
   **`video.list`** and **`video.upload`**. The first three are for the stats
   dashboard; `video.upload` is the one that posts.

   `video.upload` sends a short to your TikTok **inbox as a draft**: you get a
   notification in the app, open it, add a trending sound if you want one, and
   post. Sounds added in the app are the ones that actually ride a trend.

   The other endpoint, `video.publish`, posts straight to the profile with no
   tap — but the app must be approved for that scope **and pass TikTok's
   audit**, and until it does TikTok restricts everything an unaudited client
   posts to private viewing. So this tool uses the inbox. It does not try to
   get around the audit.
4. Redirect URI: `http://localhost:3000/auth/tiktok/callback`.

   TikTok's form asks for `https://` and may refuse the line above. If it
   does, give it an `https://` address you control, and put the same one in
   `.env` as `TIKTOK_REDIRECT_URI=` — it has to match character for character
   or the sign-in fails at the last step.
5. Copy the **Client key** and **Client secret** into `.env`:

   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   ```
6. Restart `npm start`, then press **Connect** next to TikTok in the page and
   approve it in TikTok. After that, set the TikTok switch to **Dry run** for a
   day to see which shorts it would send, or straight to **On: send drafts**.

   TikTok allows **5 pending inbox shares in any rolling 24 hours** — rolling,
   not a calendar day, so the slot frees up 24 hours after each one. Going
   above 5 just earns a refusal, which is why `TIKTOK_PER_DAY` defaults to 5.

   Because the inbox endpoint has no caption field, the caption this tool
   would have written — hook, credit and the link back to the stream — is
   written to the log for you to paste when you finish the post.

---

## Instagram

1. In the Instagram app, switch your account to **Professional** (Creator or
   Business): Settings → Account type and tools.
2. Open **developers.facebook.com → My Apps → Create app**, and pick the use
   case for **managing content on Instagram**.
3. Add **Instagram → API setup with Instagram login**, and add your Instagram
   account as an **Instagram tester** (then accept the invite in the Instagram
   app or website).
4. Permissions: `instagram_business_basic` and
   `instagram_business_content_publish`.
5. Redirect URI: like TikTok, this wants `https://`. Leave it for now.
6. Copy the **Instagram app ID** and **app secret** into `.env`:

   ```
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   ```

What to expect: while the app is in development mode, it can publish to
accounts that have a role on it (yours), which is all this needs. Instagram
publishes directly; there is no draft step, so the button will ask before
posting.

---

## When the keys are in

YouTube is built; Instagram and TikTok are not yet.

1. Restart the app. The panel's **Auto upload** box shows YouTube.
2. Click **Connect**. Google asks you to sign in and allow uploads to your
   channel, then sends you back to the page. The sign-in is kept in
   `data/youtube-token.json` (git-ignored). While the Google project is in
   Testing, it lasts 7 days; when it lapses, uploads stop and the box says
   so — click Connect again.
3. Set the mode to **Dry run** first. Everything happens except the upload:
   it picks, checks and titles shorts at the real pace, and writes each one
   to `data/upload-dry-run.jsonl`. Read a day of that before going live.
4. Set it to **On**. From then on, about every three hours it uploads the
   best short it has, up to five a day.

What it posts, and what it never does:

- **It chooses.** The pipeline makes dozens of shorts a day; YouTube takes
  about six. Only shorts above the engagement meter's keep line, never one
  flagged weak, best score first. The rest stay in `clips/ready` for you.
- **It checks again at post time.** The video is decoded and checked, its
  game must be one you clip, and its title and tags are rebuilt from its own
  recorded game. `clips/rejected` is never read.
- **Never twice.** Each short is claimed before its upload starts, and the
  claim survives restarts. An upload cut off by a crash is not retried —
  it may have landed — and the box tells you to check the channel.
- **Failures:** quota spent stops uploads until midnight Pacific (YouTube's
  day, not a rolling 24 hours); a lapsed sign-in stops them until you
  reconnect; a video YouTube refuses is never tried again; only a network or
  server error is retried, after the spacing.
- **Nothing pretends to be a person.** Spacing is even, the API is YouTube's
  own, and the account is yours, signed in by you.
