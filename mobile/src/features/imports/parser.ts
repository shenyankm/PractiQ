import JSZip from 'jszip';

import { validateQuestion } from '../../logic';
import type { ParsedQuestion } from '../../types';

export type ImportFileType = 'txt' | 'docx';

export const MAX_AI_DOCUMENT_CHARACTERS = 250_000;
export const MAX_AI_IMPORT_QUESTIONS = 200;

export const TXT_MIME_TYPE = 'text/plain';
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const IMPORT_MIME_TYPES = [TXT_MIME_TYPE, DOCX_MIME_TYPE] as const;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_QUESTIONS = 5_000;

const MAX_SOURCE_CHARACTERS = 5_000_000;
const MAX_STEM_CHARACTERS = 20_000;
export const MAX_FIELD_CHARACTERS = 20_000;
const MAX_DOCX_ENTRIES = 5_000;
const MAX_DOCX_DECLARED_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;
// Independent hard cap on the actually-decompressed XML length. This does not rely on
// JSZip's private uncompressed-size field, so the zip-bomb guard degrades safely if
// that field ever changes.
const MAX_DOCX_XML_CHARACTERS = MAX_DOCX_XML_BYTES;
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function assertImportFileSize(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('不能导入空文件');
  if (size > MAX_IMPORT_BYTES) throw new Error('文件不能超过 25 MB');
}

export interface ImportInspection {
  fileType: ImportFileType;
  mimeType: typeof TXT_MIME_TYPE | typeof DOCX_MIME_TYPE;
  size: number;
  text?: string;
}

export function expectedMimeType(fileType: ImportFileType) {
  return fileType === 'txt' ? TXT_MIME_TYPE : DOCX_MIME_TYPE;
}

export function importFileTypeFromName(name: string): ImportFileType {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('文件名无效或过长');
  }
  const extension = trimmed.toLocaleLowerCase('en-US').match(/\.([^.]+)$/)?.[1];
  if (extension === 'txt' || extension === 'docx') return extension;
  throw new Error('仅支持扩展名为 .txt 或 .docx 的文件');
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean) {
  if ((bytes.byteLength - 2) % 2 !== 0) throw new Error('TXT 文件编码无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset + 2, bytes.byteLength - 2);
  const parts: string[] = [];
  let chunk: number[] = [];
  for (let offset = 0; offset < view.byteLength; offset += 2) {
    chunk.push(view.getUint16(offset, littleEndian));
    if (chunk.length === 4_096) {
      parts.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  }
  if (chunk.length) parts.push(String.fromCharCode(...chunk));
  return parts.join('');
}

function decodeText(bytes: Uint8Array) {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = decodeUtf16(bytes, true);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = decodeUtf16(bytes, false);
  } else {
    if (bytes.includes(0)) throw new Error('TXT 文件包含二进制内容');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('TXT 文件必须使用 UTF-8 或带 BOM 的 UTF-16 编码');
    }
  }
  if (text.includes('\0')) throw new Error('TXT 文件包含二进制内容');
  if (!text.trim()) throw new Error('TXT 文件没有可解析文本');
  if (text.length > MAX_SOURCE_CHARACTERS) throw new Error('文件解码后的文本过长');
  return text.replace(/^\ufeff/, '');
}

/** Pure validation helper, exported so its trust-boundary behavior can be unit tested. */
export function inspectImportBytes({
  name,
  mimeType,
  bytes,
  size = bytes.byteLength,
}: {
  name: string;
  mimeType?: string | null;
  bytes: Uint8Array;
  size?: number;
}): ImportInspection {
  const fileType = importFileTypeFromName(name);
  const expectedMime = expectedMimeType(fileType);
  if (mimeType && mimeType.length > 255) throw new Error('文件 MIME 类型无效');
  const normalizedMime = mimeType?.split(';', 1)[0].trim().toLocaleLowerCase('en-US');
  if (normalizedMime && normalizedMime !== expectedMime) {
    throw new Error(`文件 MIME 类型与 .${fileType} 扩展名不一致`);
  }
  assertImportFileSize(size);
  if (bytes.byteLength > size) throw new Error('文件大小与读取内容不一致');

  if (fileType === 'docx') {
    const isZipHeader =
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
        (bytes[2] === 0x05 && bytes[3] === 0x06) ||
        (bytes[2] === 0x07 && bytes[3] === 0x08));
    if (!isZipHeader) throw new Error('DOCX 文件头无效');
    return { fileType, mimeType: expectedMime, size };
  }

  if (bytes.byteLength !== size) throw new Error('TXT 文件读取不完整');
  return { fileType, mimeType: expectedMime, size, text: decodeText(bytes) };
}

