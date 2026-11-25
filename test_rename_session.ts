/**
 * test_rename_session.ts - End-to-end verification suite for the deepened RenameSession module.
 */

import * as assert from 'assert';
import {
  InMemoryDirectoryAdapter,
  RenameSession,
  TRIAL_BATCH_LIMIT,
  reverseGeocodeOffline,
} from './src/lib/renameSession';
import { SizableFile } from './src/lib/hash';

function makeMediaFile(name: string, content: string, mtimeMs: number): SizableFile {
  const f = new File([content], name, { lastModified: mtimeMs }) as SizableFile;
  f.actualSize = content.length;
  return f;
}

async function runTests() {
  console.log('[TEST] 1. Offline Reverse Geocoder (zero network calls)...');
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('Network call forbidden in offline reverse geocoder');
  }) as any;

  const pdx = reverseGeocodeOffline(45.52, -122.68);
  assert.strictEqual(pdx?.city, 'Portland');
  const ocean = reverseGeocodeOffline(0.0, -160.0);
  assert.strictEqual(ocean, null);
  assert.strictEqual(networkCalls, 0);
  globalThis.fetch = originalFetch;
  console.log('  -> Passed.');

  console.log('\n[TEST] 2. Cycle-Safe Two-Phase Rename & 1-Click Undo...');
  // Chain collision: swapped target names occupy each other's filenames
  const t1 = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const t2 = new Date(2026, 0, 1, 10, 0, 5).getTime();
  const adapter = new InMemoryDirectoryAdapter({
    'IMG_1.jpg': makeMediaFile('IMG_1.jpg', 'photo-alpha', t1),
    'IMG_2.jpg': makeMediaFile('IMG_2.jpg', 'photo-beta', t2),
    'notes.txt': makeMediaFile('notes.txt', 'ignore-non-media', t1),
    'dup_copy.jpg': makeMediaFile('dup_copy.jpg', 'photo-alpha', t1 + 1000),
  });

  // Template forces IMG_1.jpg -> IMG_2.jpg and IMG_2.jpg -> IMG_3.jpg by using Original+1?
  // Even simpler: pre-name files directly to collide:
  const cycleAdapter = new InMemoryDirectoryAdapter({
    '2026-01-01_10-00-05_UnknownDevice.jpg': makeMediaFile('2026-01-01_10-00-05_UnknownDevice.jpg', 'first-photo', t1),
    '2026-01-01_10-00-00_UnknownDevice.jpg': makeMediaFile('2026-01-01_10-00-00_UnknownDevice.jpg', 'second-photo', t2),
  });
  const cycleSession = new RenameSession(cycleAdapter, '{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}_{Model}');
  await cycleSession.scan();
  // Swap names: each file's target is the OTHER file's currentName!
  const resSwap = await cycleSession.executeRename({ isPro: true, mode: 'all', batchSize: 10 });
  assert.ok(resSwap.files.every(f => f.status === 'success'), 'Swapped filenames must succeed via two-phase staging');
  assert.strictEqual(cycleAdapter.getFile('2026-01-01_10-00-00_UnknownDevice.jpg')?.size, 'first-photo'.length);
  assert.strictEqual(cycleAdapter.getFile('2026-01-01_10-00-05_UnknownDevice.jpg')?.size, 'second-photo'.length);

  // Undo swaps them back cleanly without collision errors
  const undone = await cycleSession.undo();
  assert.ok(undone.every(f => f.status === 'pending'));
  assert.strictEqual(cycleAdapter.getFile('2026-01-01_10-00-05_UnknownDevice.jpg')?.size, 'first-photo'.length);
  assert.strictEqual(cycleAdapter.getFile('2026-01-01_10-00-00_UnknownDevice.jpg')?.size, 'second-photo'.length);
  console.log('  -> Passed.');

  console.log('\n[TEST] 3. Extension Filtering, Duplicate Skip & RFC 4180 CSV Log...');
  const session = new RenameSession(adapter, 'Shoot_{Original}');
  const scanned = await session.scan();
  assert.strictEqual(scanned.length, 3, 'notes.txt must be filtered out');
  const dups = scanned.filter(f => f.isDuplicate);
  assert.strictEqual(dups.length, 1, 'dup_copy.jpg shares content hash with IMG_1.jpg');

  await session.executeRename({ isPro: true, mode: 'all', batchSize: 10 });
  const csv = session.toAuditCsv();
  assert.ok(csv.includes('"IMG_1.jpg","Shoot_IMG_1.jpg","success"'), `Unexpected CSV:\n${csv}`);
  assert.ok(csv.includes('"dup_copy.jpg","","pending"'), 'Duplicate must remain unrenamed in CSV');
  console.log('  -> Passed.');

  console.log('\n[TEST] 4. Trial Mode 20-File Batch Cap...');
  const bulkFiles: Record<string, SizableFile> = {};
  for (let i = 0; i < 25; i++) {
    const name = `RAW_${String(i).padStart(2, '0')}.jpg`;
    bulkFiles[name] = makeMediaFile(name, `unique-content-${i}`, t1 + i * 1000);
  }
  const bulkAdapter = new InMemoryDirectoryAdapter(bulkFiles);
  const trialSession = new RenameSession(bulkAdapter, 'Trial_{Original}');
  await trialSession.scan();
  await trialSession.executeRename({ isPro: false, mode: 'all', batchSize: 10 });
  const renamedCount = trialSession.files.filter(f => f.status === 'success').length;
  assert.strictEqual(renamedCount, TRIAL_BATCH_LIMIT, `Trial mode must cap at ${TRIAL_BATCH_LIMIT} files`);
  console.log('  -> Passed.');

  console.log('\n[SUCCESS] All Picture Perfect RenameSession tests passed!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n[FAILED]', err);
  process.exit(1);
});
