import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

import Arborist from "@npmcli/arborist";
import packlist from "npm-packlist";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

export type PreparePublishOptions = {
  cwd?: string;
  dryRun?: boolean;
  publint?: boolean;
};

export type PreparePublishResult = {
  cwd: string;
  publishDirectory: string;
  packageJSON: PublishPackageJSON;
  packedFiles: string[];
  publintMessages: string[];
};

export type PackedFileEntry =
  | {
      kind: "header";
      text: string;
    }
  | {
      kind: "file";
      file: string;
      size: number;
      sizeText: string;
    };

export type PackedFileItem = {
  file: string;
  size: number;
  sizeText: string;
};

type PackageJSON = {
  name: string;
  version: string;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: {
    access?: string;
    directory?: string;
    provenance?: boolean;
    registry?: string;
    tag?: string;
  };
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  private?: boolean;
  [key: string]: unknown;
};

type PublishPackageJSON = PackageJSON & {
  files: string[];
  exports?: Record<string, unknown>;
  types?: string;
};

export async function preparePublish(
  options: PreparePublishOptions = {},
): Promise<PreparePublishResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const packageJSONPath = resolve(cwd, "package.json");
  const packageJSON = await readPackageJSON(packageJSONPath);
  const stageDirectory = resolve(cwd, ".prepare-publish");
  const publishSubdirectory = packageJSON.publishConfig?.directory
    ?.replaceAll("\\", "/")
    .replace(/^\.?\//, "");
  const arborist = new Arborist({ path: cwd });

  await cleanupGeneratedPublishArtifacts(stageDirectory);

  const packedFiles = await packlist(await arborist.loadActual());
  await assertPackedFilesExist(cwd, packedFiles);
  const publishPackageJSON = await createPublishPackageJSON(
    packageJSON,
    publishSubdirectory,
    packedFiles,
  );

  if (!options.dryRun) {
    await writePublishFiles(cwd, stageDirectory, publishPackageJSON, packedFiles);
  }

  const publintMessages = options.publint
    ? await runPublint(cwd, stageDirectory, publishPackageJSON, packedFiles, !!options.dryRun)
    : [];

  return {
    cwd,
    publishDirectory: stageDirectory,
    packageJSON: publishPackageJSON,
    packedFiles,
    publintMessages,
  };
}

export async function* iteratePackedFiles(
  cwd: string,
  files: string[],
): AsyncGenerator<PackedFileEntry, void, void> {
  const entries = await resolvePackedFileItems(cwd, files);
  yield { kind: "header", text: "Tarball Contents" };

  for (const entry of entries) {
    yield {
      kind: "file",
      file: entry.file,
      size: entry.size,
      sizeText: entry.sizeText,
    };
  }
}

export async function resolvePackedFileItems(
  cwd: string,
  files: string[],
): Promise<PackedFileItem[]> {
  const entries = await Promise.all(
    [...files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => ({
        file,
        size: (await stat(resolve(cwd, file))).size,
      })),
  );

  const sizeWidth = Math.max(...entries.map((entry) => formatSize(entry.size).length), 0);
  return entries.map((entry) => ({
    ...entry,
    sizeText: formatSize(entry.size).padStart(sizeWidth),
  }));
}

function formatSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes}B`;
  }

  if (bytes < 1_000_000) {
    return `${(bytes / 1000).toFixed(bytes >= 10_000 ? 0 : 1)}kB`;
  }

  return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)}MB`;
}

async function readPackageJSON(path: string): Promise<PackageJSON> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJSON;
}

async function createPublishPackageJSON(
  packageJSON: PackageJSON,
  publishSubdirectory: string | undefined,
  packedFiles: string[],
): Promise<PublishPackageJSON> {
  const {
    scripts: _scripts,
    devDependencies: _devDependencies,
    publishConfig,
    bin,
    ...rest
  } = packageJSON;
  const publishExports = packageJSON.exports
    ? await rewriteExports(packageJSON.exports, publishSubdirectory, packedFiles)
    : undefined;

  return stripUndefined({
    ...rest,
    private: undefined,
    bin: rewriteBin(bin, publishSubdirectory, packedFiles),
    exports: publishExports,
    types: getTopLevelTypesPath(publishExports),
    files: resolvePublishFiles(packageJSON),
    publishConfig: stripUndefined({
      access: publishConfig?.access,
      provenance: publishConfig?.provenance,
      registry: publishConfig?.registry,
      tag: publishConfig?.tag,
    }),
  }) as PublishPackageJSON;
}

function resolvePublishFiles(packageJSON: PackageJSON): string[] | undefined {
  if (!Array.isArray(packageJSON.files) || packageJSON.files.length === 0) {
    return packageJSON.files;
  }

  return [...new Set(packageJSON.files)].sort();
}

