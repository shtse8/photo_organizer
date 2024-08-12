import { readdir, stat, mkdir, rename, copyFile, unlink, readFile, open } from 'fs/promises';
import { join, parse, basename, dirname, extname, relative } from 'path';
import { Semaphore, Mutex } from 'async-mutex';
import { ExifTool } from 'exiftool-vendored';
import { Command } from 'commander';
import sharp from 'sharp';
import { createHash } from 'crypto';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import { Buffer } from 'buffer';
import colors from 'ansi-colors';

// Initialize ExifTool
const exiftool = new ExifTool();

// Define the supported file extensions
const SUPPORTED_EXTENSIONS = {
  images: ['jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'jp2', 'j2c', 'jpf', 'jpx', 'jpm', 'mj2', 
           'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'dib', 'heic', 'heif', 'avif'],
  rawImages: ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'ptx', 'pef', 'rw2', 'raf', 'raw', 'x3f', 'srw'],
  videos: ['mp4', 'm4v', 'mov', '3gp', '3g2', 'avi', 'mpg', 'mpeg', 'mpe', 'mpv', 'm2v', 'm2p', 
           'm2ts', 'mts', 'ts', 'qt', 'wmv', 'asf', 'flv', 'f4v', 'webm', 'divx']
};

const ALL_SUPPORTED_EXTENSIONS = [
  ...SUPPORTED_EXTENSIONS.images,
  ...SUPPORTED_EXTENSIONS.rawImages,
  ...SUPPORTED_EXTENSIONS.videos
];

interface FileInfo {
  path: string;
  size: number;
  hash: string;
  perceptualHash?: string;
  
  imageDate: Date;
  hasGeolocation: boolean;
  metadataCount: number;
  quality?: number;
}

interface ProgramOptions {
  source: string[];
  target: string;
  error?: string;
  duplicate?: string;
  workers: string;
  move: boolean;
  resolution: string;
  hamming: string;
  format: string;
}

class LSH {
  private bands: Map<string, Set<string>>[];
  private bandSize: number;
  private numBands: number;

  constructor(hashSize: number = 64, numBands: number = 8) {
    this.bandSize = hashSize / numBands;
    this.numBands = numBands;
    this.bands = Array.from({ length: numBands }, () => new Map<string, Set<string>>());
  }

  add(hash: string, identifier: string) {
    for (let i = 0; i < this.numBands; i++) {
      const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
      if (!this.bands[i].has(bandHash)) {
        this.bands[i].set(bandHash, new Set());
      }
      this.bands[i].get(bandHash)!.add(identifier);
    }
  }

  remove(hash: string, identifier: string) {
    for (let i = 0; i < this.numBands; i++) {
      const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
      const bandCandidates = this.bands[i].get(bandHash);
      if (bandCandidates) {
        bandCandidates.delete(identifier);
        if (bandCandidates.size === 0) {
          this.bands[i].delete(bandHash);
        }
      }
    }
  }

  getCandidates(hash: string): Set<string> {
    const candidates = new Set<string>();
    for (let i = 0; i < this.numBands; i++) {
      const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
      const bandCandidates = this.bands[i].get(bandHash);
      if (bandCandidates) {
        for (const candidate of bandCandidates) {
          candidates.add(candidate);
        }
      }
    }
    return candidates;
  }
}


