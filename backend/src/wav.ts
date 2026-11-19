import { open, stat } from "node:fs/promises";

/**
 * Read a WAV file's header and return its duration in seconds.
 * Throws if the file is not a RIFF/WAVE file.
 *
 * A WAV file is a list of chunks: "fmt " says how many bytes make one second
 * of audio (byteRate), and "data" holds the samples. duration = dataSize / byteRate.
 */
export async function wavDurationSec(path: string): Promise<number> {
  const fileSize = (await stat(path)).size;
  const header = Buffer.alloc(Math.min(fileSize, 64 * 1024));
  const file = await open(path, "r");
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }

  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }

  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= header.length) {
    const chunkId = header.toString("ascii", offset, offset + 4);
    const chunkSize = header.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") byteRate = header.readUInt32LE(offset + 16);
    if (chunkId === "data") {
      if (!byteRate) throw new Error("WAV file has no fmt chunk before data");
      const dataSize = Math.min(chunkSize, fileSize - (offset + 8));
      return dataSize / byteRate;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are padded to an even size
  }
  throw new Error("WAV file has no data chunk");
}
