# prepare-publish

[English](./README.md)

从面向源码的 `package.json` 元数据生成一个可直接发布的包目录。

它适合这类库项目：

- 本地开发时使用源码导出
- 发布时输出到 `dist` 这类构建子目录
- 希望发布态 `package.json` 和附带文件遵循 npm 的打包规则，包括
  `.npmignore` 和 `files`
- 希望在准备发布目录时顺带运行 `publint`

如果存在顶层 `types` 字段，`prepare-publish` 会先把它重写到构建后的声明文件路径。
如果它最终和 `exports["."].types` 指向同一个文件，就会移除顶层 `types`，避免重复元数据。

## 安装

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

默认行为：

- 读取当前包的 `package.json`
- 按 npm 的打包规则解析最终会被发布的文件
- 重写发布态元数据，例如 `exports`、`bin`、`types`，使其指向构建产物
- 在 `.prepare-publish/` 下创建 staging 目录
- 将发布态 `package.json` 写入 `.prepare-publish/`
- 将 npm 实际会发布的文件复制到 `.prepare-publish/`，并保持原始相对路径
- 默认对准备好的发布目录运行 `publint`

## 工作方式

`prepare-publish` 不会直接从项目根目录发布。它会先生成一个完整的发布
staging 目录：

```text
.prepare-publish/
```

真正要发布的是这个 staging 目录。

如果你的开发态导出指向 `./src/index.ts`，而构建产物在 `dist/` 中，那么生成
出来的发布态元数据会改写成：

- `./dist/index.mjs`
- `./dist/index.d.mts`

也就是说，`.prepare-publish/` 才是最终发布根目录；工具会根据实际打包文件和
构建产物重写发布态路径。

## 配置

在 `package.json` 的 `publishConfig.directories` 中配置目录映射：

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./utils": "./src/utils/index.ts"
  },
  "publishConfig": {
    "directories": {
      "src": "dist"
    }
  }
}
```

这会在发布时将源码路径映射到构建产物路径：
- `./src/index.ts` → `./dist/index.mjs` / `./dist/index.d.mts`
- `./src/utils/index.ts` → `./dist/utils/index.mjs`

### 多目录映射

对于包含多个源码目录的复杂项目：

```json
{
  "publishConfig": {
    "directories": {
      "src": "dist",
      "src/core": "dist/core",
      "src/types": "dist/types"
    }
  }
}
```

映射使用**最长前缀优先**算法：
- `src/core/types/foo.ts` 匹配 `src/core/types` → `dist/types/foo.ts`
- `src/core/utils.ts` 匹配 `src/core` → `dist/core/utils.ts`
- `src/index.ts` 匹配 `src` → `dist/index.ts`

### 类型专用导出

对于用作虚拟模块声明的 `.d.ts` 文件：

```json
{
  "exports": {
    "./types": "./src/types.d.ts"
  },
  "publishConfig": {
    "directories": {
      "src": "dist"
    }
  }
}
```

结果会是：

```json
{
  "exports": {
    "./types": {
      "types": "./dist/types.d.ts"
    }
  }
}
```

文件必须同时存在于 `packedFiles` 和映射后的位置中。

### 根导出 `types` 去重

如果你同时定义了顶层 `types` 和 `exports["."].types`，
`prepare-publish` 会比较它们重写后的发布路径：

- 如果两者指向同一个声明文件，则移除顶层 `types`
- 如果两者指向不同的声明文件，则保留顶层 `types`

## 发布流程

先在项目根目录完成构建和准备，再进入 `.prepare-publish/` 发布：

```bash
pnpm build
pnpm run prepare:publish
cd .prepare-publish
npm publish
```

还应当把 `.prepare-publish` 加入会扫描工作区的工具忽略列表，例如：

- `.gitignore`
- `.npmignore`
- `.prettierignore`
- `.dprintignore`
- `.eslintignore`
- `.biomeignore`
- `oxlint` / `oxfmt` 的 ignore 配置

`prepublishOnly` 会在执行 `npm publish` 或 `pnpm publish` 时自动触发，但在这套
工作流里，关键准备步骤发生在进入 `.prepare-publish/` 之前。生成出来的 staging
目录应当被视为最终发布根，而不是重新构建的工作目录。

## CLI 输出

CLI 会打印：

- `Tarball Contents`：按 npm 规则解析出的发布文件列表及大小。`--dry-run`
  模式下默认打印，普通模式可通过 `--print-tree` 开启
- `Generated package.json`：将写入 `.prepare-publish/package.json` 的发布态元数据
- `publint: all good`：lint 成功时会打印
- `Tips`：下一步发布命令和 ignore 文件提醒

CLI 默认会运行 `publint`。如果需要跳过，可以传 `--disable-lint`。

如果需要机器可读输出，可以传 `--json`。

## 库用法

```ts
import { preparePublish } from "prepare-publish";

const result = await preparePublish({
  cwd: process.cwd(),
  publint: true,
});

console.log(result.publishDirectory);
```

返回结果包括：

- `publishDirectory`：staging 目录路径，通常是 `.prepare-publish`
- `packageJSON`：生成出来的发布态 `package.json`
- `packedFiles`：按 npm 打包规则选中的文件列表
- `publintMessages`：准备过程中收集到的 `publint` 诊断信息
