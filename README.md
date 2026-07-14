# Library

A minimal, mobile-first web app for tracking books read and TBR. No build step — just static files.

## Files

- `index.html` — markup, styles, bottom nav
- `app.js` — all app logic (router, views, storage, GitHub sync, Kindle parser)
- `books.json` — your library data, version-controlled in this repo

## Run locally

```bash
# any static server works; from this folder:
python3 -m http.server 8000
# then open http://localhost:8000 on your phone or browser
```

## Deploy on GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo, go to **Settings → Pages**.
3. Source: **Deploy from branch**, branch: `main`, folder: `/ (root)`. Save.
4. After a minute, your app is live at `https://<your-username>.github.io/<repo>/`.
5. Install it on your phone for a full-screen, app-like experience:
   - **Android Chrome**: open the URL, then tap the ⋮ menu → **Install app** (or **Add to home screen**). If you don't see "Install app", visit the site once, navigate around, then re-open the menu — Chrome sometimes waits for engagement before offering install.
   - **iPhone Safari**: open the URL, tap Share → **Add to Home Screen**.

The placeholder icon is a simple "L" — swap out `icon-192.png`, `icon-512.png`, `icon-192-maskable.png`, `icon-512-maskable.png`, and `apple-touch-icon.png` whenever you've got your real artwork.

## Edit on phone, save to the cloud

Once you set up a storage backend, **every edit you make auto-pushes to the cloud** about a second after you save. Rapid edits batch into a single push. This means your library is always backed up — even if you clear your browser data, your books survive in the cloud.

You can pick between two backends in **Settings → Storage backend**:

### Option A — Google Drive (recommended for ease of use)

One-time setup (~10 minutes):

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a new project (any name).
2. In that project, **APIs & Services → Library**, find **Google Drive API** and click **Enable**.
3. **APIs & Services → OAuth consent screen**: choose External, fill in the required fields (app name, your email as user support and developer contact), save and continue through the scopes/test users screens without adding anything.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorised JavaScript origins: add your app's URL (e.g. `https://your-username.github.io` — no trailing slash, no path)
   - Click Create; copy the **Client ID** (it ends in `.apps.googleusercontent.com`)
5. In the app: **Settings → Google Drive**, paste the Client ID, tap **Save Client ID**, then **Sign in with Google**.
6. If you already had books in GitHub sync: tap **Migrate books from GitHub → Drive**. Your library is copied over in one push.

Your data lives in Drive's `appDataFolder` — a private per-app folder that doesn't show up in your normal Drive view. Only this app (with this Client ID) can read it.

### Option B — GitHub (version control bonus)

1. Create a [fine-grained personal access token](https://github.com/settings/tokens?type=beta) with **Contents: read & write** on your library repo. (Or a classic PAT with `repo` scope for no expiration.)
2. In the app, **Settings → GitHub**: fill in owner, repo, branch, path, and paste the token.

Every edit becomes a git commit — you get free version history of your reading log.

### Common behavior

The sync banner at the top of Library and Settings tells you the current state: synced, syncing, pending, offline, error, or not configured. If auto-sync fails (e.g. token expired), you'll see the error and edits stay on your device until you fix the issue — then a retry runs automatically.

**Multi-device:** when you open the app on another device, it fetches the latest library from your backend and merges with the local copy on a per-book basis. A book that exists on one device but not the other is preserved.

## Getting code updates

You **shouldn't ever need to clear site data** to get new features. The service worker uses a network-first strategy — every time you open the app while online, it checks for fresh code and uses the new version immediately. The cache is only there as an offline fallback. When a new version is detected, the page auto-reloads once so you're on the latest build.

## Importing Kindle highlights

1. Plug your Kindle into a computer with a USB cable.
2. The Kindle appears as a drive. Open it, then the `documents/` folder.
3. Copy `My Clippings.txt` to your phone (AirDrop, email, iCloud Drive — whatever).
4. In the app, **Settings → Kindle highlights → choose file**.
5. The app parses all highlights, matches them to books in your library by title, and lets you bulk-add them as quotes.

Unmatched books are shown but disabled — add them to your library first if you want their quotes.

## Covers

When adding/editing a book, tap **Find cover from Open Library**. It searches by title + author and pulls the first result's cover. You can also paste any image URL into the Cover field manually.

## Map

Locations you enter (e.g. `Dublin, Ireland`) are geocoded with OpenStreetMap's Nominatim when you save. If you have older books without coordinates, open the **Map** tab and tap **Geocode all** — it processes them at ~1 per second (Nominatim's rate limit).

## Stats notes

- "Books read this year" counts books with status Read and a Date Read in the current calendar year.
- "Reading pace" assumes physical books are read consecutively, so time taken = days between this book's date read and the previous physical book's date read. Audiobooks are excluded from pace calculations (per your reading habits).

## Reset

**Settings → Discard local edits** wipes your local working copy and reloads `books.json` from the repo. Useful if you mess something up locally and want to start over from the last synced version.

## Data format

`books.json` shape:

```json
{
  "version": 1,
  "updatedAt": "2026-...",
  "books": [
    {
      "id": "abc123",
      "title": "...",
      "author": "...",
      "publicationDate": "YYYY-MM-DD",
      "pageCount": 320,
      "location": "Dublin, Ireland",
      "lat": 53.34, "lng": -6.26,
      "status": "read",
      "rating": 3,
      "dateRead": "YYYY-MM-DD",
      "genre": "...",
      "medium": "book",
      "coverUrl": "...",
      "notes": "...",
      "quotes": [],
      "bookmarked": false,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

Rating scale: **1** ok · **2** good · **3** loved · **4** favourite.
