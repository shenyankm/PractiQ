export const BACKUP_FORMAT = 'practiq-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATABASE_PATH = 'database.sqlite';
export const PRACTIQ_APPLICATION_ID = 0x50525131;
export const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
export const MAX_MANAGED_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_ARCHIVE_BYTES = MAX_BACKUP_BYTES + 2 * 1024 * 1024;
export const MAX_BACKUP_FILES = 10_000;
const CRC32_TABLE = new Int32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

export function backupCrc32(bytes: Uint8Array) {
  return finishBackupCrc32(updateBackupCrc32(-1, bytes));
}

export function updateBackupCrc32(state: number, bytes: Uint8Array) {
  let crc = state;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return crc;
}

export function finishBackupCrc32(state: number) {
  return (state ^ -1) | 0;
}

export type BackupFileKind = 'media' | 'imports';

export interface BackupFileEntry {
  kind: BackupFileKind;
  archivePath: string;
  originalUri: string;
  size: number;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  databaseVersion: number;
  databaseSize: number;
  createdAt: string;
  files: BackupFileEntry[];
}

export interface SqliteSchemaEntry {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

export const PRACTIQ_REQUIRED_SCHEMA: Record<string, readonly string[]> = {
  schema_migrations: ['version', 'applied_at'],
  subjects: ['id', 'name'],
  question_types: ['code', 'name', 'sort_order'],
  knowledge_points: ['id', 'subject_id', 'parent_id', 'name'],
  question_banks: ['id', 'subject_id', 'name', 'is_favorite'],
  questions: ['id', 'subject_id', 'question_type_code', 'stem', 'status'],
  bank_question_links: ['bank_id', 'question_id', 'sort_order'],
  question_options: ['id', 'question_id', 'label', 'content'],
  question_answer_keys: ['id', 'question_id', 'version', 'answer_json', 'is_primary'],
  question_groups: ['id', 'subject_id', 'stem', 'status'],
  group_question_links: ['group_id', 'question_id', 'sort_order'],
  bank_group_links: ['bank_id', 'group_id', 'sort_order'],
  question_knowledge_links: ['question_id', 'knowledge_point_id'],
  media_assets: ['id', 'file_name', 'uri', 'mime_type', 'size'],
  question_content_blocks: ['id', 'question_id', 'group_id', 'kind', 'content'],
  media_links: ['id', 'media_asset_id', 'question_id', 'option_id', 'group_id'],
  question_import_jobs: ['id', 'bank_id', 'source_uri', 'stored_uri', 'status'],
  outputs: ['id', 'job_id', 'question_id', 'raw_json'],
  practice_sessions: ['id', 'bank_id', 'mode', 'status', 'total_questions'],
  practice_session_questions: ['session_id', 'question_id', 'position', 'answer_key_id'],
  question_answers: ['id', 'session_id', 'question_id', 'answer_json'],
  app_settings: ['key', 'value', 'updated_at'],
  questions_fts: ['stem'],
};

export const PRACTIQ_CURRENT_SCHEMA: Record<string, readonly string[]> = {
  practice_session_questions: ['snapshot_json'],
  learning_reports: ['id', 'report', 'created_at'],
  question_import_jobs: [
    'ai_profile',
    'ai_profile_revision',
    'source_mime_type',
    'source_size',
    'source_metadata_json',
  ],
};

export const PRACTIQ_CURRENT_OBJECTS: Record<'view' | 'trigger' | 'index', readonly string[]> = {
  view: ['practice_question_snapshot_source', 'question_stats', 'bank_stats'],
  trigger: [
    'questions_fts_insert',
    'questions_fts_delete',
    'questions_fts_update',
    'question_starts_as_draft',
    'question_status_moves_forward',
    'active_question_requires_answer_update',
    'group_starts_as_draft',
    'group_status_moves_forward',
    'active_group_requires_question',
    'group_archive_requires_inactive_questions',
    'active_question_requires_active_group',
    'bank_question_subject_must_match',
    'bank_group_subject_must_match',
    'group_question_subject_must_match',
    'bank_question_subject_update_must_match',
    'bank_group_subject_update_must_match',
    'group_question_subject_update_must_match',
    'question_knowledge_subject_must_match',
    'question_knowledge_subject_update_must_match',
    'linked_question_subject_is_immutable',
    'linked_group_subject_is_immutable',
    'linked_question_knowledge_subject_is_immutable',
    'linked_knowledge_point_subject_is_immutable',
    'populated_bank_subject_is_immutable',
    'practice_session_question_requires_snapshot',
    'practice_session_question_snapshot_is_immutable',
    'active_question_group_link_rejects_archived_group',
    'active_question_activates_draft_group',
    'empty_active_group_is_archived',
  ],
  index: [
    'one_primary_answer_per_question',
    'idx_banks_subject_favorite',
    'idx_questions_subject_type_status',
    'idx_bank_questions_order',
    'idx_knowledge_subject',
    'idx_import_jobs_status',
    'idx_outputs_job_review',
    'idx_sessions_bank_started',
    'idx_question_answers_session',
    'unique_media_question',
    'unique_media_option',
    'unique_media_group',
    'content_blocks_question_order',
    'content_blocks_group_order',
    'media_links_question_order',
    'media_links_option_order',
    'media_links_group_order',
    'group_questions_question_order',
    'idx_qkl_knowledge_question',
    'idx_answers_submitted',
    'idx_sessions_status_started',
    'idx_content_blocks_media',
    'idx_bank_groups_order',
    'idx_group_questions_order',
    'idx_questions_status',
    'idx_banks_recent',
    'idx_answers_question_stats',
    'idx_answers_session_stats',
  ],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function assertPractiqSchema(actual: Record<string, readonly string[]>) {
  for (const [table, requiredColumns] of Object.entries(PRACTIQ_REQUIRED_SCHEMA)) {
    const columns = new Set(actual[table] ?? []);
    if (!requiredColumns.every((column) => columns.has(column))) {
      throw new Error(`备份不是完整的 PractiQ 数据库：${table}`);
    }
  }
}

export function assertCurrentPractiqSchema(
  actualSchema: Record<string, readonly string[]>,
  actualObjects: Record<string, readonly string[]>,
) {
  for (const [table, requiredColumns] of Object.entries(PRACTIQ_CURRENT_SCHEMA)) {
    const columns = new Set(actualSchema[table] ?? []);
    if (!requiredColumns.every((column) => columns.has(column))) {
      throw new Error(`备份缺少当前 PractiQ 数据列：${table}`);
    }
  }
  for (const [type, requiredNames] of Object.entries(PRACTIQ_CURRENT_OBJECTS)) {
    const names = new Set(actualObjects[type] ?? []);
    if (!requiredNames.every((name) => names.has(name))) {
      throw new Error(`备份缺少当前 PractiQ ${type}`);
    }
  }
}

export function assertManagedFileCapacity(currentBytes: number, additionalBytes: number) {
  if (
    !Number.isSafeInteger(currentBytes) || currentBytes < 0 ||
    !Number.isSafeInteger(additionalBytes) || additionalBytes < 1 ||
    currentBytes + additionalBytes > MAX_MANAGED_FILE_BYTES
  ) throw new Error('媒体与导入源文件合计不能超过 64 MB，请先删除不再需要的内容');
}

const normalizeSchemaSql = (row: SqliteSchemaEntry) => {
  let sql = row.sql.replace(/\s+/g, ' ').trim();
  if (row.type === 'table' && row.name === 'question_import_jobs') {
    sql = sql.replace("stage TEXT NOT NULL DEFAULT '等待处理'", "stage TEXT NOT NULL DEFAULT 'stage:queued'");
  }
  return sql;
};

export function assertSqliteSchemaIdentity(
  expected: readonly SqliteSchemaEntry[],
  actual: readonly SqliteSchemaEntry[],
) {
  const entries = (rows: readonly SqliteSchemaEntry[]) => new Map(rows.map((row) => [
    `${row.type}:${row.name}:${row.tableName}`,
    normalizeSchemaSql(row),
  ]));
  const expectedEntries = entries(expected);
  const actualEntries = entries(actual);
  if (expectedEntries.size !== actualEntries.size) throw new Error('备份数据库包含未知或缺失的结构对象');
  for (const [key, sql] of expectedEntries) {
    if (actualEntries.get(key) !== sql) throw new Error(`备份数据库结构定义不可信：${key}`);
  }
}

export function assertSafeArchivePath(path: string) {
  if (
    !path ||
    path.length > 255 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('备份包含不安全的文件路径');
  }
}

export function detectBackupKind(bytes: Uint8Array): 'bundle' | 'legacy' {
  const sqliteHeader = 'SQLite format 3\u0000';
  if (
    bytes.byteLength >= sqliteHeader.length &&
    sqliteHeader.split('').every((character, index) => bytes[index] === character.charCodeAt(0))
  ) return 'legacy';
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) ||
      (bytes[2] === 5 && bytes[3] === 6) ||
      (bytes[2] === 7 && bytes[3] === 8))
  ) return 'bundle';
  throw new Error('不是有效的 PractiQ 备份或 SQLite 数据库');
}

