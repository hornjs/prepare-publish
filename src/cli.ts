#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";

import { iteratePackedFiles, preparePublish, resolvePackedFileItems } from "./index.js";

type CLIOptions = {
  cwd?: string;
  dryRun: boolean;
  printTree: boolean;
  disableLint: boolean;
  json: boolean;
};

async function main() {
  const options = parseArgs(process.argv);
  const result = await preparePublish({
    cwd: options.cwd,
    dryRun: options.dryRun,
    publint: !options.disableLint,
  });

  if (options.json) {
    const packedFileItems = await resolvePackedFileItems(result.cwd, result.packedFiles);
    console.log(
      JSON.stringify(
        {
          publishDirectory: ".prepare-publish",
          packageJSON: result.packageJSON,
          packedFiles: packedFileItems,
          publint: options.disableLint
            ? { enabled: false, ok: null, messages: [] }
            : {
                enabled: true,
                ok: result.publintMessages.length === 0,
                messages: result.publintMessages,
              },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.printTree || options.dryRun) {
    for await (const entry of iteratePackedFiles(result.cwd, result.packedFiles)) {
      if (entry.kind === "header") {
        process.stdout.write(`${pc.bold(pc.cyan(entry.text))}\n`);
        continue;
      }
      process.stdout.write(`${pc.yellow(entry.sizeText)}  ${pc.green(entry.file)}\n`);
    }
  }

  console.log(pc.bold(pc.cyan("Generated package.json")));
  console.log(JSON.stringify(result.packageJSON, null, 2));

  if (!options.disableLint) {
    if (result.publintMessages.length) {
      for (const message of result.publintMessages) {
        console.error(message);
      }
      process.exitCode = 1;
    } else {
      console.log(pc.green("publint: all good"));
    }
  }

  if (!options.dryRun) {
    console.log(pc.bold(pc.cyan("Tips:")));
    console.log(`📦 Prepared publish directory: .prepare-publish`);
    console.log(`🚀 cd .prepare-publish && npm publish`);
    console.log(`📝 Add .prepare-publish to .gitignore or .npmignore.`);
  }
}

function parseArgs(argv: string[]): CLIOptions {
  const program = createProgram();

  program.parse(argv);

  const options = program.opts<{
    cwd?: string;
    dryRun?: boolean;
    json?: boolean;
    printTree?: boolean;
    disableLint?: boolean;
  }>();

  return {
    cwd: options.cwd,
    dryRun: options.dryRun ?? false,
    json: options.json ?? false,
    printTree: options.printTree ?? false,
    disableLint: options.disableLint ?? false,
  };
}

function createProgram() {
  const program = new Command();
  const heading = (text: string) => pc.bold(pc.cyan(text));
  const commandText = (text: string) => pc.green(text);

  return program
    .name("prepare-publish")
    .description("Prepare a publish-ready package directory")
    .usage("[options]")
    .summary("Prepare a publish-ready package directory")
    .option("--cwd <dir>", "Package directory to prepare")
    .option("--dry-run", "Print the generated package.json without writing files")
    .option("--json", "Print machine-readable JSON output")
    .option("--print-tree", "Print the publish file list with sizes")
    .option("--disable-lint", "Skip publint checks")
    .helpOption("-h, --help", "Show this message")
    .addHelpText(
      "beforeAll",
      [
        heading("prepare-publish"),
        "Prepare a publish-ready package directory from source-oriented package metadata.",
        "",
      ].join("\n"),
    )
    .addHelpText(
      "afterAll",
      [
        "",
        heading("Examples"),
        `  ${commandText("prepare-publish")}`,
        `  ${commandText("prepare-publish --dry-run --print-tree")}`,
        `  ${commandText("prepare-publish --json")}`,
        `  ${commandText("prepare-publish --cwd packages/foo")}`,
        "",
        heading("Output"),
        "  Writes a staged package into .prepare-publish and optionally runs publint.",
      ].join("\n"),
    );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