function rewriteBin(
  bin: unknown,
  publishSubdirectory: string | undefined,
  packedFiles: string[],
): unknown {
  if (typeof bin === "string") {
    return rewritePublishedPath(bin, publishSubdirectory, packedFiles);
  }

  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    return Object.fromEntries(
      Object.entries(bin).map(([name, path]) => [
        name,
        typeof path === "string"
          ? rewritePublishedPath(path, publishSubdirectory, packedFiles)
          : path,
      ]),
    );
  }

  return bin;
}

async function rewriteExports(
  exportsField: Record<string, unknown>,
  publishSubdirectory: string | undefined,
  packedFiles: string[],
): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(exportsField).map(async ([subpath, value]) => [
        subpath,
        await rewriteExportValue(value, publishSubdirectory, packedFiles, subpath === "."),
      ]),
    ),
  );
}

async function rewriteExportValue(
  value: unknown,
  publishSubdirectory: string | undefined,
  packedFiles: string[],
  allowTypeWrapper = false,
  keyHint?: string,
): Promise<unknown> {
  if (typeof value === "string") {
    if (value === "./package.json") {
      return value;
    }

    const exportEntry = await resolveBuiltExport(value, publishSubdirectory, packedFiles, keyHint);
    if (allowTypeWrapper && typeof exportEntry === "object" && exportEntry !== null) {
      return exportEntry;
    }
    if (typeof exportEntry === "string") {
      return exportEntry;
    }
    if (
      keyHint === "types" &&
      isExportRecord(exportEntry) &&
      typeof exportEntry.types === "string"
    ) {
      return exportEntry.types;
    }
    if ((keyHint === "require" || keyHint === "node") && isExportRecord(exportEntry)) {
      return exportEntry.require ?? exportEntry.default;
    }
    if (
      (keyHint === "import" || keyHint === "default" || keyHint === "browser") &&
      isExportRecord(exportEntry)
    ) {
      return exportEntry.default;
    }
    return exportEntry;
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry) =>
        rewriteExportValue(entry, publishSubdirectory, packedFiles, false, keyHint),
      ),
    );
  }

  if (value && typeof value === "object") {
    return stripUndefined(
      Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [
            key,
            await rewriteExportValue(entry, publishSubdirectory, packedFiles, false, key),
          ]),
        ),
      ),
    );
  }

  return value;
}

async function resolveBuiltExport(
  sourcePath: string,
  publishSubdirectory: string | undefined,
  packedFiles: string[],
  keyHint?: string,
): Promise<string | Record<string, string>> {
  const sourceExt = extname(sourcePath);
  const pathCandidates = getPublishedPathCandidates(sourcePath, publishSubdirectory);
  const baseCandidates = pathCandidates.map((path) =>
    sourceExt ? path.slice(0, -sourceExt.length) : path,
  );

  if (keyHint === "types") {
    const typesPath = pickExistingFile(
      packedFiles,
      baseCandidates.flatMap((basePath) => [
        `${basePath}.d.mts`,
        `${basePath}.d.ts`,
        `${basePath}.d.cts`,
      ]),
    );
    if (!typesPath) {
      throw new Error(`Could not find a built type file for export '${sourcePath}'.`);
    }
    return `./${typesPath}`;
  }

  const exactMatch = sourceExt ? pickExistingFile(packedFiles, pathCandidates) : undefined;
  if (exactMatch && !isJavaScriptLikeExtension(sourceExt)) {
    return `./${exactMatch}`;
  }

  const importPath = pickExistingFile(
    packedFiles,
    baseCandidates.flatMap((basePath) => [`${basePath}.mjs`, `${basePath}.js`]),
  );
  const requirePath = pickExistingFile(
    packedFiles,
    baseCandidates.flatMap((basePath) => [`${basePath}.cjs`, `${basePath}.js`]),
  );
  const typesPath = pickExistingFile(
    packedFiles,
    baseCandidates.flatMap((basePath) => [
      `${basePath}.d.mts`,
      `${basePath}.d.ts`,
      `${basePath}.d.cts`,
    ]),
  );

  if (!importPath && !requirePath && !exactMatch) {
    throw new Error(`Could not find a built runtime file for export '${sourcePath}'.`);
  }

  const result = stripUndefined({
    types: typesPath ? `./${typesPath}` : undefined,
    require: requirePath ? `./${requirePath}` : undefined,
    default: importPath ? `./${importPath}` : exactMatch ? `./${exactMatch}` : undefined,
  });

  return Object.keys(result).length === 1 && result.default ? result.default : result;
}

async function writePublishFiles(
  cwd: string,
  stageDirectory: string,
  packageJSON: PublishPackageJSON,
  packedFiles: string[],
) {
  await mkdir(stageDirectory, { recursive: true });
  await writeFile(
    join(stageDirectory, "package.json"),
    `${JSON.stringify(packageJSON, null, 2)}\n`,
  );

  for (const relativePath of packedFiles) {
    if (relativePath === "package.json") {
      continue;
    }
    const targetPath = join(stageDirectory, relativePath);
    await copyIfExists(resolve(cwd, relativePath), targetPath);
  }
}

