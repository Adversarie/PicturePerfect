import { format } from 'date-fns';
import JSZip from 'jszip';
import { extractMetadata, ImageMetadata } from './metadata';
import { computeFileHash, SizableFile } from './hash';

export const VALID_MEDIA_EXTS = ['heic', 'jpg', 'jpeg', 'png', 'mov', 'mp4'] as const;
export const TRIAL_BATCH_LIMIT = 20;

export interface LocationData {
  city?: string;
  locality?: string;
  country?: string;
}

export interface ProcessedFile {
  file: SizableFile;
  metadata: ImageMetadata | null;
  status: 'pending' | 'success' | 'error';
  errorMessage?: string;
  originalName: string;
  currentName: string;
  newNamePreview: string;
  isDuplicate?: boolean;
  fileHash?: string;
}

export interface ScannedEntry {
  name: string;
  file: SizableFile;
}

export interface DirectoryAdapter {
  readonly directoryName: string;
  readonly mode: 'in-place' | 'archive';
  listMediaFiles(): Promise<ScannedEntry[]>;
  renameFile(oldName: string, newName: string): Promise<void>;
  exportArchive?(items: Array<{ targetName: string; file: SizableFile }>): Promise<Blob>;
}

const OFFLINE_CITIES: Array<{ city: string; country: string; lat: number; lon: number }> = [
  { city: 'Portland', country: 'US', lat: 45.5152, lon: -122.6784 },
  { city: 'Seattle', country: 'US', lat: 47.6062, lon: -122.3321 },
  { city: 'San-Francisco', country: 'US', lat: 37.7749, lon: -122.4194 },
  { city: 'Los-Angeles', country: 'US', lat: 34.0522, lon: -118.2437 },
  { city: 'San-Diego', country: 'US', lat: 32.7157, lon: -117.1611 },
  { city: 'Las-Vegas', country: 'US', lat: 36.1699, lon: -115.1398 },
  { city: 'Phoenix', country: 'US', lat: 33.4484, lon: -112.074 },
  { city: 'Denver', country: 'US', lat: 39.7392, lon: -104.9903 },
  { city: 'Salt-Lake-City', country: 'US', lat: 40.7608, lon: -111.891 },
  { city: 'Austin', country: 'US', lat: 30.2672, lon: -97.7431 },
  { city: 'Dallas', country: 'US', lat: 32.7767, lon: -96.797 },
  { city: 'Houston', country: 'US', lat: 29.7604, lon: -95.3698 },
  { city: 'Chicago', country: 'US', lat: 41.8781, lon: -87.6298 },
  { city: 'Minneapolis', country: 'US', lat: 44.9778, lon: -93.265 },
  { city: 'Nashville', country: 'US', lat: 36.1627, lon: -86.7816 },
  { city: 'Atlanta', country: 'US', lat: 33.749, lon: -84.388 },
  { city: 'Miami', country: 'US', lat: 25.7617, lon: -80.1918 },
  { city: 'Orlando', country: 'US', lat: 28.5383, lon: -81.3792 },
  { city: 'Washington-DC', country: 'US', lat: 38.9072, lon: -77.0369 },
  { city: 'Philadelphia', country: 'US', lat: 39.9526, lon: -75.1652 },
  { city: 'New-York', country: 'US', lat: 40.7128, lon: -74.006 },
  { city: 'Boston', country: 'US', lat: 42.3601, lon: -71.0589 },
  { city: 'Honolulu', country: 'US', lat: 21.3069, lon: -157.8583 },
  { city: 'Anchorage', country: 'US', lat: 61.2181, lon: -149.9003 },
  { city: 'Vancouver', country: 'CA', lat: 49.2827, lon: -123.1207 },
  { city: 'Calgary', country: 'CA', lat: 51.0447, lon: -114.0719 },
  { city: 'Toronto', country: 'CA', lat: 43.6532, lon: -79.3832 },
  { city: 'Montreal', country: 'CA', lat: 45.5017, lon: -73.5673 },
  { city: 'Mexico-City', country: 'MX', lat: 19.4326, lon: -99.1332 },
  { city: 'Cancun', country: 'MX', lat: 21.1619, lon: -86.8515 },
  { city: 'Rio-de-Janeiro', country: 'BR', lat: -22.9068, lon: -43.1729 },
  { city: 'Buenos-Aires', country: 'AR', lat: -34.6037, lon: -58.3816 },
  { city: 'London', country: 'GB', lat: 51.5074, lon: -0.1278 },
  { city: 'Edinburgh', country: 'GB', lat: 55.9533, lon: -3.1883 },
  { city: 'Dublin', country: 'IE', lat: 53.3498, lon: -6.2603 },
  { city: 'Reykjavik', country: 'IS', lat: 64.1466, lon: -21.9426 },
  { city: 'Paris', country: 'FR', lat: 48.8566, lon: 2.3522 },
  { city: 'Amsterdam', country: 'NL', lat: 52.3676, lon: 4.9041 },
  { city: 'Berlin', country: 'DE', lat: 52.52, lon: 13.405 },
  { city: 'Munich', country: 'DE', lat: 48.1351, lon: 11.582 },
  { city: 'Zurich', country: 'CH', lat: 47.3769, lon: 8.5417 },
  { city: 'Milan', country: 'IT', lat: 45.4642, lon: 9.19 },
  { city: 'Rome', country: 'IT', lat: 41.9028, lon: 12.4964 },
  { city: 'Barcelona', country: 'ES', lat: 41.3874, lon: 2.1686 },
  { city: 'Madrid', country: 'ES', lat: 40.4168, lon: -3.7038 },
  { city: 'Lisbon', country: 'PT', lat: 38.7223, lon: -9.1393 },
  { city: 'Athens', country: 'GR', lat: 37.9838, lon: 23.7275 },
  { city: 'Istanbul', country: 'TR', lat: 41.0082, lon: 28.9784 },
  { city: 'Cairo', country: 'EG', lat: 30.0444, lon: 31.2357 },
  { city: 'Cape-Town', country: 'ZA', lat: -33.9249, lon: 18.4241 },
  { city: 'Dubai', country: 'AE', lat: 25.2048, lon: 55.2708 },
  { city: 'Mumbai', country: 'IN', lat: 19.076, lon: 72.8777 },
  { city: 'Bangkok', country: 'TH', lat: 13.7563, lon: 100.5018 },
  { city: 'Singapore', country: 'SG', lat: 1.3521, lon: 103.8198 },
  { city: 'Hong-Kong', country: 'HK', lat: 22.3193, lon: 114.1694 },
  { city: 'Seoul', country: 'KR', lat: 37.5665, lon: 126.978 },
  { city: 'Tokyo', country: 'JP', lat: 35.6762, lon: 139.6503 },
  { city: 'Kyoto', country: 'JP', lat: 35.0116, lon: 135.7681 },
  { city: 'Sydney', country: 'AU', lat: -33.8688, lon: 151.2093 },
  { city: 'Melbourne', country: 'AU', lat: -37.8136, lon: 144.9631 },
  { city: 'Auckland', country: 'NZ', lat: -36.8509, lon: 174.7645 },
];

