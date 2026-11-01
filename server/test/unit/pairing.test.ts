import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/db";
import { CROCKFORD_ALPHABET, PairingCodes, generatePairingCode, hashPairingCode, normalizePairingCode } from "../../src/pairing";

describe("pairing code format", () => {
  it("is 8 Crockford base32 characters shown as XXXX-XXXX (40 bits)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
    expect(generatePairingCode(Buffer.from([0, 0, 0, 0, 0]))).toBe("0000-0000");
    expect(generatePairingCode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe("ZZZZ-ZZZZ");
    // 0x08 0x42 0x10 0x84 0x21 = 00001 00001 00001 00001 00001 00001 00001 00001
    expect(generatePairingCode(Buffer.from([0x08, 0x42, 0x10, 0x84, 0x21]))).toBe("1111-1111");
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("normalizes typed codes the Crockford way", () => {
    expect(normalizePairingCode("k7qm-4ztx")).toBe("K7QM4ZTX");
    expect(normalizePairingCode("K7QM 4ZTX")).toBe("K7QM4ZTX");
    expect(normalizePairingCode("OIL0-0000")).toBe("01100000");
    expect(normalizePairingCode("K7QM-4ZT")).toBeNull();
    expect(normalizePairingCode("K7QM-4ZTU")).toBeNull(); // U isn't in the alphabet
    expect(normalizePairingCode("K7QM-4ZTX9")).toBeNull();
  });
});

describe("PairingCodes", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const clock = { now: 1_000_000 };
    return { db, clock, codes: new PairingCodes(db, () => clock.now) };
  }

  it("stores only sha256(code), and a code works once", () => {
    const { db, codes } = setup();
    const { code, expiresIn } = codes.create();
    expect(expiresIn).toBe(600);
    const rows = db.prepare("SELECT code_hash FROM pairing_codes").all() as { code_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(hashPairingCode(normalizePairingCode(code)!));
    expect(JSON.stringify(rows)).not.toContain(code.replace("-", ""));
    expect(codes.consume(code.toLowerCase(), "dl-000001")).toBe("ok");
    expect(codes.consume(code, "dl-000002")).toBe("invalid");
  });

  it("expires after 10 minutes", () => {
    const { codes, clock } = setup();
    const { code } = codes.create();
    clock.now += 10 * 60_000;
    expect(codes.consume(code, "dl-000001")).toBe("expired");
  });

  it("rejects unknown and malformed codes", () => {
    const { codes } = setup();
    codes.create();
    expect(codes.consume("0000-0000", "dl-000001")).toBe("invalid");
    expect(codes.consume("nope", "dl-000001")).toBe("invalid");
  });
});
