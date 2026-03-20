# prepare-publish

[简体中文](./README.zh-CN.md)

Prepare a publish-ready package directory from source-oriented `package.json`
metadata.

It is designed for libraries that:

- use source exports during local development
- publish a built subdirectory such as `dist`
- want publish-time `package.json` and copied extra files to follow npm packing
  rules, including `.npmignore` and `files`
- optionally want to run `publint` against the prepared output

## Installation

```bash
pnpm add -D prepare-publish
```

## CLI

```bash
prepare-publish
prepare-publish --dry-run
prepare-publish --json
prepare-publish --print-tree
prepare-publish --disable-lint
prepare-publish --cwd packages/foo
```

By default it:

- reads the current package's `package.json`
- resolves the files npm would publish using npm packing rules
- creates a staging directory at `.prepare-publish/`
- writes a publish-ready `package.json` into `.prepare-publish/`
- copies the files npm would publish into `.prepare-publish/`, preserving their
  original relative paths
- runs `publint` against the prepared output

## How It Works

`prepare-publish` does not publish from your project root directly. It prepares a
complete publish staging directory at:

```text
.prepare-publish/
```

That staging directory is the directory you should publish.

If your development exports point to `./src/index.ts` and your built files live
in `dist/`, the generated publish package metadata will point to
`./dist/index.mjs` and `./dist/index.d.mts`.

## Publishing Flow

Run the build and prepare steps from the project root, then publish from the
generated staging directory:

```bash
pnpm build
pnpm run prepare:publish
cd .prepare-publish
npm publish
```

You should also add `.prepare-publish` to any tooling ignore lists that scan
your workspace, for example:

- `.gitignore`
- `.npmignore`
- `.prettierignore`
- `.dprintignore`
- `.eslintignore`
- `.biomeignore`
- `oxlint` / `oxfmt` ignore patterns

`prepublishOnly` runs automatically when `npm publish` or `pnpm publish` is
executed, but in this workflow the important preparation work happens before you
enter `.prepare-publish`. The generated staging directory should be treated as a
final publish root, not as a place to rebuild the package.

## CLI Output

The CLI prints:

- `Tarball Contents`: the resolved publish file list with file sizes. This is
  printed by default in `--dry-run` mode and can be enabled in normal mode with
  `--print-tree`.
- `Generated package.json`: the publish-ready package metadata that will be
  written into `.prepare-publish/package.json`
- `publint: all good`: printed when linting succeeds
- `Tips`: the next publish command and ignore-file reminder

By default the CLI runs `publint`. Use `--disable-lint` to skip it.

Use `--json` to print a machine-readable result object instead of the normal
human-readable output.

## Library Usage

```ts
import { preparePublish } from "prepare-publish";

const result = await preparePublish({
  cwd: process.cwd(),
  publint: true,
});

console.log(result.publishDirectory);
```

The returned object includes:

- `publishDirectory`: the staging directory path, typically
  `.prepare-publish`
- `packageJSON`: the generated publish-ready `package.json`
- `packedFiles`: the file list selected using npm packing rules
- `publintMessages`: any `publint` diagnostics collected during preparation
