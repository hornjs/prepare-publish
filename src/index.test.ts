import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { preparePublish } from "./index.js";

const tempDirs: string[] = [];

describe("preparePublish", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a publish-ready package.json and copies packed root files", async () => {
    const cwd = await createFixture();

    const result = await preparePublish({ cwd });
    const publishPackageJSON = JSON.parse(
      await readFile(join(cwd, ".prepare-publish/package.json"), "utf8"),
    );

    expect(result.publishDirectory).toBe(join(cwd, ".prepare-publish"));
    expect(publishPackageJSON.exports["."]).toEqual({
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    });
    expect(publishPackageJSON.files).toContain("README.md");
    expect(await readFile(join(cwd, ".prepare-publish/README.md"), "utf8")).toContain("fixture");
    expect(await readFile(join(cwd, ".prepare-publish/dist/index.mjs"), "utf8")).toContain(
      "fixture",
    );
    expect(result.packedFiles).toContain("README.md");
    expect(result.packedFiles).toContain("dist/index.mjs");
    expect(result.packedFiles).toContain("package.json");
  });

  it("supports dry-run without writing files", async () => {
    const cwd = await createFixture();

    const result = await preparePublish({ cwd, dryRun: true });

    expect(result.packageJSON.exports?.["."]).toEqual({
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    });
    await expect(readFile(join(cwd, ".prepare-publish/package.json"), "utf8")).rejects.toThrow();
  });

  it("preserves nested export paths when resolving built files", async () => {
    const cwd = await createFixture({
      packageJSON: {
        exports: {
          ".": "./src/index.ts",
          "./server": "./src/server/index.ts",
          "./client": "./src/client/index.ts",
          "./package.json": "./package.json",
        },
      },
      files: {
        "dist/server/index.mjs": "export const server = true;\n",
        "dist/server/index.d.mts": "export declare const server: true;\n",
        "dist/client/index.mjs": "export const client = true;\n",
        "dist/client/index.d.mts": "export declare const client: true;\n",
        "src/server/index.ts": "export const server = true;\n",
        "src/client/index.ts": "export const client = true;\n",
      },
    });

    const result = await preparePublish({ cwd, dryRun: true, publint: false });

    expect(result.packageJSON.exports?.["./server"]).toEqual({
      types: "./dist/server/index.d.mts",
      default: "./dist/server/index.mjs",
    });
    expect(result.packageJSON.exports?.["./client"]).toEqual({
      types: "./dist/client/index.d.mts",
      default: "./dist/client/index.mjs",
    });
  });

  it("rewrites source bin entries to built runtime files", async () => {
    const cwd = await createFixture({
      packageJSON: {
        bin: {
          fixture: "./src/cli.ts",
        },
      },
      files: {
        "src/cli.ts": 'console.log("fixture");\n',
        "dist/cli.mjs": 'console.log("fixture");\n',
      },
    });

    const result = await preparePublish({ cwd, dryRun: true, publint: false });

    expect(result.packageJSON.bin).toEqual({
      fixture: "./dist/cli.mjs",
    });
  });
});

type FixtureOptions = {
  packageJSON?: Record<string, unknown>;
  files?: Record<string, string>;
};

async function createFixture(options: FixtureOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "prepare-publish-fixture-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "dist"), { recursive: true });

  const packageJSON = {
    name: "fixture",
    version: "0.0.0",
    type: "module",
    files: ["dist", "README.md"],
    exports: {
      ".": "./src/index.ts",
      "./package.json": "./package.json",
    },
    publishConfig: {
      directories: {
        src: "dist",
      },
    },
    ...(options.packageJSON ?? {}),
  };

  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify(packageJSON, null, 2)}\n`,
  );
  const files = {
    ".npmignore": "IGNORED.md\n",
    "README.md": "# fixture\n",
    "IGNORED.md": "ignored\n",
    "src/index.ts": "export const fixture = true;\n",
    "dist/index.mjs": "export const fixture = true;\n",
    "dist/index.d.mts": "export declare const fixture: true;\n",
    ...(options.files ?? {}),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, relativePath)), { recursive: true });
    await writeFile(join(cwd, relativePath), content);
  }

  return cwd;
}
