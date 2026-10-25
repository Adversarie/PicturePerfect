# Picture Perfect

Desktop media organization and batch renaming utility for iPhone and camera photos and videos (`HEIC`, `JPG`, `JPEG`, `PNG`, `MOV`, `MP4`).

## Features

- **EXIF & QuickTime Metadata Extraction**: Automatically parses `DateTimeOriginal` and `CreationDate` from photos and 4K videos (reading only the 5MB file header for instant scanning).
- **Offline Reverse Geocoding**: Resolves GPS coordinates to city names (`{City}`) for location-aware naming templates.
- **Content-Hash Deduplication**: Computes fast SHA-256 content signatures (`first 1MB + total byte size`) to skip duplicate media files automatically.
- **Native In-Place Rename & 1-Click Undo**: Mutates filenames directly on disk via Electron's native filesystem IPC with instant rollback support.
- **Commercial Licensing**: Powered by Lemon Squeezy's public License API with Electron `safeStorage` (Windows DPAPI) encryption and a 7-day offline grace window.

## Development & Packaging

```bash
# Run web dev server
npm run dev

# Launch Electron desktop app in development
npm run electron:dev

# Run TypeScript check and license test suite
npm run lint
npm test

# Build standalone Windows NSIS installer (.exe)
npm run electron:build
```
