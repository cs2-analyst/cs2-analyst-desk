import { verifyLibraryArchive } from './library-archive.ts';
import { isArchiveVerificationRequest } from './archive-verification.ts';

// One private Main job per process. Never send a report or canonical arrays back.
let initialized = false;
process.parentPort?.on('message', async ({ data }: { data: unknown }) => {
  if (initialized) return;
  initialized = true;
  if (!isArchiveVerificationRequest(data)) { process.exitCode = 1; process.exit(1); }
  try {
    const verified = await verifyLibraryArchive(data.directory);
    if (verified.manifestHash !== data.manifestHash) throw new Error('Archive changed before verification.');
    process.parentPort?.postMessage({ kind: 'archive-verified', jobId: data.jobId,
      manifestHash: verified.manifestHash, storedBytes: verified.storedBytes });
    // Main rechecks the manifest and terminates us, confirming exit before commit/export.
  } catch { process.exitCode = 1; process.exit(1); }
});
