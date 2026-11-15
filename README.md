# Find My Music

Point your phone camera at a CD or vinyl record (or pick a photo) and open the album on Spotify or Apple Music.

A static site with no build step, served by GitHub Pages.

## How it identifies an album

1. **Barcode**: read on the device and looked up in MusicBrainz.
2. **Cover recognition** (optional): if you save a Claude API key in Settings, the photo is sent to Anthropic's Claude, which recognises the cover even with no text on it. The key stays in your browser's local storage.
3. **Cover text**: with no key, a small vision model (Florence-2, run in the browser with Transformers.js) reads the text on the cover and that is used as a search. The model is a one-time download of about 275 MB.

The match is then searched in Apple's catalogue. The Apple Music button opens the album itself; the Spotify button opens a Spotify album search for it.

For exact Spotify album links, connect Spotify in Settings: create an app at developer.spotify.com/dashboard, add the site address as its redirect URI, and paste the client ID. The app signs in with Spotify's PKCE flow (no secret) and then searches Spotify's catalogue directly. You can always edit the text and search again.

## Hosting

Every push runs `.github/workflows/pages.yml`, which publishes the site to GitHub Pages. If the first run fails at "Configure Pages", set **Settings → Pages → Source** to **GitHub Actions** once and re-run it.

## Running locally

```
python3 -m http.server 8000
```

Camera access needs `https` or `localhost`.
