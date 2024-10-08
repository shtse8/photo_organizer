#!/usr/bin/env node
import "reflect-metadata";

import { Command } from "commander";
import chalk from "chalk";
import {
  type ProgramOptions,
  type DeduplicationResult,
  type GatherFileInfoResult,
} from "./src/types";
import { MediaOrganizer } from "./MediaOrganizer";
import os from "os";
import { Context } from "./src/contexts/Context";

function exitHandler() {
  console.log(chalk.red("\nSotiMediaOrganizer was interrupted"));
  process.stdout.write("\u001B[?25h"); // Show cursor
  process.exit();
}

async function main() {
  process.on("SIGINT", exitHandler); // Handle Ctrl+C
  process.on("SIGTERM", exitHandler); // Handle kill commands

  const program = new Command();

  program
    .name("media-organizer")
    .description("Organize photos and videos based on their metadata")
    .version("1.0.0")
    .argument("<source>", "Source directories to process")
    .argument("<destination>", "Destination directory for organized media")
    .option(
      "-e, --error <path>",
      "Directory for files that couldn't be processed",
    )
    .option("-d, --duplicate <path>", "Directory for duplicate files")
    .option(
      "--debug <path>",
      "Debug directory for storing all files in duplicate sets",
    )
    .option(
      "-c, --concurrency <number>",
      "Number of workers to use (default: CPU cores - 1)",
      parseInt,
      Math.max(1, Math.floor(os.cpus().length - 1)),
    )
    .option("-m, --move", "Move files instead of copying them", false)
    .option(
      "-r, --resolution <number>",
      "Resolution for perceptual hashing",
      parseInt,
      64,
    )

    .option(
      "--min-frames <number>",
      "Minimum number of frames to extract from videos",
      parseInt,
      5,
    )
    .option(
      "--max-scene-frames <number>",
      "Maximum number of frames to extract from scene changes",
      parseInt,
      100,
    )
    .option(
      "--target-fps <number>",
      "Target frames per second for video extraction",
      parseFloat,
      2,
    )

    .option(
      "-w, --window-size <number>",
      "Window size for frame clustering",
      parseInt,
      5,
    )
    .option(
      "-p, --step-size <number>",
      "Step size for frame clustering",
      parseInt,
      1,
    )
    .option(
      "-F, --format <string>",
      "Format for destination directory",
      "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}",
    )
    .option(
      "--scene-change-threshold <number>",
      "Threshold for scene change detection",
      parseFloat,
      0.05,
    )
    .option(
      "--image-similarity-threshold <number>",
      "Threshold for image similarity (default: 0.99)",
      parseFloat,
      0.99,
    )
    .option(
      "--image-video-similarity-threshold <number>",
      "Threshold for image-video similarity. For image-video, we use a lower threshold because the frames are not always the same (default: 0.98)",
      parseFloat,
      0.93,
    )
    .option(
      "--video-similarity-threshold <number>",
      "Threshold for video similarity. For video similarity, we use an even lower threshold because the frames are not always the same (default: 0.97)",
      parseFloat,
      0.93,
    )
    .option(
      "--max-chunk-size <number>",
      "Maximum chunk size for file processing (default: 2MB)",
      parseInt,
      2 * 1024 * 1024,
    )
    .addHelpText(
      "after",
      `
  Format string placeholders:
    Image date (I.), File date (F.), Mixed date (D.):
      {*.YYYY} - Year (4 digits)       {*.YY} - Year (2 digits)
      {*.MMMM} - Month (full name)     {*.MMM} - Month (short name)
      {*.MM} - Month (2 digits)        {*.M} - Month (1-2 digits)
      {*.DD} - Day (2 digits)          {*.D} - Day (1-2 digits)
      {*.DDDD} - Day (full name)       {*.DDD} - Day (short name)
      {*.HH} - Hour, 24h (2 digits)    {*.H} - Hour, 24h (1-2 digits)
      {*.hh} - Hour, 12h (2 digits)    {*.h} - Hour, 12h (1-2 digits)
      {*.mm} - Minute (2 digits)       {*.m} - Minute (1-2 digits)
      {*.ss} - Second (2 digits)       {*.s} - Second (1-2 digits)
      {*.a} - am/pm                    {*.A} - AM/PM
      {*.WW} - Week of year (2 digits)
  
    Filename:
      {NAME} - Original filename (without extension)
      {NAME.L} - Lowercase filename
      {NAME.U} - Uppercase filename
      {EXT} - File extension (without dot)
      {RND} - Random 8-character hexadecimal string (for unique filenames)
  
    Other:
      {GEO} - Geolocation              {CAM} - Camera model
      {TYPE} - 'Image' or 'Other'
      {HAS.GEO} - 'GeoTagged' or 'NoGeo'
      {HAS.CAM} - 'WithCamera' or 'NoCamera'
      {HAS.DATE} - 'Dated' or 'NoDate'
  
  Example format strings:
    "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
    "{HAS.GEO}/{HAS.CAM}/{D.YYYY}/{D.MM}/{NAME}_{D.HH}{D.mm}.{EXT}"
    "{TYPE}/{D.YYYY}/{D.WW}/{CAM}/{D.YYYY}{D.MM}{D.DD}_{NAME.L}.{EXT}"
    "{HAS.DATE}/{D.YYYY}/{D.MMMM}/{D.D}-{D.DDDD}/{D.h}{D.mm}{D.a}_{NAME}.{EXT}"
    "{TYPE}/{CAM}/{D.YYYY}/{D.MM}/{D.DD}_{D.HH}{D.mm}_{NAME.U}.{EXT}"
      `,
    )
    .parse(process.argv);

  const [source, destination] = program.args as [string, string];
  const options = program.opts<ProgramOptions>();

  await Context.ensureInitialized(options);

  const organizer = await Context.injector.getAsync(MediaOrganizer)!;
  try {
    // Stage 1: File Discovery
    console.log(chalk.blue("Stage 1: Discovering files..."));
    const discoveredFiles = await organizer.discoverFiles(
      [source],
      options.concurrency,
    );

    // Stage 2: Gathering Information
    console.log(chalk.blue("\nStage 2: Gathering file information..."));
    const gatherFileInfoResult = await organizer.gatherFileInfo(
      discoveredFiles,
      options.concurrency,
    );

    // Stage 3: Deduplication
    console.log(chalk.blue("\nStage 3: Deduplicating files..."));
    const deduplicationResult = await organizer.deduplicateFiles(
      gatherFileInfoResult.validFiles,
    );

    // Stage 4: File Transfer
    console.log(chalk.blue("\nStage 4: Transferring files..."));
    await organizer.transferFiles(
      gatherFileInfoResult,
      deduplicationResult,
      destination,
      options.duplicate,
      options.error,
      options.debug,
      options.format,
      options.move,
    );

    console.log(chalk.green("\nMedia organization completed"));
    printResults(
      gatherFileInfoResult,
      deduplicationResult,
      [...discoveredFiles.values()].reduce(
        (sum, files) => sum + files.length,
        0,
      ),
    );
  } catch (error) {
    console.error(chalk.red("An unexpected error occurred:"), error);
  }
}

function printResults(
  gatherFileInfoResult: GatherFileInfoResult,
  deduplicationResult: DeduplicationResult,
  totalFiles: number,
) {
  console.log(chalk.cyan(`Total files discovered: ${totalFiles}`));
  console.log(
    chalk.cyan(`Unique files: ${deduplicationResult.uniqueFiles.size}`),
  );
  console.log(
    chalk.yellow(`Duplicate sets: ${deduplicationResult.duplicateSets.length}`),
  );
  console.log(
    chalk.yellow(
      `Total duplicates: ${Array.from(
        deduplicationResult.duplicateSets.values(),
      ).reduce((sum, set) => sum + set.duplicates.size, 0)}`,
    ),
  );
  console.log(
    chalk.red(`Files with errors: ${gatherFileInfoResult.errorFiles.length}`),
  );
}

try {
  await main();
} catch (error) {
  console.error(chalk.red("An unexpected error occurred:"), error);
  process.exit(1);
}
