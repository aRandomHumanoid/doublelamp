// Reads esp_app_desc_t from an ESP-IDF app image (05 §10). It sits right after the image header (24 bytes) and
// the first segment header (8 bytes), at byte offset 32:
//   +0  u32 magic_word (0xABCD5432, little-endian)   +16 char version[32]      +48 char project_name[32]
//   +80 char time[16]                                 +96 char date[16]        +112 char idf_ver[32]

export const APP_DESC_OFFSET = 32;
export const APP_DESC_MAGIC = 0xabcd5432;
export const EXPECTED_PROJECT = "doublelamp";

const FIELDS = {
  magic: 32,
  version: { at: 48, len: 32 },
  project: { at: 80, len: 32 },
  time: { at: 112, len: 16 },
  date: { at: 128, len: 16 },
  idf: { at: 144, len: 32 },
} as const;

export interface AppDesc {
  version: string;
  projectName: string;
  time: string;
  date: string;
  idfVer: string;
}

export class AppDescError extends Error {}

function cstr(buf: Buffer, at: number, len: number): string {
  const slice = buf.subarray(at, at + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8").trim();
}

export function parseAppDesc(image: Buffer): AppDesc {
  const end = FIELDS.idf.at + FIELDS.idf.len;
  if (image.length < end) throw new AppDescError(`image too short (${image.length} bytes) to hold esp_app_desc_t`);
  const magic = image.readUInt32LE(FIELDS.magic);
  if (magic !== APP_DESC_MAGIC) {
    throw new AppDescError(`no esp_app_desc_t at offset ${APP_DESC_OFFSET} (magic 0x${magic.toString(16)}); is this an ESP-IDF app image?`);
  }
  const desc: AppDesc = {
    version: cstr(image, FIELDS.version.at, FIELDS.version.len),
    projectName: cstr(image, FIELDS.project.at, FIELDS.project.len),
    time: cstr(image, FIELDS.time.at, FIELDS.time.len),
    date: cstr(image, FIELDS.date.at, FIELDS.date.len),
    idfVer: cstr(image, FIELDS.idf.at, FIELDS.idf.len),
  };
  if (!desc.version) throw new AppDescError("esp_app_desc_t has an empty version");
  return desc;
}

/** Parses and checks the project name (05 §10 / 03 §15: must be "doublelamp"). */
export function parseDoubleLampImage(image: Buffer): AppDesc {
  const desc = parseAppDesc(image);
  if (desc.projectName !== EXPECTED_PROJECT) {
    throw new AppDescError(`project_name is "${desc.projectName}", expected "${EXPECTED_PROJECT}"`);
  }
  return desc;
}

/** Builds a minimal image with an app descriptor (tests and tools). */
export function buildTestImage(opts: { version: string; project?: string; idf?: string; size?: number; fill?: number }): Buffer {
  const size = Math.max(opts.size ?? 4096, FIELDS.idf.at + FIELDS.idf.len);
  const buf = Buffer.alloc(size, opts.fill ?? 0);
  buf[0] = 0xe9; // ESP image magic
  buf.writeUInt32LE(APP_DESC_MAGIC, FIELDS.magic);
  buf.write(opts.version, FIELDS.version.at, FIELDS.version.len - 1, "utf8");
  buf.write(opts.project ?? EXPECTED_PROJECT, FIELDS.project.at, FIELDS.project.len - 1, "utf8");
  buf.write("12:00:00", FIELDS.time.at, FIELDS.time.len - 1, "utf8");
  buf.write("Oct 28 2026", FIELDS.date.at, FIELDS.date.len - 1, "utf8");
  buf.write(opts.idf ?? "v5.3.1", FIELDS.idf.at, FIELDS.idf.len - 1, "utf8");
  for (let i = FIELDS.idf.at + FIELDS.idf.len; i < size; i++) buf[i] = (i * 31 + opts.version.length) & 0xff;
  return buf;
}
