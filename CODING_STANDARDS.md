# Picture Perfect Coding Standards & Architecture Invariants

This document defines the strict engineering standards, terminology constraints, security invariants, and code quality expectations for the Picture Perfect desktop application (`com.pictureperfect.app`).

## 1. Canonical Domain Language

All code identifiers, comments, user interface copy, and documentation must use the canonical domain terms defined in [GLOSSARY.md](GLOSSARY.md). Forbidden terms must not be introduced:

- **Media File**: An image or video file (`HEIC`, `JPG`, `JPEG`, `PNG`, `MOV`, `MP4`) discovered in a selected directory.
  - _Avoid_: Asset, photo item, blob.
- **Rename Template**: A user-configured token pattern (e.g., `{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}_{Model}_{City}`) calculating target filenames from metadata.
  - _Avoid_: Format string, naming rule, mask.
- **Preview State**: The deterministic dry-run mapping showing original filenames, `newNamePreview`, and collision resolutions before disk mutation.
  - _Avoid_: Staging table, mock rename, draft list.
- **In-Place Rename**: Direct filesystem mutation inside the target folder renaming files on disk without copying to separate directories.
  - _Avoid_: Export, save-as, zip download.
- **Subscription License**: The commercial authorization key from Lemon Squeezy unlocking unlimited renaming beyond the 20-file Trial Mode cap.
  - _Avoid_: Serial number, coupon, activation token.
- **License Vault**: The locally persisted, tamper-evident license cache encrypted via Electron `safeStorage` (Windows DPAPI) with HMAC-SHA256 machine fallback.
  - _Avoid_: LocalStorage state, cookie, config file.
- **Offline Grace Period**: The 7-day sliding window from the last valid online heartbeat during which Pro features remain active offline.
  - _Avoid_: Free trial, offline bypass.
- **Merchant of Record**: The external commercial platform (**Lemon Squeezy**) managing payments, taxes, and licenses.
  - _Avoid_: Payment processor, gateway, billing vendor.

## 2. File Encoding & BOM Prohibition

- All source files (`.ts`, `.tsx`, `.js`, `.cjs`, `.json`, `.css`, `.html`, `.md`, `.env*`) must be encoded in **UTF-8 without BOM**.
- Files must never begin with `0xEF, 0xBB, 0xBF`.
- Build scripts and filesystem operations must use explicit UTF-8 encoding without byte order marks (`fs.promises.writeFile(path, data, 'utf8')`).

## 3. Security & Licensing Invariants

- **Production Key Isolation**: `DEMO-KEY-123` is strictly for development and testing. It must be gated behind `NODE_ENV === 'development'` and must never validate in production release binaries.
- **Credential Protection**: License keys and activation status tokens must be stored in the **License Vault** utilizing Electron `safeStorage` (Windows DPAPI). Plaintext credential persistence is prohibited.
- **Heartbeat & Grace Enforcement**: Online validation checks communicate directly with Lemon Squeezy's Public License API. The client must enforce the exact 7-day Offline Grace Period based on verified timestamps.
- **Filesystem Safety**:
  - Scanning large directories must stream in slices (default: 5MB chunks) to prevent memory spikes.
  - In-Place Rename operations must perform collision detection in the Preview State prior to disk mutation.
  - Any file renaming failure must be handled cleanly without abandoning batch state.

## 4. Engineering Rigor & Error Handling

- **No Silent Error Swallowing**: Empty catch blocks (`catch (e) {}` or `.catch(() => {})`) are strictly forbidden. All errors must be logged with contextual metadata or surfaced via UI alerts.
- **Strict TypeScript**: Types must be accurately declared; avoid unconstrained `any` or loose type assertions.
- **No Workarounds**: Never implement monkeypatches or bypasses around build tools, Electron packaging, or IPC boundaries. All fixes must address root causes directly.