async function runPublint(
  cwd: string,
  stageDirectory: string,
  packageJSON: PublishPackageJSON,
  packedFiles: string[],
  dryRun: boolean,
): Promise<string[]> {
  const pkgDir = dryRun
    ? await createTemporaryPublishDirectory(cwd, packageJSON, packedFiles)
    : stageDirectory;

  try {
    const { messages, pkg } = await publint({
      pkgDir,
      level: "suggestion",
      pack: false,
    });

    return messages
      .map((message) => formatMessage(message, pkg))
      .filter((message): message is string => Boolean(message));
  } finally {
    if (dryRun) {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }
}

async function createTemporaryPublishDirectory(
  cwd: string,
  packageJSON: PublishPackageJSON,
  packedFiles: string[],
) {
  const tempDir = await mkdtemp(join(tmpdir(), "prepare-publish-"));
  await writePublishFiles(cwd, tempDir, packageJSON, packedFiles);
  return tempDir;
}

async function copyIfExists(from: string, to: string) {
  try {
    await stat(from);
  } catch {
    return;
  }

  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { force: true });
}

async function assertPathExists(path: string, message: string) {
  try {
    await stat(path);
  } catch {
    throw new Error(message);
  }
}

async function cleanupGeneratedPublishArtifacts(stageDirectory: string) {
  await rm(stageDirectory, { recursive: true, force: true });
}

function pickExistingFile(files: string[], candidates: string[]): string | undefined {
  return candidates.find((candidate) => files.includes(candidate));
}

function getTopLevelTypesPath(
  exportsField: Record<string, unknown> | undefined,
): string | undefined {
  const rootExport = exportsField?.["."];
  if (!isExportRecord(rootExport)) {
    return undefined;
  }
  return typeof rootExport.types === "string" ? rootExport.types : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined) {
        return false;
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return Object.keys(entry).length > 0;
      }
      return true;
    }),
  ) as Partial<T>;
}

function isJavaScriptLikeExtension(extension: string): boolean {
  return [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"].includes(extension);
}

function isExportRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewritePublishedPath(
  sourcePath: string,
  publishSubdirectory: string | undefined,
  packedFiles: string[],
): string {
  const normalizedPath = normalizeRelativePath(sourcePath);
  const sourceExt = extname(normalizedPath);
  const pathCandidates = getPublishedPathCandidates(sourcePath, publishSubdirectory);
  const isJavaScriptLikePath = isJavaScriptLikeExtension(sourceExt);

  if (isJavaScriptLikePath) {
    const baseCandidates = pathCandidates.map((path) =>
      sourceExt ? path.slice(0, -sourceExt.length) : path,
    );
    const runtimeMatch = pickExistingFile(
      packedFiles,
      baseCandidates.flatMap((basePath) => [`${basePath}.mjs`, `${basePath}.js`, `${basePath}.cjs`]),
    );
    if (runtimeMatch) {
      return `./${runtimeMatch}`;
    }
  }

  const directMatch = pickExistingFile(packedFiles, pathCandidates);
  if (directMatch) {
    return `./${directMatch}`;
  }

  if (packedFiles.includes(normalizedPath)) {
    return `./${normalizedPath}`;
  }

  return sourcePath;
}

async function assertPackedFilesExist(cwd: string, packedFiles: string[]) {
  await Promise.all(
    packedFiles.map(async (file) => {
      await assertPathExists(
        resolve(cwd, file),
        `Packed file '${file}' was not found in the source directory.`,
      );
    }),
  );
}

function withPublishSubdirectory(
  paths: string[],
  publishSubdirectory: string | undefined,
): string[] {
  return paths.map((path) =>
    publishSubdirectory ? join(publishSubdirectory, path).split("\\").join("/") : path,
  );
}

function getPublishedPathCandidates(
  sourcePath: string,
  publishSubdirectory: string | undefined,
): string[] {
  const normalizedPath = normalizeRelativePath(sourcePath);
  const sourceRootRelativePath = stripFirstPathSegment(normalizedPath);
  const candidates = [
    normalizedPath,
    ...withPublishSubdirectory([normalizedPath], publishSubdirectory),
  ];

  if (sourceRootRelativePath !== normalizedPath) {
    candidates.push(...withPublishSubdirectory([sourceRootRelativePath], publishSubdirectory));
  }

  return [...new Set(candidates)];
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stripFirstPathSegment(path: string): string {
  const slashIndex = path.indexOf("/");
  return slashIndex === -1 ? path : path.slice(slashIndex + 1);
}
