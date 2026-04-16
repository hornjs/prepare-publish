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
    /**
     * Directory mappings for source-to-dist path translation.
     * Keys are source prefixes, values are target prefixes.
     * Example: { "src": "dist" } maps "src/lib/xxx.d.ts" -> "dist/lib/xxx.d.ts"
     * Multiple mappings are supported: { "src/core": "dist/core", "src/types": "dist/types" }
     */
    directories?: Record<string, string>;
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
  const directories = packageJSON.publishConfig?.directories;
  const arborist = new Arborist({ path: cwd });

  await cleanupGeneratedPublishArtifacts(stageDirectory);

  const packedFiles = await packlist(await arborist.loadActual());
  await assertPackedFilesExist(cwd, packedFiles);
  const publishPackageJSON = await createPublishPackageJSON(
    packageJSON,
    packedFiles,
  );

  if (!options.dryRun) {
    await writePublishFiles(cwd, stageDirectory, publishPackageJSON, packedFiles);
  }

  const publintMessages = options.publint
    ? await runPublint(cwd, stageDirectory, publishPackageJSON, packedFiles, !!options.dryRun, directories)
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
  packedFiles: string[],
): Promise<PublishPackageJSON> {
  const {
    scripts: _scripts,
    devDependencies: _devDependencies,
    publishConfig,
    bin,
    ...rest
  } = packageJSON;
  const directories = publishConfig?.directories;
  const publishExports = packageJSON.exports
    ? await rewriteExports(packageJSON.exports, packedFiles, directories)
    : undefined;

  return stripUndefined({
    ...rest,
    private: undefined,
    bin: rewriteBin(bin, packedFiles, directories),
    exports: publishExports,
    types: getTopLevelTypesPath(publishExports),
    files: resolvePublishFiles(packageJSON, packedFiles, directories),
    publishConfig: stripUndefined({
      access: publishConfig?.access,
      provenance: publishConfig?.provenance,
      registry: publishConfig?.registry,
      tag: publishConfig?.tag,
    }),
  }) as PublishPackageJSON;
}

function resolvePublishFiles(
  packageJSON: PackageJSON,
  packedFiles: string[],
  directories: Record<string, string> | undefined,
): string[] | undefined {
  if (!Array.isArray(packageJSON.files) || packageJSON.files.length === 0) {
    return packageJSON.files;
  }

  // 重写 files 中的路径：如果文件被打包工具复制到发布目录，使用 packedFiles 中的实际路径
  const rewrittenFiles = packageJSON.files.map((filePattern) => {
    // 检查是否是具体的 .d.ts 文件路径（不是 glob 模式）
    if (isDtsFile(filePattern) && !filePattern.includes("*")) {
      const normalizedPath = normalizeRelativePath(filePattern);

      // 1. 如果文件直接在 packedFiles 中，检查是否有映射后的路径
      if (packedFiles.includes(normalizedPath)) {
        // 优先使用 directories 映射
        if (directories) {
          const mappedPath = applyDirectoryMap(normalizedPath, directories);
          if (mappedPath !== normalizedPath && packedFiles.includes(mappedPath)) {
            return mappedPath;
          }
        }
        return normalizedPath;
      }
    }

    return filePattern;
  });

  return [...new Set(rewrittenFiles)].sort();
}

function rewriteBin(
  bin: unknown,
  packedFiles: string[],
  directories: Record<string, string> | undefined,
): unknown {
  if (typeof bin === "string") {
    return rewritePublishedPath(bin, packedFiles, directories);
  }

  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    return Object.fromEntries(
      Object.entries(bin).map(([name, path]) => [
        name,
        typeof path === "string"
          ? rewritePublishedPath(path, packedFiles, directories)
          : path,
      ]),
    );
  }

  return bin;
}

async function rewriteExports(
  exportsField: Record<string, unknown>,
  packedFiles: string[],
  directories: Record<string, string> | undefined,
): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(exportsField).map(async ([subpath, value]) => [
        subpath,
        await rewriteExportValue(value, packedFiles, subpath === ".", directories),
      ]),
    ),
  );
}

async function rewriteExportValue(
  value: unknown,
  packedFiles: string[],
  allowTypeWrapper = false,
  directories: Record<string, string> | undefined,
  keyHint?: string,
): Promise<unknown> {
  if (typeof value === "string") {
    if (value === "./package.json") {
      return value;
    }

    const exportEntry = await resolveBuiltExport(value, packedFiles, directories, keyHint);
    // 如果是 .d.ts 文件返回的 { types: ... } 对象，直接返回
    if (isDtsOnlyExport(exportEntry)) {
      return exportEntry;
    }
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
        rewriteExportValue(entry, packedFiles, false, directories, keyHint),
      ),
    );
  }

  if (value && typeof value === "object") {
    return stripUndefined(
      Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [
            key,
            await rewriteExportValue(entry, packedFiles, false, directories, key),
          ]),
        ),
      ),
    );
  }

  return value;
}

