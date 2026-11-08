<div align="center">

<img src="assets/icon.png" width="96" alt="MDM - Mohamed Download Manager" />

# MDM — Mohamed Download Manager

**Every download. At full throttle.**

A fast, local-first download manager for Windows 10 and 11 — segmented transfers, browser capture, queues, schedules, site rules, and HLS/DASH/YouTube media downloads in one desktop app.

[![Download for Windows](https://img.shields.io/badge/Download%20for%20Windows-MDM%202.6-3AE2C8?style=for-the-badge&logo=windows&logoColor=white)](https://mdm-download-manager-mohamed-ashraf.vercel.app/)
[![License](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D4?style=for-the-badge&logo=windows&logoColor=white)](#requirements)

**[Live download page](https://mdm-download-manager-mohamed-ashraf.vercel.app/)** · [Features](#features) · [Run from source](#run-from-source) · [Build an installer](#build-a-windows-installer)

<img src="assets/screenshot.png" width="930" alt="MDM desktop app showing the Downloads screen, segmented transfers, speed, and queues" />

</div>

> **Independence notice:** MDM is an original, clean-room project. It is not affiliated with, derived from, or endorsed by Internet Download Manager (IDM) or any commercial download manager.

<p align="center">
  <img src="assets/screenshot.png" width="920" alt="MDM desktop app showing active downloads, speed charts, and segmented transfer progress" />
</p>

## Download

The latest stable Windows build is available from the official website:

### [Download MDM 2.6 for Windows →](https://mdm-download-manager-mohamed-ashraf.vercel.app/)

Source code: [github.com/MohamedAshraf366/MDM-DowloadManager](https://github.com/MohamedAshraf366/MDM-DowloadManager)

| | |
|---|---|
| **Version** | 2.6.0 |
| **Platform** | Windows 10 / 11 (x64) |
| **Installer** | `MDM-Setup-2.6.exe` (225,775,600 bytes, 215 MiB) |
| **SHA-256** | `BE23EDA4482F20812CC658EFD16880ECC447AD5167DC38156941B752B768F81E` |
| **Browser add-ons** | Chrome / Edge and Firefox packages are available on the download page. |

The SHA-256 above is for the 2.6 installer built from this checkout. Rebuilding locally produces a new binary, so compare the downloaded file against the hash shown on the official page.

Verify the installer before running it:

```powershell
Get-FileHash .\MDM-Setup-2.6.exe -Algorithm SHA256
```

The installer is an NSIS package. It creates Start Menu and desktop shortcuts, allows choosing the install directory, and keeps your database when uninstalling by default.

## What is MDM?

MDM is a Windows desktop download manager built with Electron, React, and TypeScript. It runs entirely on your machine: downloads, queues, rules, settings, and history are stored locally in SQLite. There is no account, cloud sync, or telemetry.

The transfer engine opens up to eight connections per download, resumes interrupted transfers from checkpoints, and adapts when a server rejects range requests. A browser extension hands links from Chrome, Edge, or Firefox to the desktop app over a token-protected loopback bridge. The same app can also download direct HLS VOD and basic static DASH manifests, and uses the bundled `yt-dlp` + FFmpeg tools for supported media pages.

**Tech stack:** Electron 44 · React 19 · TypeScript 5.9 · Vite 8 · SQLite via `node:sqlite` · Vitest · Playwright.

## Features

### Fast, resilient transfers

- Segmented HTTP/HTTPS downloads with up to 8 connections per file.
- Resume, checkpoint recovery, adaptive retry/backoff, redirects, cookies, proxy support, and optional global/per-download speed limits.
- Worker-pool scheduling that reassigns part of a slow segment to an idle connection.
- Automatic single-stream fallback for servers and signed CDN links that do not support range requests.
- Streaming writes and sparse positioned I/O, so multi-GB files are not loaded into memory.
- FTP downloads alongside HTTP/HTTPS.
- Optional **Turbo mode** (Settings → Transfers): while a download runs, MDM adds connections until the measured speed stops rising, whatever your line speed is, then holds there. It never assumes a number; it only watches throughput. Extra connections are released when the download ends, it backs off if the server answers 429/503 or resets connections, and it is skipped when a speed limit is set. It learns what each network delivers, separately for every network you connect to, and uses that only as a starting point: a faster network (or a faster plan) is found by measuring, never capped by an old figure.
- Disk-space checks before a transfer starts.
- SHA-256, SHA-1, and MD5 checksum verification.

### Queues, schedules, and rules

- Priority queues with concurrency limits.
- Pause/resume, startup recovery, and optional completion actions.
- Recurring schedules with start/stop windows that can start a queue, stop a queue, resume everything, or pause everything.
- Category rules for video, audio, documents, archives, images, programs, and other files.
- Destination management, duplicate handling (`rename`, `skip`, `overwrite`), default headers, and per-download overrides.
- Site rules with exact or wildcard hosts and file-type filters. The most specific rule wins; actions are `auto`, `ask`, or `ignore`.

### Browser integration

- Chrome/Edge Manifest V3 and Firefox Manifest V3 extensions.
- Context-menu download handoff.
- Optional automatic capture of browser downloads; the browser copy is cancelled only after MDM accepts the transfer.
- Pairing over `http://127.0.0.1:41731` with a generated bearer token, pinned to the Chrome/Edge extension ID and confirmed in MDM for every request; Firefox uses a manual token.
- Restores and focuses the app, opens Downloads, and scrolls to the new transfer.
- Toast notifications for started, completed, and failed downloads with retry, details, and open actions.
- Quality overlays for YouTube, generic HTML5 video, and players inside cross-origin iframes.
- Network-level media sniffing for HLS/DASH manifests, extensionless signed URLs, and media loaded inside workers.
- **Show video overlays** action in the extension popup to restore hidden controls.

### Media downloads

- YouTube and other `yt-dlp`-supported pages with video quality selection.
- Audio-only M4A, MP3, WebM/Opus, and other native `yt-dlp` audio formats.
- FFmpeg muxing for video + audio.
- Page cookies scoped to the page's own site and the Windows certificate store trusted by both the HTTP and yt-dlp engines.
- Unencrypted HLS VOD: master/media playlists, byte-range segments, relative URLs, and fMP4 initialization sections.
- Basic static DASH manifests with representation selection.
- Encrypted HLS, DRM-protected content, live streams, paywalled, and members-only content are intentionally unsupported. MDM does not bypass DRM or access controls.

### Desktop experience

- Light and dark themes with a native titlebar overlay.
- System tray integration and close-to-tray behavior.
- In-app and native notifications; optionally show native notifications only while the app is in the background.
- Taskbar progress and activity logs.
- Local SQLite database using the built-in `node:sqlite` module (no native database addon).

### Local-first and secure

- Renderer isolation, no Node integration, and a narrow typed preload API.
- The browser bridge listens only on `127.0.0.1`, requires a bearer token, enforces CORS and request-size limits, and rate-limits requests.
- Proxy credentials and the bridge token are encrypted at rest with Electron `safeStorage` / Windows DPAPI.
- TLS validation is on by default; a broken certificate chain can only be allowed per download, never globally.
- Downloaded executables are never launched automatically.
- No telemetry, cloud sync, or account required.
- MDM does not bypass DRM, paywalls, or access controls.

## Requirements

- **Windows 10 or 11 (x64)**
- **Node.js 24+** and **npm 11+** for development
- **Git** and **Git LFS** if you clone the repository (the bundled media tools are stored in LFS; a GitHub ZIP download contains only LFS pointer files for them)

The packaged app bundles `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe` under `resources/tools`. Development uses the binaries in `tools/`; if they are missing, MDM falls back to `ffmpeg` and `yt-dlp` on `PATH`. The bundled FFmpeg is the [BtbN GPL build](https://github.com/BtbN/FFmpeg-Builds) (GPL v3).

## Run from source

```powershell
git lfs install
git clone https://github.com/MohamedAshraf366/MDM-DowloadManager.git
cd MDM-DowloadManager
git lfs pull
npm ci
npm run dev
```

`npm run dev` compiles the main process, starts Vite on port `5173`, watches the main process, and launches Electron.

### Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app in development mode |
| `npm run verify` | Typecheck + lint + tests + production build |
| `npm test` | Run the Vitest suite |
| `npm run smoke` | Build and run an end-to-end Electron smoke test |
| `npm run smoke:extension` | Load the extension in Chromium and test pairing/overlays |
| `npm run smoke:fuses` | Verify the packaged executable's Electron fuses |
| `npm run bench:http` | Run the opt-in local HTTP throughput benchmark |
| `npm run package` | Build the Windows x64 NSIS installer in `release/` |
| `npm run package:signed` | Build and code-sign the Windows installer (requires a certificate) |
| `npm run package:portable` | Build a portable Windows executable |
| `npm run smoke:packaged` | Smoke-test the packaged app |
| `npm run build:extension` | Rebuild/sync the Chrome, Edge, and Firefox extension files |
| `npm run icons` | Regenerate icons from `scripts/generate-icons.ps1` |

## Build a Windows installer

```powershell
npm ci
npm run verify
npm run package
```

The installer is written to `release/MDM-Setup-2.6.exe`. Builds are not produced by CI because packaging requires Windows and the bundled tools. Attach the installer to a GitHub Release instead of committing it.

### Code signing

`npm run package` builds an unsigned installer so local builds work without a certificate. For a release build, provide a code-signing certificate and use the signing profile:

```powershell
$env:CSC_LINK = 'C:\path\to\certificate.pfx'   # or WIN_CSC_LINK, or an https:// URL electron-builder can download
$env:CSC_KEY_PASSWORD = 'certificate-password'  # or WIN_CSC_KEY_PASSWORD
npm run package:signed
```

`package:signed` refuses to start without `CSC_LINK` or `WIN_CSC_LINK`, or when a local certificate path does not exist. An `http://` or `https://` certificate URL is passed through to electron-builder. It enables electron-builder's `forceCodeSigning`, signs with SHA-256, and uses the DigiCert RFC 3161 timestamp service so signatures remain valid after the certificate expires. Confirm the result before publishing:

```powershell
Get-AuthenticodeSignature .\release\MDM-Setup-2.6.exe | Format-List Status, SignerCertificate
```

Unsigned builds trigger Windows SmartScreen and should only be used for local testing.

The packaged runtime is hardened with Electron fuses: `NODE_OPTIONS` and CLI inspection are disabled, ASAR integrity validation and ASAR-only app loading are enforced, cookies are encrypted, and the `file://` privilege-escalation fuse is disabled (the renderer is served over `mdm://app`). `runAsNode` deliberately stays enabled because the bundled yt-dlp is launched through the Electron binary as Node. `npm run smoke:fuses` checks every fuse on the packaged executable.

## Browser extension

The desktop installer bundles the extension and opens the selected browser's extension page. For development:

```powershell
npm run build:extension
```

**Chrome / Edge**

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` folder.
4. Leave **Browser integration** enabled in MDM. The extension asks MDM to pair; approve the one-time prompt in MDM and the token is filled in.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `extension/firefox/manifest.json`.
4. Copy the bridge token from MDM's **Browser** page into the add-on settings and test the connection.

Browsers require one manual confirmation for unpacked extensions. MDM's installer copies the unpacked extension path to the clipboard to make this faster. Starting MDM from a browser while the desktop app is completely closed is not supported; start MDM first.

The Chrome/Edge extension ID is pinned to `oojnafhedmcdiohlppogncampchpenjf` by the public `key` in `extension/manifest.json`. MDM only considers pairing requests from that ID, and it asks you to approve each request in a one-time prompt before handing over the bridge token. Because a service-worker request carries no verifiable browser origin and the ID is public, the prompt is the step that proves intent; approvals are never cached or shared. Firefox assigns every profile a random `moz-extension://` UUID that the desktop app cannot verify, which is why Firefox uses the manual token flow.

## Site rules

Manage rules under **Rules > Site rules**. Patterns can be exact hosts or wildcard hosts such as `*.example.com`; optional file-type filters limit a rule to extensions such as `zip, pdf, mp4`.

| Action | Behavior |
|---|---|
| `auto` | Queue the download immediately |
| `ask` | Hold the download in MDM until the user starts it |
| `ignore` | Do not capture the download |

The most specific matching pattern wins. A rule can also set a destination directory.

### Turbo mode: what it can and cannot do

Turbo mode can only fix one cause of slow downloads: a server that gives each connection less than your line can carry, so a few connections leave bandwidth unused. It cannot create bandwidth your provider's plan does not include, take it from other programs, or beat a server that limits the total. It finds the limit by measurement, so the same setting works on a slow or a fast connection.

- Gains show up on large files. A new connection needs a range of at least 4 MB left to take over, so a small file cannot use many connections.
- Some servers block clients that open many connections. Turbo backs off when it sees 429/503 or resets, but keep the ceiling modest on sites you rely on.
- Run `MDM_BENCH=1 npx vitest run tests/turbo-benchmark.test.ts` to compare fixed connections with Turbo on simulated 8 to 500 Mbit/s links.

## Media support

| Source | Support |
|---|---|
| HTTP/HTTPS direct files | Segmented, resumable, checksum-capable |
| FTP | Direct file downloads |
| HLS VOD | Unencrypted master/media playlists, byte ranges, fMP4 init sections |
| DASH | Basic static manifests and representation selection |
| YouTube / yt-dlp pages | Video quality selection, audio-only formats, FFmpeg muxing |
| DRM, live streams, paywalled/members-only | Not supported |

DASH audio/video tracks can be downloaded separately, but MDM does not automatically mux them.

For yt-dlp pages, browser cookies are written to a temporary Netscape cookie file scoped to the page's registrable domain instead of being sent as a global header to every host yt-dlp contacts. The domain comes from the Public Suffix List, so country-code and private suffixes such as `com.eg`, `co.il`, and `myshopify.com` cannot widen a cookie to unrelated sites. Third-party media hosts therefore never receive the page session. yt-dlp also receives the same merged OS/Node CA bundle as the HTTP engine through `--compat-options no-certifi` and `SSL_CERT_FILE`, so antivirus and corporate roots work without disabling certificate verification. The temporary cookie file and private CA bundle folder are removed when the probe or download ends.

## Data location

The SQLite database (`mdm.db`), logs, and settings are stored under:

```text
%APPDATA%\MDM - Mohamed Download Manager
```

On first launch, MDM imports an existing AeroFetch database from `%APPDATA%\AeroFetch` if no MDM database exists.

## Troubleshooting

- **Disk-space error:** MDM refuses to start a transfer that cannot finish. Free enough space for the complete file plus the safety margin, choose another download folder, or retry after cleanup.
- **yt-dlp missing tools:** confirm `tools/ffmpeg.exe`, `tools/ffprobe.exe`, and `tools/yt-dlp.exe` exist during development, or that the packaged app has them under `resources/tools`. Run `tools/ffmpeg.exe -version` in a new terminal to check the binary.
- **Sign-in or bot check:** open the page in your browser while signed in, then retry the download so the extension can pass the page cookies. Cookies are scoped to the page's own site, so a third-party media host may still require its own access. A site that `yt-dlp` does not support still needs a direct HLS/DASH or MP4/WebM source.
- **Extension not pairing:** make sure MDM is running, **Browser integration** is enabled, port `41731` is free, and the extension has been reloaded. Chrome and Edge ask MDM to pair; approve the prompt in MDM. If you deny it, use **Test connection** in the extension to ask again. Firefox requires pasting the token shown on MDM's **Browser** page.
- **Certificate or antivirus errors:** MDM trusts the Windows certificate store in addition to Node's bundled roots. If a proxy or scanner still intercepts TLS, import its root into Windows or set `MDM_DISABLE_SYSTEM_CA=1` to fall back to Node's default trust store. Certificate verification is never disabled globally.
- **SmartScreen warning:** official builds are signed with `npm run package:signed`; a locally built unsigned installer will show SmartScreen until it is signed with a trusted certificate.
- **Missing video overlay:** open the extension popup and choose **Show video overlays**, or refresh the page.

## Project layout

```text
src/
  engine/      HTTP/HTTPS/FTP, segmented downloads, HLS/DASH, yt-dlp, checksums, rate limiting
  main/        Electron bootstrap, SQLite database, download manager, bridge, scheduler, IPC
  preload/     Context-isolated renderer API
  renderer/    React UI, state store, pages, components, design system
  shared/      Shared types, defaults, formatting, validation
extension/     Chrome/Edge MV3 extension and shared code
extension/firefox/
scripts/       Icon generation, extension build, smoke tests, cleanup
tests/         Vitest unit and synthetic integration tests
tools/         Bundled yt-dlp, FFmpeg, and FFprobe executables (Git LFS)
assets/        Application, tray, and installer icons
```

## Security notes

- Renderer isolation is enabled; Node integration is disabled; the preload exposes a narrow typed API. The packaged renderer is served from the privileged `mdm://app` scheme instead of `file://`, and the runtime enables ASAR integrity validation and disables `NODE_OPTIONS`, CLI inspection, and extra `file://` privileges through Electron fuses.
- The bridge binds only to `127.0.0.1`, requires a bearer token, rejects oversized bodies, applies rate limits, and rejects Host headers other than loopback (`127.0.0.1`, `localhost`, or `[::1]`) to block DNS rebinding.
- Extension pairing is pinned to the Chrome/Edge extension ID `oojnafhedmcdiohlppogncampchpenjf`, which is derived from the public key in the extension manifest. Extension workers that omit `Origin` must also present the pinned ID and extension Fetch Metadata, and every request must be approved in a one-time MDM prompt; approvals are never cached or shared. Firefox has no verifiable stable origin, so it uses the manual token instead.
- Proxy credentials and the bridge token use Electron `safeStorage` / DPAPI. Secret settings are encrypted at rest.
- TLS certificate validation is enabled by default and trusts the Windows certificate store best-effort in addition to Node's bundled roots, so corporate and antivirus CAs work. Set `MDM_DISABLE_SYSTEM_CA=1` to opt out. The browser download confirmation dialog offers a per-download opt-in for hosts with a broken certificate chain; it is never enabled globally.
- yt-dlp receives page cookies through a temporary, site-scoped cookie file rather than a global header, and trusts the same merged CA bundle as the HTTP engine through `--compat-options no-certifi` plus `SSL_CERT_FILE`.
- Downloads from HTTP, HTTPS, FTP, media, and yt-dlp sources are marked with the Windows Mark-of-the-Web (`Zone.Identifier`, zone 3) after they are placed, which keeps SmartScreen and Office Protected View active. Set `MDM_DISABLE_MOTW=1` to opt out.
- Downloaded executables are never launched automatically.
- MDM does not bypass DRM, paywalls, or access controls.

## Verification

```powershell
npm run verify
npm run smoke
npm run smoke:extension
npm run package            # also runs smoke:fuses
npm run smoke:packaged
npm run bench:http         # opt-in throughput benchmark
MDM_BENCH=1 npx vitest run tests/turbo-benchmark.test.ts   # opt-in Turbo benchmark
```

`npm run verify` currently passes typecheck, lint, **155 tests across 29 test files**, and the production build. The two opt-in benchmarks (HTTP throughput and Turbo) are skipped by the normal test run. The Vitest suite covers validation, schedule timing, checksums, rate limiting, sparse writes, segmented HTTP downloads, Turbo connection growth and backoff, pause/resume, HLS parsing, YouTube format selection, media-probe caching, database persistence, site-rule resolution, bridge pairing/authentication/rule handling, extension-ID derivation, yt-dlp cookie scoping/CA bundles, the renderer custom protocol, concurrent capture coalescing, download lifecycle transitions, and actionable notifications. The Electron smoke test starts the app with an isolated data directory, checks every page and the bridge, downloads a fixture through the real IPC/engine stack, and verifies the checksum. The extension smoke test loads the unpacked Manifest V3 extension in Chromium and exercises pinned pairing plus the YouTube, generic video, cross-origin iframe, and yt-dlp overlay flows against a mocked bridge. The packaged smoke test launches `release/win-unpacked`, and `npm run smoke:fuses` asserts that every hardened Electron fuse survived packaging.

## GitHub and releases

The source is published at **[MohamedAshraf366/MDM-DowloadManager](https://github.com/MohamedAshraf366/MDM-DowloadManager)**. GitHub hosts the source and Release assets; the Windows app itself is distributed from the [Vercel download page](https://mdm-download-manager-mohamed-ashraf.vercel.app/). On this checkout, typecheck, lint, **155 tests**, the production build, the Electron smoke test, and the packaged-app smoke test pass.

### What is committed

- Application, extension, test, and build-source files.
- `assets/` and extension icons.
- `tools/ffmpeg.exe`, `tools/ffprobe.exe`, and `tools/yt-dlp.exe` as Git LFS pointers.

The bundled tools total about 339 MB, so keep an eye on your Git LFS storage and bandwidth quota. On a fresh clone, run `git lfs pull` if the files under `tools/` are small pointer files.

### What is not committed

- `release/`, `dist/`, `node_modules/`, coverage, and test reports are ignored.
- `release/MDM-Setup-2.6.exe` (225,775,600 bytes) is attached to a GitHub Release, never committed.
- The optional `website/` marketing-site source is not included. The live site is built and hosted separately, so a fresh Vercel or GitHub Pages deployment from this checkout will not rebuild it until that folder is restored.

### Pushing updates

```powershell
git lfs install
git add .
git commit -m "Describe your change"
git push
```

### Publishing an installer

```powershell
npm ci
npm run verify
npm run package
```

Attach `release/MDM-Setup-2.6.exe` to a GitHub Release. Do not commit it. GitHub Actions does not build the Windows installer because packaging needs Windows and the bundled tools.

### Suggested repository metadata

Use these values in the GitHub **About** panel:

| Field | Value |
|---|---|
| **Description** | A fast, local-first download manager for Windows 10/11 — 8-connection segmented transfers, resume, browser capture, queues, schedules, site rules, checksums, HLS/DASH, and YouTube downloads. Built with Electron, React, and TypeScript. |
| **Homepage** | [mdm-download-manager-mohamed-ashraf.vercel.app](https://mdm-download-manager-mohamed-ashraf.vercel.app/) |
| **Topics** | `download-manager` `electron` `react` `typescript` `windows` `hls` `dash` `yt-dlp` `browser-extension` `local-first` `idm-alternative` `ftp` `sqlite` |
| **License** | MIT |

The README is the public project description: it covers what MDM is, its features, requirements, how to run it from source, how to build the Windows installer, extension installation, and where users can download the live version.

### Pre-push checklist

- [ ] Run `git lfs install` once per machine and confirm `git lfs track` lists `tools/*.exe`. LFS is required because `ffmpeg.exe` and `ffprobe.exe` exceed GitHub's 100 MB per-file limit.
- [ ] Run `npm run verify` (typecheck, lint, tests, and production build). It passes on this checkout: **155 tests**.
- [ ] Confirm `release/`, `dist/`, and `node_modules/` are not staged.
- [ ] Attach `release/MDM-Setup-2.6.exe` (225,775,600 bytes, SHA-256 `BE23EDA4…B768F81E`) to a GitHub Release instead of committing it.
- [ ] Keep the Vercel download page linked. This checkout does not contain the `website/` source needed to rebuild it, so connect Vercel only after restoring that folder.

## License

MDM's source is released under the [MIT License](LICENSE). Bundled third-party tools keep their own licenses:

- **FFmpeg / FFprobe**: GPL v3, BtbN GPL build. Source and build scripts are available in the [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) repository.
- **yt-dlp**: Unlicense.
- Electron, React, and other npm dependencies retain their respective licenses.

Review third-party license obligations before redistributing the packaged application.

## Disclaimer

MDM is provided as-is, without warranty. Download only content you have the right to access. The project does not bypass DRM, paywalls, or access controls, and it is not affiliated with Internet Download Manager or any other commercial product.
