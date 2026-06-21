// Unit tests for the pure image-format sniffers (no network, no filesystem —
// HARD INVARIANT #2). The makeVideoPort download/write wrappers touch the network
// and disk and are only exercised via the pipeline-seam tests with a faked
// VideoPort; here we lock the magic-byte / Content-Type detection that decides
// what extension a thumbnail is stored under and what Content-Type the route
// serves (IG `displayUrl` is frequently WebP/HEIC, not JPEG).

import { describe, expect, it } from "vitest";
import { formatFromContentType, sniffImageFormat } from "./video.js";

const bytesOf = (...nums: number[]): Uint8Array => new Uint8Array(nums);

describe("sniffImageFormat (magic bytes)", () => {
  it("detects JPEG", () => {
    expect(sniffImageFormat(bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00))).toEqual({
      ext: "jpg",
      mime: "image/jpeg",
    });
  });

  it("detects PNG", () => {
    expect(sniffImageFormat(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toEqual({
      ext: "png",
      mime: "image/png",
    });
  });

  it("detects WebP (RIFF…WEBP)", () => {
    // "RIFF" + 4 size bytes + "WEBP"
    const webp = bytesOf(
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    );
    expect(sniffImageFormat(webp)).toEqual({ ext: "webp", mime: "image/webp" });
  });

  it("detects HEIC (ISO-BMFF ftyp with a heic brand)", () => {
    // 4-byte box size + "ftyp" + "heic" major brand
    const heic = bytesOf(
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    );
    expect(sniffImageFormat(heic)).toEqual({ ext: "heic", mime: "image/heic" });
  });

  it("detects GIF", () => {
    expect(sniffImageFormat(bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toEqual({
      ext: "gif",
      mime: "image/gif",
    });
  });

  it("returns undefined for unrecognized / truncated bytes", () => {
    expect(sniffImageFormat(bytesOf(0x00, 0x01, 0x02))).toBeUndefined();
    expect(sniffImageFormat(bytesOf(0xff, 0xd8))).toBeUndefined(); // too short for JPEG
    // ftyp box with an unknown (non-image) brand isn't misread as HEIC
    const mp4 = bytesOf(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32);
    expect(sniffImageFormat(mp4)).toBeUndefined();
  });
});

describe("formatFromContentType (HTTP header fallback)", () => {
  it("maps a bare image MIME", () => {
    expect(formatFromContentType("image/webp")).toEqual({ ext: "webp", mime: "image/webp" });
  });

  it("ignores parameters and is case-insensitive", () => {
    expect(formatFromContentType("Image/JPEG; charset=binary")).toEqual({
      ext: "jpg",
      mime: "image/jpeg",
    });
  });

  it("returns undefined for unknown or missing types", () => {
    expect(formatFromContentType("application/octet-stream")).toBeUndefined();
    expect(formatFromContentType(null)).toBeUndefined();
    expect(formatFromContentType(undefined)).toBeUndefined();
  });
});
