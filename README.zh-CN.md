# @hornjs/prepare-publish

[English](./README.md)

从面向源码的 `package.json` 元数据生成一个可直接发布的包目录。

它适合这类库项目：

- 本地开发时使用源码导出
- 发布时输出到 `dist` 这类构建子目录
- 希望发布态 `package.json` 和附带文件遵循 npm 的打包规则，包括
  `.npmignore` 和 `files`
- 希望在准备发布目录时顺带运行 `publint`

## 安装

```bash
pnpm add -D @hornjs/prepare-publish
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
import { preparePublish } from "@hornjs/prepare-publish";

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
