import 'server-only';

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './api';

const defaultMountDir = '/lhcos-data';
const avatarMaxBytes = Number(process.env.AVATAR_MAX_BYTES || 5 * 1024 * 1024);
const importSourceMaxBytes = Number(process.env.IMPORT_SOURCE_MAX_BYTES || 25 * 1024 * 1024);
const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const genericUploadMimeTypes = new Set(['application/octet-stream', 'binary/octet-stream']);
const signatureBytes = 4096;

const mimeExtensionMap: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'text/plain': '.txt',
  [docxMimeType]: '.docx'
};

export type StoredObject = {
  relativePath: string;
  objectUrl: string;
  absolutePath: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number;
};

export function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as File).arrayBuffer === 'function'
      && typeof (value as File).size === 'number'
      && (value as File).size > 0
  );
}

export async function storeAvatarFile(userId: number, file: File) {
  return storeObjectFromFile(file, {
    directory: `avatars/${userId}`,
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    maxBytes: avatarMaxBytes,
    prefix: 'avatar'
  });
}

export async function storeImportSourceFile(userId: number, jobId: number, file: File) {
  return storeObjectFromFile(file, {
    directory: `imports/${userId}/${jobId}`,
    allowedExtensions: ['.txt', '.docx'],
    allowedMimeTypes: ['text/plain', docxMimeType],
    maxBytes: importSourceMaxBytes,
    prefix: 'source'
  });
}

export function inferImportSourceType(file: File | { name?: string | null; type?: string | null }) {
  const extension = path.extname(file.name || '').toLowerCase();
  if (extension === '.docx' || file.type === docxMimeType) return 'docx';
  if (extension === '.txt' || file.type === 'text/plain') return 'txt';
  return 'unknown';
}

export async function readObjectBuffer(relativePath: string) {
  return fs.readFile(resolveStoragePath(relativePath));
}

export function relativePathFromObjectUrl(objectUrl: string | null | undefined) {
  if (!objectUrl) return null;

  const publicBaseUrl = objectStoragePublicBaseUrl();
  if (publicBaseUrl && objectUrl.startsWith(`${publicBaseUrl}/`)) {
    return decodeRelativePath(objectUrl.slice(publicBaseUrl.length + 1));
  }

  const urlPrefix = objectStorageUrlPrefix();
  if (objectUrl.startsWith(`${urlPrefix}/`)) {
    return decodeRelativePath(objectUrl.slice(urlPrefix.length + 1));
  }

  return null;
}

function objectStorageMountDir() {
  return path.resolve(process.env.OBJECT_STORAGE_MOUNT_DIR || process.env.OSS_MOUNT_DIR || defaultMountDir);
}

function objectStoragePublicBaseUrl() {
  return trimTrailingSlash(process.env.OSS_PUBLIC_BASE_URL || process.env.OBJECT_STORAGE_PUBLIC_BASE_URL || '');
}

function objectStorageUrlPrefix() {
  return trimTrailingSlash(process.env.OSS_URL_PREFIX || process.env.OBJECT_STORAGE_URL_PREFIX || 'oss://openwook');
}