function decodeXml(value: string) {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, raw: string) => {
      const hexadecimal = raw[0].toLocaleLowerCase('en-US') === 'x';
      const point = Number.parseInt(hexadecimal ? raw.slice(1) : raw, hexadecimal ? 16 : 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textFromXmlFragment(xml: string) {
  const parts: string[] = [];
  for (const match of xml.matchAll(/<(?:w:t|m:t)\b[^>]*>([\s\S]*?)<\/(?:w:t|m:t)>/g)) {
    parts.push(decodeXml(match[1]));
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

async function documentText(xml: string, checkpoint: () => void) {
  const paragraphs: string[] = [];
  let inspected = 0;
  let characters = 0;
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const value = textFromXmlFragment(match[1]);
    if (value) {
      characters += value.length + (paragraphs.length ? 1 : 0);
      if (characters > MAX_SOURCE_CHARACTERS) throw new Error('DOCX 解压后的文本过长');
      paragraphs.push(value);
    }
    inspected += 1;
    if (inspected % 200 === 0) {
      checkpoint();
      await yieldToEvents();
    }
  }
  const text = paragraphs.join('\n').trim();
  if (!text) throw new Error('DOCX 中没有可解析文本');
  return text;
}

/** Deterministic, entirely local DOCX extraction. No document content leaves the device. */
export async function extractDocx(
  bytes: Uint8Array,
  checkpoint: () => void = () => undefined,
) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  } catch {
    throw new Error('DOCX 文件结构损坏或无法解压');
  }
  checkpoint();

  const entries = Object.values(zip.files);
  if (entries.length > MAX_DOCX_ENTRIES) throw new Error('DOCX 包含过多文件，无法安全解析');
  let declaredBytes = 0;
  for (const [index, entry] of entries.entries()) {
    // ponytail: JSZip exposes no public uncompressed size; replace this guard if it adds one.
    const size = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (!entry.dir && (!Number.isFinite(size) || (size ?? -1) < 0)) {
      throw new Error('DOCX 压缩目录缺少大小信息');
    }
    declaredBytes += size ?? 0;
    if (declaredBytes > MAX_DOCX_DECLARED_BYTES) throw new Error('DOCX 解压后超过 64 MB');
    if (/^(?:\[Content_Types\]\.xml|word\/document\.xml)$/i.test(entry.name) && (size ?? 0) > MAX_DOCX_XML_BYTES) {
      throw new Error('DOCX XML 内容过大');
    }
    if ((index + 1) % 250 === 0) {
      checkpoint();
      await yieldToEvents();
    }
  }

  const contentTypesFile = zip.file('[Content_Types].xml');
  const documentFile = zip.file('word/document.xml');
  if (!contentTypesFile || !documentFile) throw new Error('文件不是有效的 DOCX 文档');
  const contentTypes = await contentTypesFile.async('string');
  if (contentTypes.length > MAX_DOCX_XML_CHARACTERS) throw new Error('DOCX XML 内容过大');
  if (!contentTypes.includes('wordprocessingml.document.main+xml')) {
    throw new Error('文件内容类型不是 DOCX 文档');
  }
  checkpoint();
  await yieldToEvents();
  const xml = await documentFile.async('string');
  if (xml.length > MAX_DOCX_XML_CHARACTERS) throw new Error('DOCX XML 内容过大');
  return documentText(xml, checkpoint);
}

export function normalizeQuestions(questions: ParsedQuestion[], parser: 'local' | 'ai') {
  if (!questions.length) throw new Error('没有识别到题目，请检查编号、答案和换行格式');
  const maximum = parser === 'ai' ? MAX_AI_IMPORT_QUESTIONS : MAX_IMPORT_QUESTIONS;
  if (questions.length > maximum) throw new Error(`单次最多导入 ${maximum.toLocaleString('en-US')} 道题`);
  return questions.map((question, index): ParsedQuestion => {
    const stem = question.stem.trim();
    if (!stem) throw new Error(`第 ${index + 1} 道题缺少题干`);
    if (stem.length > MAX_STEM_CHARACTERS) throw new Error(`第 ${index + 1} 道题题干过长`);
    if (question.explanation.length > MAX_FIELD_CHARACTERS) {
      throw new Error(`第 ${index + 1} 道题解析过长`);
    }
    const labels = new Set<string>();
    const options = question.options.flatMap((option) => {
      const label = option.label.trim().toLocaleUpperCase('en-US');
      const content = option.content.trim();
      if (!label || !content || labels.has(label)) return [];
      if (content.length > MAX_FIELD_CHARACTERS) throw new Error(`第 ${index + 1} 道题选项过长`);
      labels.add(label);
      return [{ label, content, sort_order: labels.size - 1 }];
    });
    const confidence = Math.max(0, Math.min(1, Number(question.confidence) || 0));
    const answer = question.answer ?? {};
    const errors = validateQuestion({ stem, type: question.type, status: 'draft', options, answer });
    if (errors.length) throw new Error(`第 ${index + 1} 道题：${errors.join('；')}`);
    const answerJson = JSON.stringify(answer);
    if (!answerJson || answerJson.length > MAX_FIELD_CHARACTERS) throw new Error(`第 ${index + 1} 道题答案过长`);
    return {
      ...question,
      stem,
      explanation: question.explanation.trim(),
      options,
      answer,
      confidence,
      metadata: { ...question.metadata, parser, fallback: parser === 'local' },
    };
  });
}