// Stage 1: File Discovery
async function discoverFiles(sourceDirs: string[], concurrency: number = 10, logInterval: number = 10000): Promise<string[]> {
  const allFiles: string[] = [];
  let dirCount = 0;
  let fileCount = 0;
  let lastLogFileCount = 0;
  const startTime = Date.now();
  const semaphore = new Semaphore(concurrency);

  async function scanDirectory(dirPath: string): Promise<void> {
    try {
      dirCount++;
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const [_, release] = await semaphore.acquire();
          scanDirectory(entryPath).finally(() => {
            release();
          });
        } else if (ALL_SUPPORTED_EXTENSIONS.includes(extname(entry.name).slice(1).toLowerCase())) {
          allFiles.push(entryPath);
          fileCount++;

          // Log progress after every logInterval files
          if (fileCount - lastLogFileCount >= logInterval) {
            lastLogFileCount = fileCount;
            console.log(chalk.blue(`Processed ${dirCount} directories, found ${fileCount} files...`));
          }
        }
      }
    } catch (error) {
      console.error(chalk.red(`Error scanning directory ${dirPath}:`, error));
    }
  }

  // Start scanning all source directories
  for (const dirPath of sourceDirs) {
    const [_, release] = await semaphore.acquire();
    scanDirectory(dirPath).finally(() => {
      release();
    });
  }

  // Wait for all scanning processes to complete
  await semaphore.waitForUnlock(concurrency);

  const duration = (Date.now() - startTime) / 1000;
  console.log(chalk.green(`\nDiscovery completed in ${duration.toFixed(2)} seconds:`));
  console.log(chalk.cyan(`- Scanned ${dirCount} directories`));
  console.log(chalk.cyan(`- Found ${fileCount} files`));

  return allFiles;
}