async function storeObjectFromFile(
  file: File,
  options: {
    directory: string;
    allowedExtensions: string[];
    allowedMimeTypes: string[];
    maxBytes: number;
    prefix: string;
  }
): Promise<StoredObject> {
  if (file.size <= 0) {
    throw new ApiError(400, 'EMPTY_FILE', 'Uploaded file is empty');
  }
  if (file.size > options.maxBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE', `Uploaded file exceeds ${options.maxBytes} bytes`);
  }

  const mimeType = file.type || null;
  const extension = extensionForFile(file, options.allowedExtensions);
  const mimeAllowed = !mimeType || options.allowedMimeTypes.includes(mimeType) || genericUploadMimeTypes.has(mimeType);
  if (!extension || !mimeAllowed) {
    throw new ApiError(400, 'UNSUPPORTED_FILE_TYPE', `Unsupported file type: ${file.name || mimeType || 'unknown'}`);
  }

  const directory = safeRelativePath(options.directory);
  const fileName = `${sanitizePathSegment(options.prefix)}-${Date.now()}-${randomUUID()}${extension}`;
  const relativePath = `${directory}/${fileName}`;
  const absolutePath = resolveStoragePath(relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const signature = await writeFileAndCaptureSignature(file, absolutePath, options.maxBytes, extension);
  validateFileSignatureForTest(extension, signature);

  return {
    relativePath,
    objectUrl: objectUrlForRelativePath(relativePath),
    absolutePath,
    originalName: file.name || null,
    mimeType: mimeType || mimeTypeFromExtension(extension),
    sizeBytes: file.size
  };
}

async function writeFileAndCaptureSignature(file: File, absolutePath: string, maxBytes: number, extension: string) {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let writtenBytes = 0;
  const sink = createWriteStream(absolutePath, { flags: 'wx' });

  try {
    await pipeline(
      Readable.fromWeb(file.stream() as never),
      async function* (source) {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          writtenBytes += buffer.length;
          if (writtenBytes > maxBytes) {
            throw new ApiError(413, 'FILE_TOO_LARGE', `Uploaded file exceeds ${maxBytes} bytes`);
          }
          if (extension === '.txt' && buffer.includes(0)) {
            throw new ApiError(400, 'UNSUPPORTED_FILE_TYPE', 'TXT files must be plain text');
          }
          if (capturedBytes < signatureBytes) {
            const slice = buffer.subarray(0, signatureBytes - capturedBytes);
            chunks.push(slice);
            capturedBytes += slice.length;
          }
          yield buffer;
        }
      },
      sink
    );
  } catch (error) {
    await fs.rm(absolutePath, { force: true }).catch(() => {});
    throw error;
  }

  if (writtenBytes !== file.size) {
    await fs.rm(absolutePath, { force: true }).catch(() => {});
    throw new ApiError(400, 'INVALID_UPLOAD', 'Uploaded file size changed while streaming');
  }

  return Buffer.concat(chunks);
}

function objectUrlForRelativePath(relativePath: string) {
  const encodedPath = safeRelativePath(relativePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const publicBaseUrl = objectStoragePublicBaseUrl();
  if (publicBaseUrl) return `${publicBaseUrl}/${encodedPath}`;
  return `${objectStorageUrlPrefix()}/${encodedPath}`;
}

function resolveStoragePath(relativePath: string) {
  const mountDir = objectStorageMountDir();
  const absolutePath = path.resolve(mountDir, safeRelativePath(relativePath));
  if (absolutePath !== mountDir && !absolutePath.startsWith(`${mountDir}${path.sep}`)) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Invalid object storage path');
  }
  return absolutePath;
}

function extensionForFile(file: File, allowedExtensions: string[]) {
  const extension = path.extname(file.name || '').toLowerCase();
  if (allowedExtensions.includes(extension)) return extension;
  const mappedExtension = file.type ? mimeExtensionMap[file.type] : null;
  return mappedExtension && allowedExtensions.includes(mappedExtension) ? mappedExtension : null;
}

function mimeTypeFromExtension(extension: string) {
  return Object.entries(mimeExtensionMap).find(([, mappedExtension]) => mappedExtension === extension)?.[0] ?? null;
}

export function validateFileSignatureForTest(extension: string, buffer: Buffer) {
  if (extension === '.docx' && buffer.subarray(0, 2).toString('utf8') !== 'PK') {
    throw new ApiError(400, 'UNSUPPORTED_FILE_TYPE', 'DOCX files must be valid Office Open XML documents');
  }

  if (extension === '.txt' && buffer.includes(0)) {
    throw new ApiError(400, 'UNSUPPORTED_FILE_TYPE', 'TXT files must be plain text');
  }
}

function safeRelativePath(value: string) {
  const segments = value
    .split('/')
    .map((segment) => sanitizePathSegment(segment))
    .filter(Boolean);
  if (segments.length === 0) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Storage path is empty');
  }
  return segments.join('/');
}

function sanitizePathSegment(value: string) {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  if (!segment || segment === '.' || segment === '..') return '';
  return segment;
}

function decodeRelativePath(value: string) {
  try {
    return safeRelativePath(value.split('/').map((segment) => decodeURIComponent(segment)).join('/'));
  } catch {
    return null;
  }
}

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, '');
}
