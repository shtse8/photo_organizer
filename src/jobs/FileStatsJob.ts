import { stat } from "fs/promises";
import { FileStats, FileStatsConfig } from "../types";
import { createHash, Hash } from "crypto";
import { createReadStream } from "fs";
import { BaseFileInfoJob } from "./BaseFileInfoJob";
import { bufferToSharedArrayBuffer } from "../utils";
import { injectable } from "inversify";

@injectable()
export class FileStatsJob extends BaseFileInfoJob<FileStats, FileStatsConfig> {
  protected readonly jobName = "fileStats";

  constructor(protected config: FileStatsConfig) {
    super();
  }

  protected async processFile(filePath: string): Promise<FileStats> {
    const stats = await stat(filePath);
    const hash = await this.hashFile(filePath, stats.size);
    return {
      hash,
      size: stats.size,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
    };
  }

  protected async hashFile(
    filePath: string,
    fileSize: number,
  ): Promise<SharedArrayBuffer> {
    const hash = createHash("md5");

    if (fileSize > this.config.maxChunkSize) {
      const chunkSize = this.config.maxChunkSize / 2;
      await this.hashFilePart(filePath, hash, 0, chunkSize);
      await this.hashFilePart(filePath, hash, fileSize - chunkSize, chunkSize);
    } else {
      await this.hashFilePart(filePath, hash);
    }

    return bufferToSharedArrayBuffer(hash.digest());
  }

  private hashFilePart(
    filePath: string,
    hash: Hash,
    start: number = 0,
    size?: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, {
        start,
        end: size ? start + size - 1 : undefined,
      });
      stream.on("data", (chunk: Buffer) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }
}
