# Kokoro TTS Reader Extension

A cross-browser (Chrome + Firefox) extension that reads web pages aloud using Kokoro TTS with real-time text highlighting.

## Features

- **Text-to-Speech**: Uses Kokoro TTS (via kokoro-js) for natural-sounding speech synthesis
- **Real-time Highlighting**: Highlights the currently spoken text in yellow
- **Voice Selection**: Choose from available Kokoro voices
- **Speed Control**: Adjust playback speed (0.5x to 2.0x)
- **Selection Mode**: Read only selected text or entire page
- **Keyboard Shortcuts**: Alt+Shift+S (toggle play/pause), Alt+Shift+X (stop)
- **Cross-browser**: Works in Chrome and Firefox
- **Zero Setup**: No compilation required - loads kokoro-js automatically

## Setup Instructions

### 1. Prerequisites

- Chrome or Firefox browser with internet connection
- WebGPU support (recommended) or fallback to WASM

### 2. TTS Worker Setup

The TTS worker runs as a dedicated MV3 worker (`ttsWorker.js`). It imports `kokoro-js` from a vendored local ESM file at `vendor/kokoro-js.mjs` to comply with MV3 CSP restrictions (remote code in `script-src` is disallowed).

The worker implements the expected message protocol:

**Incoming messages:**
- `{ id, type: 'init', payload: { modelId, dtype, device } }`
- `{ id, type: 'voices' }`
- `{ id, type: 'generate', payload: { text, voice, speed } }`

**Outgoing messages:**
- `{ id, ok: true }` (for init)
- `{ id, ok: true, voices: string[] }` (for voices)
- `{ id, ok: true, audioWav: ArrayBuffer }` (for generate)
- `{ id, ok: false, error: string }` (on error)

**Vendoring kokoro-js (1.2.1):**

1. Download or build an ESM bundle of `kokoro-js@1.2.1` and its ESM dependencies.
2. Place the entry module at `vendor/kokoro-js.mjs` (create `vendor/` if absent).
3. Ensure any relative imports resolve locally (no remote `script-src`).
4. Model assets fetched at runtime should come from hosts allowed by `connect-src` (Hugging Face/CDN URLs are permitted in the manifest).

### 3. Add Extension Icons

Replace the placeholder files in the `icons/` directory with actual PNG files:

- `icon16.png` (16×16 pixels) - Small tab icon
- `icon48.png` (48×48 pixels) - Extension management icon
- `icon128.png` (128×128 pixels) - Store listing icon

### 4. Load the Extension

#### Chrome:
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this extension directory

#### Firefox:
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select the `manifest.json` file

## Usage

1. Navigate to any **regular webpage** with readable content (not chrome:// or extension pages)
2. Click the extension icon in your browser toolbar
3. Select a voice from the dropdown (loads after first model download)
4. Adjust speed if desired
5. Check "Read selection only" to read only selected text
6. Click "Start" to begin reading
7. Use "Pause"/"Resume"/"Stop" buttons or keyboard shortcuts:
   - **Alt+Shift+S**: Toggle play/pause
   - **Alt+Shift+X**: Stop reading

**Note:** The extension is not available on browser internal pages (chrome://, about:, etc.) or other extension pages.

## How It Works

- **Text Extraction**: Automatically finds readable paragraphs, headings, and list items
- **Chunking**: Splits long text into manageable chunks (~220 characters)
- **Highlighting**: Temporarily applies yellow background to currently spoken elements
- **TTS Generation**: Sends text chunks to your Kokoro worker for audio generation
- **Playback**: Plays generated audio while highlighting corresponding text

## File Structure

```
tts_extension/
├── manifest.json          # Extension configuration
├── popup.html            # Extension popup UI
├── popup.js              # Popup interaction logic
├── popup.css             # Popup styling
├── content.js            # Page content script
├── content.css           # Highlighting styles
├── ttsEngine.js          # Worker communication adapter
├── ttsWorker.js          # Your compiled Kokoro TTS worker
└── icons/
    ├── icon16.png        # 16px browser icon
    ├── icon48.png        # 48px management icon
    └── icon128.png       # 128px store icon
```

## Permissions

The extension requests these permissions:
- `activeTab`: Access current tab for reading content
- `scripting`: Inject content scripts
- `storage`: Save user preferences
- Host permissions for model downloads from Hugging Face/CDN

## Troubleshooting

### Voices list is empty
- Check the browser console for errors during model loading
- Ensure you have a stable internet connection for initial model download
- The model may take time to load on first use (check browser network tab)

### Model fetch blocked
- Add missing host permissions in `manifest.json`
- Update CSP in manifest if needed

### Highlighting doesn't work
- Check that content scripts are loading (no console errors)
- Verify the page allows content script injection

### WebGPU fails
- The engine automatically falls back to WASM
- Check browser WebGPU support or update drivers

### "Could not establish connection" or "Extension not available on this page"
- The extension doesn't work on browser internal pages (chrome://, about:, edge://)
- Navigate to a regular website (http:// or https://)
- The popup will show "Extension not available on this page" on unsupported URLs

## Development

To modify the extension:
1. Edit the source files
2. Reload the extension in browser developer tools
3. Test on various websites

## Deployment

### Chrome Web Store
1. Zip the extension files (excluding development files)
2. Upload to Chrome Web Store dashboard
3. Complete store listing requirements

### Firefox Add-ons (AMO)
1. Upload the same zip to Firefox Add-ons
2. Use the Gecko ID from manifest.json

## License

[Add your license here]
