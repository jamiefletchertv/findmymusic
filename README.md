# Find My Music

Point your phone camera at a CD or vinyl record (or pick a photo) and open the album on Spotify or Apple Music.

A static site with no build step, served by GitHub Pages.

## How it identifies an album

1. **Barcode**: read on the device and looked up in MusicBrainz.
2. **Cover recognition** (optional): if you save a Claude API key in Settings, the photo is sent to Anthropic's Claude, which recognises the cover even with no text on it. The key stays in your browser's local storage.
3. **Cover text**: with no key, the text on the cover is read on the device (Tesseract.js) and used as a search.

The match is then searched in Apple's catalogue, and the exact Spotify album link is found through Odesli (song.link). If that lookup fails, the Spotify button opens a Spotify search instead. You can always edit the text and search again.

## Hosting

Repository **Settings → Pages → Deploy from a branch**, pick the branch and `/ (root)`.

## Running locally

```
python3 -m http.server 8000
```

Camera access needs `https` or `localhost`.