async function resolveBuiltExport(
  sourcePath: string,
  packedFiles: string[],
  directories: Record<string, string> | undefined,
  keyHint?: string,
): Promise<string | Record<string, string>> {
  // 处理 .d.ts 文件：直接指向类型定义文件的导出
  // 只根据 packedFiles 中实际存在的文件来处理，不主动构建路径
  if (isDtsFile(sourcePath)) {
    const normalizedPath = normalizeRelativePath(sourcePath);

    // 1. 首先检查源文件路径是否直接在 packedFiles 中
    if (packedFiles.includes(normalizedPath)) {
      // 检查是否有 directories 映射，优先使用映射后的路径
      if (directories) {
        const mappedPath = applyDirectoryMap(normalizedPath, directories);
        if (mappedPath !== normalizedPath && packedFiles.includes(mappedPath)) {
          return { types: `./${mappedPath}` };
        }
      }
      return { types: `./${normalizedPath}` };
    }

    // 2. 如果源文件不在 packedFiles 中，尝试查找映射后的路径
    if (directories) {
      const mappedPath = applyDirectoryMap(normalizedPath, directories);
      if (mappedPath !== normalizedPath && packedFiles.includes(mappedPath)) {
        return { types: `./${mappedPath}` };
      }
    }

    throw new Error(`Could not find a type file for export '${sourcePath}'.`);
  }

  const sourceExt = extname(sourcePath);
  const pathCandidates = getPublishedPathCandidates(sourcePath, directories);
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
  directories?: Record<string, string> | undefined,
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
    // 如果指定了 directories，应用映射来调整目标路径
    // 这用于 dry-run 模式的临时目录创建，模拟发布后的结构
    const targetRelativePath = directories
      ? applyDirectoryMap(relativePath, directories)
      : relativePath;

    // 如果映射后的目标文件已经在 packedFiles 中，跳过源文件的复制
    // 例如：src/bin.ts 映射到 dist/bin.mjs，如果 dist/bin.mjs 已在 packedFiles 中，
    // 则不需要复制 src/bin.ts
    if (targetRelativePath !== relativePath && packedFiles.includes(targetRelativePath)) {
      continue;
    }

    const targetPath = join(stageDirectory, targetRelativePath);
    await copyIfExists(resolve(cwd, relativePath), targetPath);
  }
}

async function runPublint(
  cwd: string,
  stageDirectory: string,
  packageJSON: PublishPackageJSON,
  packedFiles: string[],
  dryRun: boolean,
  directories: Record<string, string> | undefined,
): Promise<string[]> {
  const pkgDir = dryRun
    ? await createTemporaryPublishDirectory(cwd, packageJSON, packedFiles, directories)
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
  directories: Record<string, string> | undefined,
) {
  const tempDir = await mkdtemp(join(tmpdir(), "prepare-publish-"));
  // 临时目录需要模拟发布后的结构（应用 directories 映射）
  await writePublishFiles(cwd, tempDir, packageJSON, packedFiles, directories);
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

function isDtsFile(path: string): boolean {
  return path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
}

/**
 * Apply directory mapping to translate source paths to target paths.
 * Returns the mapped path if a matching prefix is found, otherwise returns the original path.
 */
function applyDirectoryMap(
  sourcePath: string,
  directoryMap: Record<string, string> | undefined,
): string {
  if (!directoryMap) return sourcePath;

  const normalizedPath = normalizeRelativePath(sourcePath);

  // Sort keys by length (longest first) to ensure most specific match
  const sortedKeys = Object.keys(directoryMap).sort((a, b) => b.length - a.length);

  for (const sourcePrefix of sortedKeys) {
    const targetPrefix = directoryMap[sourcePrefix];
    const normalizedSourcePrefix = normalizeRelativePath(sourcePrefix);

    if (
      normalizedPath === normalizedSourcePrefix ||
      normalizedPath.startsWith(`${normalizedSourcePrefix}/`)
    ) {
      const relativePart = normalizedPath.slice(normalizedSourcePrefix.length);
      const normalizedTargetPrefix = normalizeRelativePath(targetPrefix);
      return `${normalizedTargetPrefix}${relativePart}`;
    }
  }

  return sourcePath;
}

function isExportRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDtsOnlyExport(value: unknown): value is { types: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "types" in value &&
    typeof (value as Record<string, string>).types === "string"
  );
}

function rewritePublishedPath(
  sourcePath: string,
  packedFiles: string[],
  directories: Record<string, string> | undefined,
): string {
  const normalizedPath = normalizeRelativePath(sourcePath);
  const sourceExt = extname(normalizedPath);
  const pathCandidates = getPublishedPathCandidates(sourcePath, directories);
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



function getPublishedPathCandidates(
  sourcePath: string,
  directories: Record<string, string> | undefined,
): string[] {
  const normalizedPath = normalizeRelativePath(sourcePath);
  const candidates = [normalizedPath];

  // 如果存在 directories 映射，添加映射后的路径作为候选
  if (directories) {
    const mappedPath = applyDirectoryMap(normalizedPath, directories);
    if (mappedPath !== normalizedPath) {
      candidates.push(mappedPath);
    }
  }

  return [...new Set(candidates)];
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