// Stage 2: Deduplication
async function deduplicateFiles(
  files: string[],
  resolution: number,
  hammingThreshold: number,
  existingFiles: Map<string, FileInfo>,
  lsh: LSH,
  concurrency: number = 10
): Promise<{
  uniqueFiles: Map<string, FileInfo>,
  duplicates: Map<string, string>,
  formatCounts: Map<string, number>,
  errorCount: number
}> {
  const duplicates = new Map<string, string>();
  const perceptualHashMap = new Map<string, string>();
  const formatCounts = new Map<string, number>();
  let errorCount = 0;
  let processedCount = 0;

  // Count the number of files for each format
  const formatFileCounts = files.reduce((acc, file) => {
    const ext = extname(file).slice(1).toLowerCase();
    acc[ext] = (acc[ext] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Initialize MultiBar
  const multibar = new cliProgress.MultiBar({
    hideCursor: true,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591'
  }, cliProgress.Presets.shades_classic);

  // Initialize individual progress bars for each format
  const formatBars: Map<string, cliProgress.SingleBar> = new Map();

  for (const [ext, count] of Object.entries(formatFileCounts)) {
    formatBars.set(ext, multibar.create(count, 0, { format: ext.padEnd(7, ' '), duplicates: 0, errors: 0 }, {
      format: colors.grey('{format} {bar} {percentage}% | {value}/{total} | Dup: {duplicates} | Err: {errors} | ETA: {eta_formatted}'),
     }));
  }

  // Initialize overall progress bar with ETA
  const totalFiles = files.length;
  const overallBar = multibar.create(totalFiles, 0, {
    duplicates: 0,
    errors: 0
  }, {
    format: colors.white('Overall {bar} {percentage}% | {value}/{total} | Dup: {duplicates} | Err: {errors} | ETA: {eta_formatted}'),
  });

  // Initialize semaphore for concurrency control
  const semaphore = new Semaphore(concurrency);
  const duplicateFileMutex = new Mutex();

  async function addUniqueFile(fileInfo: FileInfo) {
    existingFiles.set(fileInfo.hash, fileInfo);
    if (fileInfo.perceptualHash) {
      lsh.add(fileInfo.perceptualHash, fileInfo.hash);
      perceptualHashMap.set(fileInfo.perceptualHash, fileInfo.hash);
    }
  }

  async function replaceExistingFile(newFile: FileInfo, existingFile: FileInfo) {
    existingFiles.delete(existingFile.hash);
    if (existingFile.perceptualHash) {
      lsh.remove(existingFile.perceptualHash, existingFile.hash);
      perceptualHashMap.delete(existingFile.perceptualHash);
    }
    await addUniqueFile(newFile);
    duplicates.set(existingFile.path, newFile.path);
  }

  async function processFile(filePath: string) {
    const ext = extname(filePath).slice(1).toLowerCase();
    const formatBar = formatBars.get(ext);

    try {
      formatCounts.set(ext, (formatCounts.get(ext) || 0) + 1);

      const fileInfo = await getFileInfo(filePath, resolution);

      // Acquire the mutex for the critical section
      const release = await duplicateFileMutex.acquire();

      try {
        let isDuplicate = false;

        // Check for exact duplicates
        if (existingFiles.has(fileInfo.hash)) {
          const existingFile = existingFiles.get(fileInfo.hash)!;
          const bestFile = selectBestFile([existingFile, fileInfo]);
          if (bestFile.path === filePath) {
            await replaceExistingFile(fileInfo, existingFile);
          } else {
            duplicates.set(filePath, existingFile.path);
          }
          isDuplicate = true;
        } 
        // Check for perceptually similar images
        else if (fileInfo.perceptualHash && isImageFile(filePath)) {
          const candidates = await lsh.getCandidates(fileInfo.perceptualHash);
          for (const candidateHash of candidates) {
            const simpleHash = perceptualHashMap.get(candidateHash);
            if (simpleHash) {
              const existingFile = existingFiles.get(simpleHash);
              if (existingFile && existingFile.perceptualHash &&
                hammingDistance(fileInfo.perceptualHash, existingFile.perceptualHash, hammingThreshold)) {
                const bestFile = selectBestFile([existingFile, fileInfo]);
                if (bestFile.path === filePath) {
                  await replaceExistingFile(fileInfo, existingFile);
                } else {
                  duplicates.set(filePath, existingFile.path);
                }
                isDuplicate = true;
                break;
              }
            }
          }
        }

        if (!isDuplicate) {
          await addUniqueFile(fileInfo);
        }
      } finally {
        release();
      }

      formatBar?.increment({ duplicates: duplicates.size });
      processedCount++;
      overallBar.update(processedCount, { duplicates: duplicates.size, errors: errorCount });
    } catch (error) {
      errorCount++;
      formatBar?.increment({ errors: errorCount });
      processedCount++;
      overallBar.update(processedCount, { duplicates: duplicates.size, errors: errorCount });
    }
  }

  // Process all files
  for (const filePath of files) {
    const [_, release] = await semaphore.acquire();
    processFile(filePath).finally(() => {
      release();
    });
  }

  // Wait for all processes to complete
  await semaphore.waitForUnlock(concurrency);

  multibar.stop();

  console.log(chalk.green(`\nDeduplication completed:`));
  console.log(chalk.blue(`- ${uniqueFiles.size} unique files`));
  console.log(chalk.yellow(`- ${duplicates.size} duplicates`));
  console.log(chalk.red(`- ${errorCount} errors encountered`));

  return { uniqueFiles, duplicates, formatCounts, errorCount };
}

function selectBestFile(files: FileInfo[]): FileInfo {
  return files.reduce((best, current) => {
    // Prioritize files with geolocation data
    if (current.hasGeolocation && !best.hasGeolocation) return current;
    if (best.hasGeolocation && !current.hasGeolocation) return best;

    // Prioritize files with more metadata
    if (current.metadataCount > best.metadataCount) return current;
    if (best.metadataCount > current.metadataCount) return best;

    // For images, prioritize higher quality
    if (current.quality && best.quality) {
      if (current.quality > best.quality) return current;
      if (best.quality > current.quality) return best;
    }

    // If all else is equal, choose the larger file
    return current.size > best.size ? current : best;
  });
}

// Stage 3: File Transfer
async function transferFiles(
  uniqueFiles: Map<string, FileInfo>,
  duplicates: Map<string, string>,
  targetDir: string,
  duplicateDir: string | undefined,
  format: string,
  shouldMove: boolean
): Promise<void> {
  const totalFiles = uniqueFiles.size + duplicates.size;
  let processed = 0;

  const progressBar = new cliProgress.SingleBar({
    format: 'Transferring |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Files',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(totalFiles, 0);

  for (const [, fileInfo] of uniqueFiles) {
    const targetPath = generateTargetPath(format, targetDir, fileInfo.imageDate, basename(fileInfo.path));
    await transferFile(fileInfo.path, targetPath, shouldMove);
    processed++;
    progressBar.update(processed);
  }

  if (duplicateDir) {
    for (const [duplicatePath] of duplicates) {
      const targetPath = join(duplicateDir, basename(duplicatePath));
      await transferFile(duplicatePath, targetPath, shouldMove);
      processed++;
      progressBar.update(processed);
    }
  }

  progressBar.stop();
  console.log(chalk.green(`\nFile transfer completed: ${processed} files processed`));
}

// Helper functions
async function calculateFileHash(filePath: string, maxChunkSize = 1024 * 1024 * 2): Promise<string> {
  const hash = createHash('md5');
  const fileHandle = await open(filePath, 'r');

  try {
    const fileSize = (await fileHandle.stat()).size;

    if (fileSize > maxChunkSize) {
      // For large files, use partial hashing (first and last chunk)
      const chunkSize = maxChunkSize / 2;

      // Read first chunk
      const bufferStart = Buffer.alloc(chunkSize);
      await fileHandle.read(bufferStart, 0, chunkSize, 0);
      hash.update(bufferStart);

      // Read last chunk if the file is larger than the chunk size
      if (fileSize > chunkSize) {
        const bufferEnd = Buffer.alloc(chunkSize);
        await fileHandle.read(bufferEnd, 0, chunkSize, fileSize - chunkSize);
        hash.update(bufferEnd);
      }
    } else {
      // For small files, hash the entire file
      const fileBuffer = await fileHandle.readFile();
      hash.update(fileBuffer);
    }
  } finally {
    await fileHandle.close();
  }

  return hash.digest('hex');
}

function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();
  return SUPPORTED_EXTENSIONS.images.includes(ext) || SUPPORTED_EXTENSIONS.rawImages.includes(ext);
}

function hammingDistance(str1: string, str2: string, threshold: number): boolean {
  if (str1.length !== str2.length) {
    throw new Error('Strings must be of equal length');
  }
  const distance = str1.split('').reduce((count, char, i) => count + (char !== str2[i] ? 1 : 0), 0);
  return distance <= threshold;
}

async function getMetadata(path: string): Promise<any> {
  try {
    return await exiftool.read(path);
  } catch (error) {
    console.error(`Error getting metadata for ${path}: ${error}`);
    return {};
  }
}

async function processImageFile(filePath: string, resolution: number): Promise<{
  perceptualHash: string;
  quality: number;
}> {
  const image = sharp(filePath, { failOnError: false });

  try {
    const [perceptualHashData, metadata] = await Promise.all([
      image
        .jpeg()
        .resize(resolution, resolution, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      image.metadata()
    ]);

    // Calculate perceptual hash
    let hash = '';
    const pixelCount = resolution * resolution;
    const totalBrightness = perceptualHashData.data.reduce((sum: number, pixel: number) => sum + pixel, 0);
    const averageBrightness = totalBrightness / pixelCount;

    for (let i = 0; i < pixelCount; i++) {
      hash += perceptualHashData.data[i] < averageBrightness ? '0' : '1';
    }

    // Calculate image quality
    const quality = (metadata.width || 0) * (metadata.height || 0);

    return { perceptualHash: hash, quality };
  } finally {
    image.destroy();
  }
}

async function getFileInfo(filePath: string, resolution: number): Promise<FileInfo> {
  const [fileStat, hash, metadata, imageInfo] = await Promise.all([
    stat(filePath),
    calculateFileHash(filePath),
    getMetadata(filePath),
    isImageFile(filePath) 
      ? processImageFile(filePath, resolution).catch(error => {
          // console.warn(`Could not process image file ${filePath}: ${error}`);
          return { perceptualHash: undefined, quality: undefined };
        })
      : Promise.resolve({ perceptualHash: undefined, quality: undefined })
  ]);

  const fileInfo: FileInfo = {
    path: filePath,
    size: fileStat.size,
    hash,
    imageDate: metadata.DateTimeOriginal ? new Date(metadata.DateTimeOriginal) :
      metadata.CreateDate ? new Date(metadata.CreateDate) :
      new Date(),
    hasGeolocation: metadata.GPSLatitude && metadata.GPSLongitude,
    metadataCount: Object.keys(metadata).length,
    perceptualHash: imageInfo.perceptualHash,
    quality: imageInfo.quality
  };

  return fileInfo;
}

function generateTargetPath(format: string, targetDir: string, date: Date, fileName: string): string {
  const yearFull = date.getFullYear().toString();
  const yearShort = yearFull.slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  const formatParts = format.split('/');
  const processedParts = formatParts.map(part => {
    return part
      .replace('YYYY', yearFull)
      .replace('YY', yearShort)
      .replace('MM', month)
      .replace('DD', day);
  });

  const path = join(targetDir, ...processedParts);
  return join(path, fileName);
}

async function transferFile(source: string, target: string, shouldMove: boolean): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  
  if (shouldMove) {
    try {
      await rename(source, target);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
        // Cross-device move, fallback to copy-then-delete
        await copyFile(source, target);
        await unlink(source);
      } else {
        throw error; // Re-throw if it's a different error
      }
    }
  } else {
    await copyFile(source, target);
  }
}

async function main() {
  const program = new Command();

  program
    .name('media-organizer')
    .description('Organize photos and videos based on their creation date')
    .version('1.0.0')
    .requiredOption('-s, --source <paths...>', 'Source directories to process')
    .requiredOption('-t, --target <path>', 'Target directory for organized media')
    .option('-e, --error <path>', 'Directory for files that couldn\'t be processed')
    .option('-d, --duplicate <path>', 'Directory for duplicate files')
    .option('-w, --workers <number>', 'Number of concurrent workers', '5')
    .option('-m, --move', 'Move files instead of copying them', false)
    .option('-r, --resolution <number>', 'Resolution for perceptual hashing (default: 8)', '8')
    .option('-h, --hamming <number>', 'Hamming distance threshold (default: 10)', '10')
    .option('-f, --format <string>', 'Format for target directory (default: YYYY/MM)', 'YYYY/MM')
    .parse(process.argv);

  const options = program.opts() as ProgramOptions;

  // Create necessary directories
  await mkdir(options.target, { recursive: true });
  if (options.error) await mkdir(options.error, { recursive: true });
  if (options.duplicate) await mkdir(options.duplicate, { recursive: true });

  const resolution = parseInt(options.resolution, 10);
  if (resolution <= 0) {
    throw new Error('Resolution must be a positive number');
  }

  const hammingThreshold = parseInt(options.hamming, 10);
  if (hammingThreshold < 0) {
    throw new Error('Hamming threshold must be a non-negative number');
  }

  // Stage 1: File Discovery
  console.log(chalk.blue('Stage 1: Discovering files...'));
  const discoveredFiles = await discoverFiles(options.source);

  // Stage 2: Deduplication
  console.log(chalk.blue('\nStage 2: Deduplicating files...'));
  const lsh = new LSH();
  const existingFiles = new Map<string, FileInfo>(); // In a real scenario, you might want to populate this with files from the target directory
  const { uniqueFiles, duplicates } = await deduplicateFiles(discoveredFiles, resolution, hammingThreshold, existingFiles, lsh);

  // Stage 3: File Transfer
  console.log(chalk.blue('\nStage 3: Transferring files...'));
  await transferFiles(uniqueFiles, duplicates, options.target, options.duplicate, options.format, options.move);

  console.log(chalk.green('\nMedia organization completed'));
  console.log(chalk.cyan(`Total files discovered: ${discoveredFiles.length}`));
  console.log(chalk.cyan(`Unique files: ${uniqueFiles.size}`));
  console.log(chalk.yellow(`Exact duplicates: ${duplicates.size}`));

  await exiftool.end();
}

main().catch((error) => {
  console.error(chalk.red('An unexpected error occurred:'), error);
  process.exit(1);
});