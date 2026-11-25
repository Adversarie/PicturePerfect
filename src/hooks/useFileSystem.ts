import { useState, useCallback, useRef } from 'react';
import {
  BrowserFsaDirectoryAdapter,
  DirectoryAdapter,
  ElectronIpcDirectoryAdapter,
  ProcessedFile,
  RenameSession,
  ZipFallbackDirectoryAdapter,
} from '../lib/renameSession';

export type { ProcessedFile } from '../lib/renameSession';

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

export function useFileSystem() {
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [directoryName, setDirectoryName] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const sessionRef = useRef<RenameSession | null>(null);

  const runScanWithAdapter = useCallback(async (adapter: DirectoryAdapter, template?: string) => {
    setDirectoryName(adapter.directoryName);
    setIsFallbackMode(adapter.mode === 'archive');
    setIsScanning(true);
    setFiles([]);

    const session = new RenameSession(adapter, template);
    sessionRef.current = session;
    const scanned = await session.scan();
    setFiles([...scanned]);
  }, []);

  const scanDirectory = useCallback(async (template?: string) => {
    setErrorDetails(null);
    const ipc = getElectronIpc();

    try {
      if (ipc) {
        const selection = await ipc.invoke('fs:selectDirectory');
        if (!selection || selection.canceled || !selection.dirPath) {
          return;
        }
        const adapter = new ElectronIpcDirectoryAdapter(
          ipc,
          selection.dirPath,
          selection.dirName || selection.dirPath
        );
        await runScanWithAdapter(adapter, template);
        return;
      }

      if (!('showDirectoryPicker' in window)) {
        return new Promise<void>(resolve => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.webkitdirectory = true;
          // @ts-ignore
          input.directory = true;

          input.onchange = async e => {
            const target = e.target as HTMLInputElement;
            if (target.files && target.files.length > 0) {
              try {
                const adapter = new ZipFallbackDirectoryAdapter(Array.from(target.files));
                await runScanWithAdapter(adapter, template);
              } finally {
                setIsScanning(false);
                resolve();
              }
            } else {
              resolve();
            }
          };

          input.click();
        });
      }

      // @ts-ignore
      const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const adapter = new BrowserFsaDirectoryAdapter(handle);
      await runScanWithAdapter(adapter, template);
    } catch (err: any) {
      console.error('Directory selection failed or cancelled:', err);
      if (err?.name !== 'AbortError') {
        setErrorDetails(err?.message || 'An unknown error occurred accessing the directory.');
      }
    } finally {
      setIsScanning(false);
    }
  }, [runScanWithAdapter]);

  const applyTemplate = useCallback((template: string) => {
    if (!sessionRef.current) return;
    setFiles([...sessionRef.current.setTemplate(template)]);
  }, []);

  const executeRename = useCallback(
    async (opts: { isPro: boolean; mode: 'all' | 'batch'; batchSize: number; onProgress: (pct: number) => void }) => {
      if (!sessionRef.current) return undefined;
      const res = await sessionRef.current.executeRename({
        isPro: opts.isPro,
        mode: opts.mode,
        batchSize: opts.batchSize,
        onProgress: (pct, updated) => {
          opts.onProgress(pct);
          setFiles([...updated]);
        },
      });
      setFiles([...res.files]);
      return res.archiveBlob;
    },
    []
  );

  const undoRename = useCallback(async (onProgress: (pct: number) => void) => {
    if (!sessionRef.current) return;
    const updated = await sessionRef.current.undo((pct, list) => {
      onProgress(pct);
      setFiles([...list]);
    });
    setFiles([...updated]);
  }, []);

  const exportAuditCsv = useCallback((): string => {
    if (!sessionRef.current) return '';
    return sessionRef.current.toAuditCsv();
  }, []);

  return {
    directoryName,
    files,
    isScanning,
    scanDirectory,
    applyTemplate,
    executeRename,
    undoRename,
    exportAuditCsv,
    errorDetails,
    setErrorDetails,
    isFallbackMode,
  };
}