export function assertBackupFileType(name: string, mimeType: string | undefined, kind: 'bundle' | 'legacy') {
  const extension = name.trim().toLocaleLowerCase('en-US').match(/\.([^.]+)$/)?.[1] ?? '';
  const acceptedExtensions = kind === 'bundle' ? ['zip', 'practiq'] : ['db', 'sqlite', 'sqlite3'];
  const acceptedMimeTypes = kind === 'bundle'
    ? ['application/zip', 'application/x-zip', 'application/x-zip-compressed', 'application/octet-stream']
    : ['application/x-sqlite3', 'application/vnd.sqlite3', 'application/octet-stream'];
  if (extension && !acceptedExtensions.includes(extension)) throw new Error('备份文件扩展名与内容不匹配');
  if (mimeType && !acceptedMimeTypes.includes(mimeType.toLocaleLowerCase('en-US'))) {
    throw new Error('备份文件类型不受支持');
  }
}

export function parseBackupManifest(value: unknown): BackupManifest {
  if (!isObject(value) || value.format !== BACKUP_FORMAT || value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error('PractiQ 备份格式不受支持');
  }
  if (
    typeof value.databaseVersion !== 'number' || !Number.isInteger(value.databaseVersion) || value.databaseVersion < 1 ||
    typeof value.databaseSize !== 'number' || !Number.isInteger(value.databaseSize) || value.databaseSize < 1 ||
    Number(value.databaseSize) > MAX_DATABASE_BYTES ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.files) || value.files.length > MAX_BACKUP_FILES
  ) throw new Error('PractiQ 备份清单无效');

  const files: BackupFileEntry[] = [];
  const paths = new Set<string>();
  const uris = new Set<string>();
  let fileTotal = 0;
  for (const item of value.files) {
    if (!isObject(item) || (item.kind !== 'media' && item.kind !== 'imports')) {
      throw new Error('PractiQ 备份清单包含无效文件');
    }
    const archivePath = item.archivePath;
    const originalUri = item.originalUri;
    const size = item.size;
    if (
      typeof archivePath !== 'string' ||
      typeof originalUri !== 'string' || !originalUri.startsWith('file://') || originalUri.length > 4096 ||
      typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_MANAGED_FILE_BYTES
    ) throw new Error('PractiQ 备份清单包含无效文件');
    assertSafeArchivePath(archivePath);
    if (!archivePath.startsWith(`files/${item.kind}/`) || archivePath.split('/').length !== 3) {
      throw new Error('PractiQ 备份清单路径无效');
    }
    if (paths.has(archivePath) || uris.has(originalUri)) throw new Error('PractiQ 备份清单包含重复文件');
    paths.add(archivePath);
    uris.add(originalUri);
    fileTotal += Number(size);
    if (fileTotal > MAX_MANAGED_FILE_BYTES) throw new Error('备份媒体与导入源文件超过 64 MB 安全上限');
    files.push({ kind: item.kind, archivePath, originalUri, size: Number(size) });
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    databaseVersion: Number(value.databaseVersion),
    databaseSize: Number(value.databaseSize),
    createdAt: value.createdAt,
    files,
  };
}
