# PrivateScan Web (PWA)

Browser / PWA document scanner for testing a **GitHub-hosted** path: no App Store install.

**Flow:** capture or upload → **drag page-corner frame** → flatten (perspective warp) → colour mode → download PDF. Processing runs in your browser; this static site does not upload your documents to a server.

## Try locally

From this folder (needs any static file server — module imports require `http://`, not `file://`):

```bash
python -m http.server 4173
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Deploy on GitHub Pages

1. Create a GitHub repo and push this folder to `main` (or `master`).
2. Repo **Settings → Pages → Build and deployment → Source**: **GitHub Actions**.
3. Push once (or run the **Deploy to GitHub Pages** workflow). Site URL will look like:
   `https://<user>.github.io/<repo>/`

The workflow is in [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

### Install as PWA

- **Android Chrome:** Install / Add to Home Screen when prompted (or use **Install** in the header).
- **iPhone Safari:** Share → **Add to Home Screen**.

## What this proves

| Capability | Status |
| --- | --- |
| Host UI on GitHub Pages | Yes |
| Camera + image upload | Yes |
| Manual 4-corner page frame + perspective flatten | Yes |
| PDF long-edge matches High/Balanced/Compact (1400–2400px) | Yes |
| Greyscale / B&W + rotate / reorder | Yes |
| Multi-page PDF download | Yes (pdf-lib via CDN) |
| Offline shell (service worker) | Yes |
| Auto edge detection (VisionKit-class) | Not yet — corners start inset; you drag them |
| On-device OCR | No — different product |

Native iOS PrivateScan remains the privacy + quality reference. This repo is for deciding whether a web/PWA option is enough for your use case.

## Privacy note

Images and PDFs are processed in the browser tab. The app shell and `pdf-lib` are loaded from this origin / jsDelivr CDN. No document upload API is implemented here.
