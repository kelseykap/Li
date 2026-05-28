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
5. Add it to your phone home screen (Safari: Share → Add to Home Screen) for an app-like feel.

## Edit on phone, save to GitHub

The app uses your browser's local storage as a working copy. When you want to commit changes back to the repo, use **Settings → Sync to GitHub**.

To set that up once:

1. Create a [fine-grained personal access token](https://github.com/settings/tokens?type=beta):
   - **Repository access**: only this repo
   - **Permissions → Repository → Contents**: **Read and write**
2. In the app, open **Settings** and fill in:
   - Owner (your GitHub username)
   - Repo (the repo name)
   - Branch (usually `main`)
   - Path (`books.json` if you keep the default)
   - Token (paste it — stored only on this device's local storage)
3. Hit **Sync to GitHub**. From then on, the **Sync** button pushes a commit to `books.json`.

A header note ("Unsaved changes · sync to GitHub") reminds you when local edits haven't been pushed.

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
