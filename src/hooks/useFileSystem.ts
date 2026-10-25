import { useState, useCallback, useRef } from 'react';
import { extractMetadata, ImageMetadata } from '../lib/metadata';
import { computeFileHash, SizableFile } from '../lib/hash';

export interface ProcessedFile {
  handle?: FileSystemFileHandle;
  file: SizableFile;
  metadata: ImageMetadata | null;
  status: 'pending' | 'success' | 'error';
  errorMessage?: string;
  newNamePreview: string;
  originalName: string;
  isDuplicate?: boolean;
  fileHash?: string;
}

function getElectronIpc(): any {
  if (typeof window !== 'undefined' && (window as any).require) {
    try {
      const { ipcRenderer } = (window as any).require('electron');
      return ipcRenderer;
    } catch {
      return null;
    }
  }
  return null;
}

async function finalizeAndHashMediaFiles(discoveredFiles: ProcessedFile[]): Promise<ProcessedFile[]> {
  discoveredFiles.sort((a, b) => {
    const timeA = a.metadata?.dateTaken?.getTime() || 0;
    const timeB = b.metadata?.dateTaken?.getTime() || 0;
    return timeA - timeB;
  });

  const hashSet = new Set<string>();
  for (const f of discoveredFiles) {
    f.fileHash = await computeFileHash(f.file);
    if (hashSet.has(f.fileHash)) {
      f.isDuplicate = true;
    } else {
      hashSet.add(f.fileHash);
    }
  }
  return discoveredFiles;
}

export function useFileSystem() {
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const electronDirPathRef = useRef<string | null>(null);

  const scanDirectory = useCallback(async () => {
    setErrorDetails(null);
    const ipc = getElectronIpc();

    try {
      // 1. Native Electron Desktop Adapter (In-Place Rename on disk)
      if (ipc) {
        const selection = await ipc.invoke('fs:selectDirectory');
        if (!selection || selection.canceled || !selection.dirPath) {
          return;
        }

        const dirPath: string = selection.dirPath;
        const dirName: string = selection.dirName;
        electronDirPathRef.current = dirPath;
        setDirHandle({ name: dirName, kind: 'directory' } as unknown as FileSystemDirectoryHandle);
        setIsFallbackMode(false);
        setIsScanning(true);
        setFiles([]);

        const rawEntries: Array<{
          name: string;
          size: number;
          mtimeMs: number;
          headBytes: Uint8Array;
        }> = await ipc.invoke('fs:listMediaFiles', dirPath);

        const discoveredFiles: ProcessedFile[] = [];

        for (const entry of rawEntries) {
          const fileSlice = new File([entry.headBytes], entry.name, {
            lastModified: entry.mtimeMs,
          }) as SizableFile;
          fileSlice.actualSize = entry.size;

          const metadata = await extractMetadata(fileSlice);

          let currentName = entry.name;
          const nativeHandle = {
            kind: 'file' as const,
            get name() {
              return currentName;
            },
            getFile: async () => fileSlice,
            move: async (newName: string) => {
              await ipc.invoke('fs:renameFile', dirPath, currentName, newName);
              currentName = newName;
            },
          } as unknown as FileSystemFileHandle;

          discoveredFiles.push({
            handle: nativeHandle,
            file: fileSlice,
            metadata,
            status: 'pending',
            newNamePreview: entry.name,
            originalName: entry.name,
          });
        }

        setFiles(await finalizeAndHashMediaFiles(discoveredFiles));
        return;
      }

      // 2. Fallback to standard input element for iframes / unsupported browsers
      if (!('showDirectoryPicker' in window)) {
        return new Promise<void>((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.webkitdirectory = true;
          // @ts-ignore
          input.directory = true;

          input.onchange = async (e) => {
            const target = e.target as HTMLInputElement;
            if (target.files && target.files.length > 0) {
              setIsScanning(true);
              setFiles([]);
              setIsFallbackMode(true);

              const discoveredFiles: ProcessedFile[] = [];
              for (let i = 0; i < target.files.length; i++) {
                const file = target.files[i];
                const ext = file.name.split('.').pop()?.toLowerCase() || '';
                const validExts = ['heic', 'jpg', 'jpeg', 'png', 'mov', 'mp4'];

                if (validExts.includes(ext)) {
                  const metadata = await extractMetadata(file);
                  discoveredFiles.push({
                    file,
                    metadata,
                    status: 'pending',
                    newNamePreview: file.name,
                    originalName: file.name,
                  });
                }
              }

              setFiles(await finalizeAndHashMediaFiles(discoveredFiles));
              setIsScanning(false);
              resolve();
            }
          };

          input.click();
        });
      }

      // 3. Browser File System Access API
      // @ts-ignore
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
      });

      setDirHandle(handle);
      setIsFallbackMode(false);
      setIsScanning(true);
      setFiles([]);

      const discoveredFiles: ProcessedFile[] = [];

      for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
          const ext = entry.name.split('.').pop()?.toLowerCase() || '';
          const validExts = ['heic', 'jpg', 'jpeg', 'png', 'mov', 'mp4'];

          if (validExts.includes(ext)) {
            const fileHandle = entry as FileSystemFileHandle;
            const file = await fileHandle.getFile();
            const metadata = await extractMetadata(file);

            discoveredFiles.push({
              handle: fileHandle,
              file,
              metadata,
              status: 'pending',
              newNamePreview: entry.name,
              originalName: entry.name,
            });
          }
        }
      }

      setFiles(await finalizeAndHashMediaFiles(discoveredFiles));
    } catch (err: any) {
      console.error('Directory selection failed or cancelled:', err);
      if (err.name !== 'AbortError') {
        setErrorDetails(err.message || 'An unknown error occurred accessing the directory.');
      }
    } finally {
      setIsScanning(false);
    }
  }, []);

  return {
    dirHandle,
    files,
    setFiles,
    isScanning,
    scanDirectory,
    errorDetails,
    setErrorDetails,
    isFallbackMode,
  };
}
