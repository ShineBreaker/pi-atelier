#!/usr/bin/env node
// 从 CHANGELOG.md 提取指定版本的发布说明，stdout 输出。
//
// 提取规则：从 `## [<version>]` 行开始，到下一个 `## [` 版本段行为止；
// 版本段与下一段之间的 `## 技术细节 / Migration Notes` 属于该版本，一并
// 包含。版本段不存在时 exit 1（CI 拒绝发无 release notes 的版本）。
//
// 用法：node extract-release-notes.mjs <version>    # version 不带 v 前缀
// （release.yml 调用；本地手工补发时也可直接用）

import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: extract-release-notes.mjs <version>");
  process.exit(2);
}

const changelog = readFileSync(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf-8",
);
const lines = changelog.split("\n");

// `]` 闭合保证精确匹配（"## [0.4.1]" 不会命中 "## [0.4.10]"）
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md 中没有 ${version} 的版本段`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## [")) {
    end = i;
    break;
  }
}

process.stdout.write(lines.slice(start, end).join("\n").trimEnd() + "\n");
