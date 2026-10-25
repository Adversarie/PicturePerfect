export interface SizableFile extends File {
  actualSize?: number;
}

export async function computeFileHash(file: SizableFile): Promise<string> {
  // To avoid long hashing on large videos, we hash the first 1MB and the total file size
  const CHUNK_SIZE = 1024 * 1024; // 1MB
  const slice = file.slice(0, CHUNK_SIZE);
  const arrayBuffer = await slice.arrayBuffer();

  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const totalSize = typeof file.actualSize === 'number' ? file.actualSize : file.size;
  return `${hashHex}-${totalSize}`;
}
