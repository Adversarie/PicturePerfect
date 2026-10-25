const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
const VALID_MEDIA_EXTS = new Set(['heic', 'jpg', 'jpeg', 'png', 'mov', 'mp4']);
const MAX_HEADER_BYTES = 5 * 1024 * 1024; // 5MB slice for EXIF/QuickTime metadata + 1MB SHA-256 hash

// --- SafeStorage & External URL IPC Handlers ---
ipcMain.handle('license:isSafeStorageAvailable', () => {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
});

ipcMain.handle('license:encrypt', async (_event, plainText) => {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const buffer = safeStorage.encryptString(plainText);
      return buffer.toString('base64');
    } catch (e) {
      console.error('safeStorage encryption failed:', e);
      return null;
    }
  }
  return null;
});

ipcMain.handle('license:decrypt', async (_event, base64Cipher) => {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const buffer = Buffer.from(base64Cipher, 'base64');
      return safeStorage.decryptString(buffer);
    } catch (e) {
      console.error('safeStorage decryption failed:', e);
      return null;
    }
  }
  return null;
});

ipcMain.handle('open-external', async (_event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// --- Native Electron Filesystem IPC Handlers (In-Place Rename) ---
ipcMain.handle('fs:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Media Directory',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }
  const dirPath = result.filePaths[0];
  return {
    canceled: false,
    dirPath,
    dirName: path.basename(dirPath) || dirPath
  };
});

ipcMain.handle('fs:listMediaFiles', async (_event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') {
    throw new Error('Invalid directory path');
  }
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const mediaFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = entry.name.split('.').pop()?.toLowerCase() || '';
    if (!VALID_MEDIA_EXTS.has(ext)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const stat = await fs.promises.stat(fullPath);
    const readLength = Math.min(stat.size, MAX_HEADER_BYTES);
    const buffer = Buffer.alloc(readLength);

    const fd = await fs.promises.open(fullPath, 'r');
    try {
      await fd.read(buffer, 0, readLength, 0);
    } finally {
      await fd.close();
    }

    mediaFiles.push({
      name: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      headBytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    });
  }

  return mediaFiles;
});

ipcMain.handle('fs:readFileBuffer', async (_event, dirPath, fileName, maxBytes = 5 * 1024 * 1024) => {
  if (!dirPath || !fileName || path.basename(fileName) !== fileName) {
    throw new Error('Invalid file path parameters');
  }
  const fullPath = path.join(dirPath, fileName);
  const stat = await fs.promises.stat(fullPath);
  const sliceLen = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(sliceLen);
  const fd = await fs.promises.open(fullPath, 'r');
  try {
    await fd.read(buffer, 0, sliceLen, 0);
  } finally {
    await fd.close();
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
});

ipcMain.handle('fs:renameFile', async (_event, dirPath, oldName, newName) => {
  if (!dirPath || !oldName || !newName) {
    throw new Error('Missing rename parameters');
  }
  if (path.basename(oldName) !== oldName || path.basename(newName) !== newName) {
    throw new Error('Invalid filename: path traversal is not permitted');
  }
  if (oldName === newName) {
    return { success: true };
  }

  const oldPath = path.join(dirPath, oldName);
  const newPath = path.join(dirPath, newName);

  // Prevent accidental overwrite of an existing distinct file
  if (oldName.toLowerCase() !== newName.toLowerCase() && fs.existsSync(newPath)) {
    throw new Error(`Target file "${newName}" already exists in directory`);
  }

  await fs.promises.rename(oldPath, newPath);
  return { success: true };
});

function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  const mainWindow = new BrowserWindow({
    title: 'Picture Perfect',
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