const MAX_CITY_RADIUS_KM = 350;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function reverseGeocodeOffline(lat: number, lon: number): LocationData | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  let best: (typeof OFFLINE_CITIES)[number] | null = null;
  let bestKm = Infinity;
  for (const entry of OFFLINE_CITIES) {
    const d = haversineKm(lat, lon, entry.lat, entry.lon);
    if (d < bestKm) {
      bestKm = d;
      best = entry;
    }
  }
  if (!best || bestKm > MAX_CITY_RADIUS_KM) {
    return null;
  }
  return {
    city: best.city,
    locality: best.city,
    country: best.country,
  };
}

export function isValidMediaFilename(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return (VALID_MEDIA_EXTS as readonly string[]).includes(ext);
}

function sanitizeFilename(name: string): string {
  const stripped = name.replace(/[<>:"/\\|?*]/g, '_');
  return stripped.trim().replace(/\.$/, '');
}

function generateNewNameBase(originalName: string, lastModified: number, metadata: ImageMetadata | null, template: string): string {
  const dateToUse = metadata?.dateTaken || new Date(lastModified);
  const modelStr = metadata?.model?.replace(/[^a-zA-Z0-9_-]/g, '') || 'UnknownDevice';
  const dotIdx = originalName.lastIndexOf('.');
  const originalBase = dotIdx >= 0 ? originalName.substring(0, dotIdx) : originalName;
  const cityStr = metadata?.location?.city?.replace(/[^a-zA-Z0-9_-]/g, '') || 'UnknownLocation';

  let newName = template;
  newName = newName.replace(/{YYYY}/g, format(dateToUse, 'yyyy'));
  newName = newName.replace(/{MM}/g, format(dateToUse, 'MM'));
  newName = newName.replace(/{DD}/g, format(dateToUse, 'dd'));
  newName = newName.replace(/{HH}/g, format(dateToUse, 'HH'));
  newName = newName.replace(/{mm}/g, format(dateToUse, 'mm'));
  newName = newName.replace(/{ss}/g, format(dateToUse, 'ss'));
  newName = newName.replace(/{Model}/g, modelStr);
  newName = newName.replace(/{City}/g, cityStr);
  newName = newName.replace(/{Original}/g, originalBase);

  return sanitizeFilename(newName);
}

export function computePreviews(files: ProcessedFile[], template: string): ProcessedFile[] {
  const seenNames = new Set<string>();

  return files.map(item => {
    const sourceName = item.originalName || item.file.name;
    const baseName = generateNewNameBase(sourceName, item.file.lastModified, item.metadata, template);
    const dotIdx = sourceName.lastIndexOf('.');
    const ext = dotIdx >= 0 ? sourceName.slice(dotIdx) : '';

    let tentativeName = baseName + ext;
    let counter = 1;
    while (seenNames.has(tentativeName.toLowerCase())) {
      tentativeName = `${baseName}_${counter}${ext}`;
      counter++;
    }
    seenNames.add(tentativeName.toLowerCase());

    return {
      ...item,
      newNamePreview: tentativeName,
    };
  });
}

export function generateAuditCsv(files: ProcessedFile[]): string {
  const headers = ['Original Name', 'New Name', 'Status', 'Date Taken', 'Location'];
  const escapeStr = (str: string) => `"${String(str ?? '').replace(/"/g, '""')}"`;

  const rows = files.map(f => {
    const dateTaken = f.metadata?.dateTaken ? format(f.metadata.dateTaken, 'yyyy-MM-dd HH:mm:ss') : 'Unknown';
    const city = f.metadata?.location?.city || 'Unknown';
    return [
      escapeStr(f.originalName),
      escapeStr(f.status === 'success' ? f.currentName : ''),
      escapeStr(f.status),
      escapeStr(dateTaken),
      escapeStr(city),
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

export class ElectronIpcDirectoryAdapter implements DirectoryAdapter {
  public readonly mode = 'in-place' as const;
  public readonly directoryName: string;
  private readonly dirPath: string;
  private readonly ipc: any;

  constructor(ipc: any, dirPath: string, directoryName: string) {
    this.ipc = ipc;
    this.dirPath = dirPath;
    this.directoryName = directoryName;
  }

  public async listMediaFiles(): Promise<ScannedEntry[]> {
    const rawEntries: Array<{ name: string; size: number; mtimeMs: number; headBytes: Uint8Array }> =
      await this.ipc.invoke('fs:listMediaFiles', this.dirPath);

    return rawEntries.map(entry => {
      const fileSlice = new File([entry.headBytes], entry.name, { lastModified: entry.mtimeMs }) as SizableFile;
      fileSlice.actualSize = entry.size;
      return { name: entry.name, file: fileSlice };
    });
  }

  public async renameFile(oldName: string, newName: string): Promise<void> {
    await this.ipc.invoke('fs:renameFile', this.dirPath, oldName, newName);
  }
}

export class BrowserFsaDirectoryAdapter implements DirectoryAdapter {
  public readonly mode = 'in-place' as const;
  public readonly directoryName: string;
  private readonly dirHandle: FileSystemDirectoryHandle;
  private fileHandles = new Map<string, FileSystemFileHandle>();

  constructor(dirHandle: FileSystemDirectoryHandle) {
    this.dirHandle = dirHandle;
    this.directoryName = dirHandle.name;
  }

  public async listMediaFiles(): Promise<ScannedEntry[]> {
    this.fileHandles.clear();
    const entries: ScannedEntry[] = [];
    for await (const entry of (this.dirHandle as any).values()) {
      if (entry.kind === 'file' && isValidMediaFilename(entry.name)) {
        const fh = entry as FileSystemFileHandle;
        const file = (await fh.getFile()) as SizableFile;
        this.fileHandles.set(entry.name, fh);
        entries.push({ name: entry.name, file });
      }
    }
    return entries;
  }

  public async renameFile(oldName: string, newName: string): Promise<void> {
    const handle = this.fileHandles.get(oldName);
    if (!handle) {
      throw new Error(`Missing file handle for "${oldName}"`);
    }
    if ('move' in handle && typeof (handle as any).move === 'function') {
      await (handle as any).move(newName);
      this.fileHandles.delete(oldName);
      this.fileHandles.set(newName, handle);
      return;
    }

    const newFileHandle = await this.dirHandle.getFileHandle(newName, { create: true });
    const writable = await newFileHandle.createWritable();
    const sourceFile = await handle.getFile();
    await sourceFile.stream().pipeTo(writable);
    await this.dirHandle.removeEntry(oldName);
    this.fileHandles.delete(oldName);
    this.fileHandles.set(newName, newFileHandle);
  }
}

export class ZipFallbackDirectoryAdapter implements DirectoryAdapter {
  public readonly mode = 'archive' as const;
  public readonly directoryName: string;
  private readonly fileList: File[];

  constructor(fileList: File[], directoryName = 'Selected Folder') {
    this.fileList = fileList;
    this.directoryName = directoryName;
  }

  public async listMediaFiles(): Promise<ScannedEntry[]> {
    const entries: ScannedEntry[] = [];
    for (const file of this.fileList) {
      if (isValidMediaFilename(file.name)) {
        entries.push({ name: file.name, file: file as SizableFile });
      }
    }
    return entries;
  }

  public async renameFile(_oldName: string, _newName: string): Promise<void> {
    // Archive mode builds a ZIP instead of mutating local disk entries.
  }

  public async exportArchive(items: Array<{ targetName: string; file: SizableFile }>): Promise<Blob> {
    const zip = new JSZip();
    for (const item of items) {
      zip.file(item.targetName, item.file);
    }
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }
}

export class InMemoryDirectoryAdapter implements DirectoryAdapter {
  public readonly mode = 'in-place' as const;
  public readonly directoryName: string;
  private files = new Map<string, SizableFile>();

  constructor(initialFiles: Record<string, SizableFile>, directoryName = 'InMemory-Shoot') {
    this.directoryName = directoryName;
    for (const [name, file] of Object.entries(initialFiles)) {
      this.files.set(name, file);
    }
  }

  public snapshotNames(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  public getFile(name: string): SizableFile | undefined {
    return this.files.get(name);
  }

  public async listMediaFiles(): Promise<ScannedEntry[]> {
    const out: ScannedEntry[] = [];
    for (const [name, file] of this.files.entries()) {
      if (isValidMediaFilename(name)) {
        out.push({ name, file });
      }
    }
    return out;
  }

  public async renameFile(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    const entry = this.files.get(oldName);
    if (!entry) {
      throw new Error(`Source file "${oldName}" does not exist`);
    }
    const lowerNew = newName.toLowerCase();
    for (const existing of this.files.keys()) {
      if (existing.toLowerCase() === lowerNew && existing !== oldName) {
        throw new Error(`Target file "${newName}" already exists in directory`);
      }
    }
    this.files.delete(oldName);
    this.files.set(newName, entry);
  }
}

export interface ExecuteRenameOptions {
  isPro: boolean;
  mode: 'all' | 'batch';
  batchSize?: number;
  onProgress?: (percent: number, files: ProcessedFile[]) => void;
}

export interface ExecuteRenameResult {
  files: ProcessedFile[];
  archiveBlob?: Blob;
}

export class RenameSession {
  public readonly adapter: DirectoryAdapter;
  public files: ProcessedFile[] = [];
  private template: string;

  constructor(adapter: DirectoryAdapter, template = '{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}_{Model}') {
    this.adapter = adapter;
    this.template = template;
  }

  public async scan(): Promise<ProcessedFile[]> {
    const entries = await this.adapter.listMediaFiles();
    const discovered: ProcessedFile[] = [];

    for (const entry of entries) {
      const metadata = await extractMetadata(entry.file);
      discovered.push({
        file: entry.file,
        metadata,
        status: 'pending',
        originalName: entry.name,
        currentName: entry.name,
        newNamePreview: entry.name,
      });
    }

    discovered.sort((a, b) => {
      const timeA = a.metadata?.dateTaken?.getTime() || 0;
      const timeB = b.metadata?.dateTaken?.getTime() || 0;
      return timeA - timeB;
    });

    const hashSet = new Set<string>();
    for (const item of discovered) {
      item.fileHash = await computeFileHash(item.file);
      if (hashSet.has(item.fileHash)) {
        item.isDuplicate = true;
      } else {
        hashSet.add(item.fileHash);
      }
    }

    this.files = computePreviews(discovered, this.template);
    return this.files;
  }

  public setTemplate(template: string): ProcessedFile[] {
    this.template = template;
    this.files = computePreviews(this.files, template);
    return this.files;
  }

  public async executeRename(options: ExecuteRenameOptions): Promise<ExecuteRenameResult> {
    const pending = this.files.filter(
      f => f.status !== 'success' && f.currentName !== f.newNamePreview && !f.isDuplicate
    );
    let limit = options.mode === 'all' ? pending.length : options.batchSize ?? 10;
    if (!options.isPro) limit = Math.min(TRIAL_BATCH_LIMIT, limit);

    const targets = pending.slice(0, limit);
    if (targets.length === 0) {
      return { files: this.files };
    }

    if (this.adapter.mode === 'archive' && this.adapter.exportArchive) {
      const archiveItems: Array<{ targetName: string; file: SizableFile }> = [];
      let completed = 0;
      for (const item of targets) {
        item.status = 'success';
        item.currentName = item.newNamePreview;
        archiveItems.push({ targetName: item.newNamePreview, file: item.file });
        completed++;
        options.onProgress?.(Math.round((completed / targets.length) * 100), [...this.files]);
      }
      const archiveBlob = await this.adapter.exportArchive(archiveItems);
      return { files: [...this.files], archiveBlob };
    }

    await this.runCycleSafeRenames(
      targets.map(item => ({ item, targetName: item.newNamePreview })),
      options.onProgress,
      'success'
    );
    return { files: [...this.files] };
  }

  public async undo(onProgress?: (percent: number, files: ProcessedFile[]) => void): Promise<ProcessedFile[]> {
    const renamed = this.files.filter(f => f.status === 'success');
    if (renamed.length === 0) {
      return this.files;
    }

    if (this.adapter.mode === 'archive') {
      for (const item of renamed) {
        item.status = 'pending';
        item.currentName = item.originalName;
      }
      this.files = computePreviews(this.files, this.template);
      onProgress?.(100, [...this.files]);
      return this.files;
    }

    await this.runCycleSafeRenames(
      renamed.map(item => ({ item, targetName: item.originalName })),
      onProgress,
      'pending'
    );
    this.files = computePreviews(this.files, this.template);
    return [...this.files];
  }

  public toAuditCsv(): string {
    return generateAuditCsv(this.files);
  }

  private async runCycleSafeRenames(
    ops: Array<{ item: ProcessedFile; targetName: string }>,
    onProgress: ((percent: number, files: ProcessedFile[]) => void) | undefined,
    successStatus: 'success' | 'pending'
  ): Promise<void> {
    const batchId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const occupiedLower = new Set(this.files.map(f => f.currentName.toLowerCase()));
    const needsStaging = new Map<ProcessedFile, string>();

    for (let i = 0; i < ops.length; i++) {
      const { item, targetName } = ops[i];
      if (item.currentName === targetName) continue;
      const targetLower = targetName.toLowerCase();
      if (occupiedLower.has(targetLower) && item.currentName.toLowerCase() !== targetLower) {
        const dotIdx = item.currentName.lastIndexOf('.');
        const ext = dotIdx >= 0 ? item.currentName.slice(dotIdx) : '';
        needsStaging.set(item, `__pp_stage_${batchId}_${i}${ext}`);
      }
    }

    for (const [item, tempName] of needsStaging.entries()) {
      try {
        await this.adapter.renameFile(item.currentName, tempName);
        occupiedLower.delete(item.currentName.toLowerCase());
        occupiedLower.add(tempName.toLowerCase());
        item.currentName = tempName;
      } catch (err: any) {
        item.status = 'error';
        item.errorMessage = err?.message || 'Staging rename failed';
      }
    }

    let completed = 0;
    for (const { item, targetName } of ops) {
      if (item.status === 'error' && needsStaging.has(item)) {
        completed++;
        onProgress?.(Math.round((completed / ops.length) * 100), [...this.files]);
        continue;
      }
      try {
        if (item.currentName !== targetName) {
          await this.adapter.renameFile(item.currentName, targetName);
          occupiedLower.delete(item.currentName.toLowerCase());
          occupiedLower.add(targetName.toLowerCase());
          item.currentName = targetName;
        }
        item.status = successStatus;
        item.errorMessage = undefined;
      } catch (err: any) {
        item.status = 'error';
        item.errorMessage = err?.message || 'Rename failed';
      }
      completed++;
      onProgress?.(Math.round((completed / ops.length) * 100), [...this.files]);
    }
  }
}
