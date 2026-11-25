# Picture Perfect

A Windows desktop application (Electron + React) for photographers and creators that scans media directories, extracts EXIF/QuickTime metadata and reverse-geocoded locations, deduplicates files by content hash, and batch-renames media in place using customizable token templates.

## Language

**Media File**:
An image or video file (`HEIC`, `JPG`, `JPEG`, `PNG`, `MOV`, `MP4`) discovered in a target directory whose metadata and content hash are extracted for renaming.
_Avoid_: Asset, photo item, blob

**Rename Template**:
A user-configured token pattern (such as `{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}_{Model}_{City}`) used to compute deterministic target filenames from a Media File's metadata.
_Avoid_: Format string, naming rule, mask

**Preview State**:
The dry-run mapping showing each Media File's original filename alongside its computed `newNamePreview`, duplicate status, and collision resolution before any disk mutation occurs.
_Avoid_: Staging table, mock rename, draft list

**In-Place Rename**:
Direct filesystem mutation inside the selected directory that renames each Media File on disk without copying files into a separate archive.
_Avoid_: Export, save-as, zip download

**Rename Session**:
A stateful batch workflow over a selected directory of Media Files that coordinates Preview State evaluation, duplicate skipping, cycle-safe In-Place Rename execution, and rollback to original filenames.
_Avoid_: File hook state, batch queue, file manager

**Merchant of Record**:
The external commercial platform assuming legal responsibility for payment processing, subscription billing, invoicing, and global tax compliance.
_Avoid_: Payment gateway, payment processor, billing vendor

**Subscription License**:
A commercial authorization key (validated online against the Merchant of Record or offline via an owner-signed key) that unlocks unlimited batch renaming beyond the 20-file Trial Mode cap.
_Avoid_: Serial number, coupon, activation token

**License Vault**:
The locally persisted, tamper-evident license cache encrypted via Electron `safeStorage` (Windows DPAPI) with an HMAC-SHA256 machine-fingerprint fallback.
_Avoid_: LocalStorage state, cookie, config file

**Offline Grace Period**:
The 7-day sliding window following the last successful online heartbeat during which an activated workstation retains full Pro authorization without internet connectivity.
_Avoid_: Free trial, offline bypass
