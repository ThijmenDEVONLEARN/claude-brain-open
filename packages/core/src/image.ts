export type Sniffed = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; ext: "png" | "jpg" | "gif" | "webp"; width?: number; height?: number };

const be16 = (b: Buffer, i: number) => b.readUInt16BE(i);
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Herkent een afbeelding aan de eerste bytes (de bestandsnaam of het opgegeven type vertrouwen we niet)
 * en leest de afmetingen uit de header, zonder iets te decoderen. SVG wordt bewust niet ondersteund:
 * dat kan scripts bevatten.
 */
export function sniff(b: Buffer): Sniffed | undefined {
  try {
    if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { mime: "image/png", ext: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length > 10 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) {
      return { mime: "image/gif", ext: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) break;
        const m = b[i + 1]!;
        if (m === 0xff) {
          i++;
          continue;
        }
        if (SOF.has(m)) return { mime: "image/jpeg", ext: "jpg", height: be16(b, i + 5), width: be16(b, i + 7) };
        i += 2 + be16(b, i + 2);
      }
      return { mime: "image/jpeg", ext: "jpg" };
    }
    if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
      const kind = b.toString("latin1", 12, 16);
      if (kind === "VP8 ") return { mime: "image/webp", ext: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") {
        const bits = b.readUInt32LE(21);
        return { mime: "image/webp", ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (kind === "VP8X") return { mime: "image/webp", ext: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      return { mime: "image/webp", ext: "webp" };
    }
  } catch {
    /* afgekapte header: geen afbeelding */
  }
  return undefined;
}
