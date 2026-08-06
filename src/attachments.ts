import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync, inflateSync } from "node:zlib";
import type { Page } from "playwright";
import type { HttpUrl } from "./types.ts";
import { parseConfig } from "./config.ts";
import { isOpenCodeProviderStopped, transcribeImage } from "./opencode.ts";

const execFileAsync = promisify(execFile);
const MAX_ATTACHMENT_BYTES = 32 << 20;
const MAX_PDF_STREAM_BYTES = 8 << 20;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_STORED_TEXT_CHARS = 12_000;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "heic"]);

export interface AttachmentTextRecord {
  fileName: string;
  chars: number;
  text: string;
}

export interface AttachmentFailureRecord {
  fileName: string;
  error: string;
}

interface AttachmentMetadata {
  fileName: string;
  uri: string;
}

interface AttachmentCollection {
  items: AttachmentTextRecord[];
  failures: AttachmentFailureRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function missingTool(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function attachmentUrl(uri: string): HttpUrl {
  const url = uri.startsWith("http") ? uri : `https://www.upwork.com${uri}`;
  return url as HttpUrl;
}

export function attachmentMetadata(details: unknown): AttachmentMetadata[] {
  if (!isRecord(details)) return [];
  const opening = isRecord(details.opening) ? details.opening : null;
  const job = opening && isRecord(opening.job) ? opening.job : null;
  const attachments = job?.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((value) => {
    if (!isRecord(value)) return [];
    const fileName = stringValue(value.fileName);
    const uri = stringValue(value.uri);
    return fileName && uri ? [{ fileName, uri }] : [];
  });
}

export async function downloadAttachment(page: Page, url: HttpUrl): Promise<Buffer> {
  const cdp = await page.context().newCDPSession(page);
  let stream: string | null = null;
  try {
    await cdp.send("Network.enable");
    const frameTree = (await cdp.send("Page.getFrameTree")).frameTree;
    const frameId = frameTree.frame.id;

    const loaded = await cdp.send("Network.loadNetworkResource", {
      frameId,
      url,
      options: { disableCache: false, includeCredentials: true },
    });
    const resource = loaded.resource;
    stream = resource.stream || null;
    if (!resource.success || !stream) {
      throw new Error(`attachment download failed with HTTP ${resource.httpStatusCode ?? "?"}`);
    }

    const chunks: Buffer[] = [];
    let downloaded = 0;
    for (let reads = 0; reads < 5_000; reads++) {
      const chunk = await cdp.send("IO.read", { handle: stream, size: 1 << 20 });
      if (chunk.data) {
        const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        downloaded += bytes.length;
        if (downloaded > MAX_ATTACHMENT_BYTES) throw new Error("attachment exceeds 32 MiB download limit");
        chunks.push(bytes);
      }
      if (chunk.eof) break;
    }
    return Buffer.concat(chunks);
  } finally {
    if (stream) await cdp.send("IO.close", { handle: stream }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

function htmlToText(bytes: Buffer): string {
  return bytes
    .toString("utf8")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCharCode(Number(decimal)))
    .replace(/\s+/g, " ")
    .trim();
}

async function textutilToText(bytes: Buffer, extension: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "upwho-attachment-"));
  const source = join(directory, `input.${extension}`);
  try {
    await writeFile(source, bytes);
    const result = await execFileAsync("textutil", ["-convert", "txt", "-stdout", source], { maxBuffer: 20 << 20 });
    return result.stdout.replace(/\s+/g, " ").trim();
  } catch (error) {
    if (missingTool(error)) return "";
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readableText(text: string): boolean {
  if (!text) return false;
  let controls = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls++;
  }
  if (controls / text.length > 0.01) return false;
  if (text.length < 40) return true;
  return (text.match(/\p{L}[\p{L}\p{M}\p{N}]{1,}/gu) || []).length >= 2;
}

function readPdfLiteral(content: string, start: number): { raw: string; end: number } | null {
  let depth = 1;
  for (let index = start + 1; index < content.length; index++) {
    if (content[index] === "\\") {
      index++;
      continue;
    }
    if (content[index] === "(") depth++;
    if (content[index] === ")" && --depth === 0) return { raw: content.slice(start, index + 1), end: index + 1 };
  }
  return null;
}

function readPdfTextArray(content: string, start: number): { literals: string[]; end: number } | null {
  const literals: string[] = [];
  let depth = 1;
  for (let index = start + 1; index < content.length; index++) {
    if (content[index] === "(") {
      const literal = readPdfLiteral(content, index);
      if (!literal) return null;
      literals.push(literal.raw);
      index = literal.end - 1;
    } else if (content[index] === "[") {
      depth++;
    } else if (content[index] === "]" && --depth === 0) {
      return { literals, end: index + 1 };
    }
  }
  return null;
}

function decodePdfLiteral(literal: string): string {
  return literal
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, character: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" })[character] || character)
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function pdfTextOperators(content: string, limit: number): string {
  const pieces: string[] = [];
  let count = 0;
  const append = (text: string) => {
    if (!text || count >= limit) return;
    const piece = text.slice(0, limit - count);
    pieces.push(piece);
    count += piece.length;
  };
  for (let index = 0; index < content.length && count < limit; index++) {
    if (content[index] === "(") {
      const literal = readPdfLiteral(content, index);
      if (!literal) continue;
      let operator = literal.end;
      while (/\s/.test(content[operator] || "")) operator++;
      if (content.startsWith("Tj", operator) || content[operator] === "'" || content[operator] === '"') append(decodePdfLiteral(literal.raw));
      index = literal.end - 1;
      continue;
    }
    if (content[index] !== "[") continue;
    const array = readPdfTextArray(content, index);
    if (!array) continue;
    let operator = array.end;
    while (/\s/.test(content[operator] || "")) operator++;
    if (content.startsWith("TJ", operator)) append(array.literals.map(decodePdfLiteral).join(""));
    index = array.end - 1;
  }
  return pieces.join(" ");
}

export function pdfExtractText(bytes: Buffer): string {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("PDF exceeds 32 MiB extraction limit");
  const source = bytes.toString("latin1");
  const pieces: string[] = [];
  let extracted = 0;
  const streamPattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source))) {
    const start = match.index + match[0].length;
    const end = source.indexOf("endstream", start);
    if (end < 0) continue;
    streamPattern.lastIndex = end + "endstream".length;
    const compressed = bytes.subarray(start, end);
    let inflated: Buffer | null = null;
    let oversized = false;
    try {
      inflated = inflateSync(compressed, { maxOutputLength: MAX_PDF_STREAM_BYTES });
    } catch (error) {
      oversized ||= isRecord(error) && error.code === "ERR_BUFFER_TOO_LARGE";
      try {
        inflated = inflateRawSync(compressed, { maxOutputLength: MAX_PDF_STREAM_BYTES });
      } catch (rawError) {
        oversized ||= isRecord(rawError) && rawError.code === "ERR_BUFFER_TOO_LARGE";
      }
    }
    if (oversized || !inflated) continue;
    const content = inflated.toString("latin1");
    if (!content.includes("Tj") && !content.includes("TJ")) continue;
    const text = pdfTextOperators(content, MAX_EXTRACTED_TEXT_CHARS - extracted);
    if (!readableText(text)) continue;
    pieces.push(text);
    extracted += text.length;
    if (extracted >= MAX_EXTRACTED_TEXT_CHARS) break;
  }
  return pieces.join("\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

async function ocrPdfFirstPage(bytes: Buffer, model: string): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), "upwho-attachment-"));
  const source = join(directory, "input.pdf");
  const image = join(directory, "input.png");
  try {
    await writeFile(source, bytes);
    await execFileAsync("sips", ["-s", "format", "png", source, "--out", image]);
    return await transcribeImage(await readFile(image), "image/png", model);
  } catch (error) {
    if (isOpenCodeProviderStopped(error)) throw error;
    if (missingTool(error)) return null;
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function extractText(bytes: Buffer, fileName: string, ocrModel = parseConfig().opencodeOcrModel): Promise<string> {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (["html", "htm", "txt", "md", "csv"].includes(extension)) return htmlToText(bytes);
  if (["doc", "docx", "rtf", "odt", "pages"].includes(extension)) return textutilToText(bytes, extension);
  if (extension === "pdf") {
    const text = pdfExtractText(bytes);
    if (text.replace(/\s/g, "").length >= 40) return text;
    if (ocrModel) return (await ocrPdfFirstPage(bytes, ocrModel)) || text;
    return text;
  }
  if (IMAGE_EXTENSIONS.has(extension) && ocrModel) {
    const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
    return (await transcribeImage(bytes, mime, ocrModel)) || "";
  }
  return "";
}

export async function collectAttachmentTexts(
  page: Page,
  details: unknown,
  ocrModel = parseConfig().opencodeOcrModel
): Promise<AttachmentCollection> {
  const items: AttachmentTextRecord[] = [];
  const failures: AttachmentFailureRecord[] = [];
  for (const attachment of attachmentMetadata(details)) {
    try {
      const text = await extractText(await downloadAttachment(page, attachmentUrl(attachment.uri)), attachment.fileName, ocrModel);
      if (!text) continue;
      items.push({ fileName: attachment.fileName, chars: text.length, text: text.slice(0, MAX_STORED_TEXT_CHARS) });
    } catch (error) {
      if (isOpenCodeProviderStopped(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const failure = { fileName: attachment.fileName, error: message };
      failures.push(failure);
    }
  }
  return { items, failures };
}
