'use strict';

const CLAUDE_MODEL = 'claude-haiku-5-5';
const MAX_IMAGE_SIDE = 1568;
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const READER_SIZE_MB = 275;

const COUNTRIES = {
  GB: 'United Kingdom', US: 'United States', IE: 'Ireland', CA: 'Canada', AU: 'Australia',
  NZ: 'New Zealand', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', JP: 'Japan', BR: 'Brazil', MX: 'Mexico',
};

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), preview: $('preview'), hint: $('stageHint'),
  cameraBtn: $('cameraBtn'), shutterBtn: $('shutterBtn'), fileInput: $('fileInput'),
  status: $('status'), form: $('searchForm'), query: $('query'), results: $('results'),
  apiKey: $('apiKey'), saveKey: $('saveKey'), keyState: $('keyState'), country: $('country'),
  settings: $('settings'), keyHint: $('keyHint'),
};

const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* private mode */ }
  },
};

let stream = null;
let searchRun = 0;

/* ---------- small helpers ---------- */

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  els.cameraBtn.disabled = busy;
  els.shutterBtn.disabled = busy;
}

const scripts = {};
function loadScript(url) {
  scripts[url] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => { delete scripts[url]; reject(new Error('Could not load ' + url)); };
    document.head.append(s);
  });
  return scripts[url];
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const name = '__fmm' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = (fn, value) => {
      clearTimeout(timer);
      delete window[name];
      s.remove();
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('Search timed out')), 12000);
    window[name] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error('Search failed'));
    s.src = url + '&callback=' + name;
    document.head.append(s);
  });
}

function country() {
  return els.country.value || 'GB';
}

/* ---------- capture ---------- */

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    });
  } catch {
    setStatus('Camera not available. Choose a photo instead.', true);
    return;
  }
  els.video.srcObject = stream;
  await els.video.play();
  els.video.hidden = false;
  els.preview.hidden = true;
  els.hint.hidden = true;
  els.cameraBtn.hidden = true;
  els.shutterBtn.hidden = false;
  setStatus('Fill the square with the cover or barcode, then take the photo.');
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.video.hidden = true;
  els.shutterBtn.hidden = true;
  els.cameraBtn.hidden = false;
}

function toCanvas(source, width, height) {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function takePhoto() {
  const canvas = toCanvas(els.video, els.video.videoWidth, els.video.videoHeight);
  stopCamera();
  identify(canvas);
}

async function fileChosen() {
  const file = els.fileInput.files[0];
  els.fileInput.value = '';
  if (!file) return;
  stopCamera();
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    identify(toCanvas(bitmap, bitmap.width, bitmap.height));
  } catch {
    setStatus('That file could not be read as a photo.', true);
  }
}

/* ---------- identification ---------- */

async function identify(canvas) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  els.preview.src = dataUrl;
  els.preview.hidden = false;
  els.hint.hidden = true;
  els.results.replaceChildren();
  setBusy(true);

  try {
    setStatus('Looking for a barcode…');
    const key = store.get('claudeKey');
    const barcode = await readBarcode(canvas, dataUrl, !key);
    if (barcode) {
      const release = await lookupBarcode(barcode);
      if (release) return await runSearch(release, `Barcode ${barcode}`);
    }

    if (key) {
      setStatus('Asking Claude to recognise the cover…');
      const guess = await askClaude(dataUrl.split(',')[1], key);
      const query = [guess.artist, guess.album].filter(Boolean).join(' ').trim();
      if (!query) {
        setStatus('Could not recognise that one. Try another angle, or type it below.', true);
        return;
      }
      const sure = guess.confidence === 'low' ? 'Best guess' : 'Recognised';
      return await runSearch(query, sure);
    }

    setStatus('Getting the text reader ready…');
    const lines = await readCoverText(canvas);
    if (!lines.length) {
      setStatus('Could not read any text on that cover. Add a Claude API key in Settings to recognise covers, or type it below.', true);
      els.settings.open = true;
      return;
    }
    await runSearch(lines.map((l) => l.text).join(' '), 'Read from the cover', lines);
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', true);
  } finally {
    setBusy(false);
  }
}

