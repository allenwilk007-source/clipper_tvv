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
3. Ask for the scope **`video.upload`**. That sends a short to your TikTok
   **inbox as a draft**: you get a notification in the app, open it, add a
   trending sound if you want one, and post. That is the closest thing to
   "opens ready to be posted", and sounds added in the app are the ones that
   actually ride a trend.
   (`video.publish`, which posts directly, stays **private-only** until TikTok
   audits the app.)
4. Redirect URI: TikTok wants an `https://` address. Leave this blank for now:
   it gets set up when the TikTok upload is built.
5. Copy the **Client key** and **Client secret** into `.env`:

   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   ```

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

Restart the app. The panel will show a **Connect** button for each platform it
has keys for. Connect signs you in once, and each short's platform button then
uploads instead of opening the upload page.
