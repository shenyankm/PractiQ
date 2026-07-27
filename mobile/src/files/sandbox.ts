import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

type UriRow = { uri: string };
let maintenanceTail: Promise<void> = Promise.resolve();

export function withFileMaintenance<T>(work: () => Promise<T>) {
  const result = maintenanceTail.then(work, work);
  maintenanceTail = result.then(() => undefined, () => undefined);
  return result;
}

export const safeName = (name: string) =>
  name.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(-120) || 'file';

export function deletePickerCacheCopy(file: File) {
  try {
    if (file.uri.startsWith(Paths.cache.uri) && file.exists) file.delete();
  } catch {
    // Picker cache cleanup is best effort and never touches provider originals.
  }
}

export function managedSandboxBytes() {
  return ['media', 'imports'].reduce((total, name) => {
    const directory = new Directory(Paths.document, name);
    directory.create({ idempotent: true, intermediates: true });
    return total + (directory.size ?? 0);
  }, 0);
}

export function isDirectManagedFile(uri: string, directory: Directory) {
  let normalized: string;
  try {
    normalized = new File(uri).uri;
  } catch {
    return false;
  }
  const prefix = `${directory.uri.replace(/\/+$/, '')}/`;
  if (!normalized.startsWith(prefix)) return false;
  try {
    const relative = decodeURIComponent(normalized.slice(prefix.length));
    return relative.length > 0 && relative !== '.' && relative !== '..' && !/[\\/]/.test(relative);
  } catch {
    return false;
  }
}

export function deleteManagedImportFiles(uris: readonly string[]) {
  return withFileMaintenance(async () => {
    const directory = new Directory(Paths.document, 'imports');
    let failed = 0;
    for (const uri of new Set(uris)) {
      if (!isDirectManagedFile(uri, directory)) continue;
      try {
        const file = new File(uri);
        if (file.exists) file.delete();
      } catch {
        failed += 1;
      }
    }
    return failed;
  });
}

/** Removes sandbox import files whose authoritative job rows no longer exist. */
export async function pruneOrphanImportFiles(db: SQLiteDatabase) {
  return withFileMaintenance(async () => {
    const referenced = new Set((await db.getAllAsync<UriRow>(
      'SELECT stored_uri AS uri FROM question_import_jobs',
    )).map((row) => row.uri));
    const directory = new Directory(Paths.document, 'imports');
    try {
      for (const item of directory.list()) {
        if (!(item instanceof File) || referenced.has(item.uri) || !isDirectManagedFile(item.uri, directory)) continue;
        item.delete();
      }
      return true;
    } catch {
      // Missing directories and individual provider cleanup failures are retried on the next launch.
      return false;
    }
  });
}