async function readBarcode(canvas, dataUrl, allowLibrary) {
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      const found = await detector.detect(canvas);
      if (found.length) return found[0].rawValue;
      return null;
    } catch { /* fall through to the library */ }
  }
  if (!allowLibrary) return null;
  try {
    await loadScript(ZXING_URL);
    const result = await new ZXing.BrowserMultiFormatReader().decodeFromImageUrl(dataUrl);
    const text = result.getText();
    return /^\d{8,14}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

async function lookupBarcode(barcode) {
  const variants = [barcode];
  if (barcode.length === 12) variants.push('0' + barcode);
  if (barcode.length === 13 && barcode[0] === '0') variants.push(barcode.slice(1));
  const q = `barcode:(${variants.join(' OR ')})`;
  try {
    const res = await fetch(`https://musicbrainz.org/ws/2/release/?fmt=json&limit=1&query=${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    const release = (await res.json()).releases?.[0];
    if (!release) return null;
    const artist = (release['artist-credit'] || []).map((c) => c.name).join(' ');
    return `${artist} ${release.title}`.trim();
  } catch {
    return null;
  }
}

async function askClaude(base64, key) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2026-10-21',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        output_config: { effort: 'low' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            {
              type: 'text',
              text: 'This photo shows a music release: a CD, vinyl record or cassette. It may be the front cover, '
                + 'back cover, spine or disc label. Identify the release from the artwork and any visible text. '
                + 'Reply with only a JSON object, no other text: '
                + '{"artist": string, "album": string, "confidence": "high" | "medium" | "low"}. '
                + 'Use empty strings for artist and album if you cannot tell.',
            },
          ],
        }],
      }),
    });
  } catch {
    throw new Error('Could not reach Claude. Check your connection.');
  }

  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Claude rejected the API key. Check it in Settings.');
  if (res.status === 429) throw new Error('Claude is rate limiting this key. Try again in a moment.');
  if (!res.ok) throw new Error(body.error?.message || `Claude returned an error (${res.status}).`);
  if (body.stop_reason === 'refusal') throw new Error('Claude declined to look at that photo.');

  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); } catch { return {}; }
}

// Reads the cover with a small vision model in a worker. Resolves to lines of text, each with
// the height of its box. The model is downloaded once and then kept by the browser.
let reader;
let readId = 0;
function readCoverText(canvas) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('The on-device text reader could not run here. Type the album below, or add a Claude API key in Settings.'));
    const id = ++readId;
    try {
      reader ||= new Worker('ocr-worker.js?v=4', { type: 'module' });
    } catch {
      return fail();
    }
    reader.onerror = () => { reader = null; fail(); };
    reader.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const mb = Math.min(READER_SIZE_MB, Math.round(data.loaded / 1e6));
        setStatus(`Downloading the text reader (one time): ${mb} of ${READER_SIZE_MB} MB…`);
      } else if (data.type === 'reading') {
        setStatus('Reading the text on the cover…');
      } else if (data.id === id && data.type === 'done') {
        resolve(data.lines.filter((l) => /\p{L}{2,}|\p{N}{2,}/u.test(l.text)).slice(0, 6));
      } else if (data.id === id) {
        fail();
      }
    };
    canvas.toBlob((blob) => reader.postMessage({ id, blob }), 'image/jpeg', 0.9);
  });
}

/* ---------- search and results ---------- */

function spotifySearchUrl(query) {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}/albums`;
}

function appleSearchUrl(query) {
  return `https://music.apple.com/${country().toLowerCase()}/search?term=${encodeURIComponent(query)}`;
}

async function searchAlbums(query) {
  try {
    const url = 'https://itunes.apple.com/search?media=music&entity=album&limit=6'
      + `&country=${country()}&term=${encodeURIComponent(query)}`;
    return (await jsonp(url)).results || [];
  } catch {
    return []; // shown as "no match", with search links
  }
}

// `lines` is text read off a cover. Small print (stickers, catalogue numbers) is rarely the
// artist or title, so while nothing matches, drop the smallest line and search again.
async function runSearch(query, source, lines = null) {
  const run = ++searchRun;
  els.query.value = query;
  setStatus(`${source ? source + ': ' : ''}searching for “${query}”…`);

  let albums = await searchAlbums(query);
  if (lines) {
    const left = [...lines];
    while (!albums.length && left.length > 1 && run === searchRun) {
      left.splice(left.indexOf(left.reduce((a, b) => (b.height < a.height ? b : a))), 1);
      const shorter = left.map((l) => l.text).join(' ');
      albums = await searchAlbums(shorter);
      if (albums.length) {
        query = shorter;
        els.query.value = query;
      }
    }
  }
  if (run !== searchRun) return;

  // Always offer a direct search for what was read or typed: Apple's catalogue has gaps,
  // and a search on the service itself usually puts the album first.
  const direct = document.createElement('div');
  direct.className = 'direct';
  const label = document.createElement('p');
  label.textContent = `Search for “${query}” on:`;
  const links = document.createElement('div');
  links.className = 'links';
  links.append(
    link('Spotify', spotifySearchUrl(query), 'spotify'),
    link('Apple Music', appleSearchUrl(query), 'apple'),
  );
  direct.append(label, links);
  els.results.replaceChildren(direct);

  if (!albums.length) {
    setStatus(lines
      ? `Read “${query}” off the cover but found no album match. Fix the text below, or use the search buttons.`
      : `No album match for “${query}”. Edit the text and search again, or use the search buttons.`, true);
    return;
  }

  setStatus(`${source ? source + ': ' : ''}“${query}”. Not right? Edit the text and search again.`);
  const heading = document.createElement('h2');
  heading.textContent = 'Albums found';
  els.results.append(heading, ...albums.map(albumCard));
}

function link(text, href, cls) {
  const a = document.createElement('a');
  a.className = `button ${cls}`;
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function albumCard(album) {
  const el = document.createElement('article');
  el.className = 'album';

  const img = document.createElement('img');
  img.src = (album.artworkUrl100 || '').replace('100x100', '300x300');
  img.alt = '';
  img.loading = 'lazy';

  const body = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = album.collectionName;
  const meta = document.createElement('p');
  const year = (album.releaseDate || '').slice(0, 4);
  meta.textContent = [album.artistName, year].filter(Boolean).join(' · ');

  const name = `${album.artistName} ${album.collectionName}`.replace(/\s*[([].*?[)\]]/g, '');
  const spotify = link('Spotify', spotifySearchUrl(name), 'spotify');
  const apple = link('Apple Music', album.collectionViewUrl, 'apple');
  const links = document.createElement('div');
  links.className = 'links';
  links.append(spotify, apple);

  body.append(title, meta, links);
  el.append(img, body);
  return el;
}

/* ---------- settings ---------- */

function showKeyState() {
  const key = store.get('claudeKey');
  els.keyState.textContent = key
    ? `Key saved (ends …${key.slice(-4)}). Cover recognition is on.`
    : 'No key saved. Using barcode and cover text only.';
  els.keyHint.hidden = Boolean(key);
  els.apiKey.value = '';
  els.apiKey.placeholder = key ? 'Paste a new key to replace, or leave empty and Save to remove' : 'sk-ant-…';
}

function initCountry() {
  for (const [code, name] of Object.entries(COUNTRIES)) {
    els.country.append(new Option(name, code));
  }
  const guess = (navigator.language || '').split('-')[1]?.toUpperCase();
  els.country.value = store.get('country') || (COUNTRIES[guess] ? guess : 'GB');
  els.country.addEventListener('change', () => store.set('country', els.country.value));
}

/* ---------- wiring ---------- */

els.cameraBtn.addEventListener('click', startCamera);
els.shutterBtn.addEventListener('click', takePhoto);
els.fileInput.addEventListener('change', fileChosen);
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const query = els.query.value.trim();
  if (query) runSearch(query, '');
});
els.saveKey.addEventListener('click', () => {
  store.set('claudeKey', els.apiKey.value.trim());
  showKeyState();
});

if (!navigator.mediaDevices?.getUserMedia) els.cameraBtn.hidden = true;
els.keyHint.querySelector('button').addEventListener('click', () => {
  els.settings.open = true;
  els.apiKey.focus();
});
initCountry();
showKeyState();
