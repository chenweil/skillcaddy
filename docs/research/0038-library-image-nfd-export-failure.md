# 库镜像：Linux 上 NFD 源导出失败

日期：2026-09-30。状态：**未解决**。发现于引入 CI（`.github/workflows/ci.yml`）之后的首次运行，先于 spec-pipeline 工作存在。

本文件只记录事实与已排除项，不含猜测性结论。行号对应 `feat/spec-pipeline-gate` 合并后的 `lib/libraryImage.js`。

## 复现

```bash
# macOS：本文件所在的开发机，103/103 通过
node --test test/libraryImage.test.js

# Linux（ubuntu-latest）：102/103，通过 --test-name-pattern 也可单独复现
node --test --test-name-pattern "NFD-named source" test/libraryImage.test.js
```

失败用例：`test/libraryImage.test.js:999`
`imports an NFD-named source without a spurious checksum mismatch (ADR 0011 Decision 7)`

报错：`Staged checksum mismatch: personal/alpha`，抛自 `lib/libraryImage.js:1206`，位于 `verifyImageSources`（`:1162`）内，经 `verifyPackedImage`（`:1669`）由 `exportLibraryImage` 调用。

## 现象

在 `ubuntu-latest` 上实测的三个值（`verifyImageSources` 内部）：

```
baseline = 7c9fab4bc723    registry 记录的 integrity（NFD 形式的 plain checksum）
plain    = 64d2463925da    roundtrip 目录的 checksumDirectory
norm     = 64d2463925da    roundtrip 目录的 checksumDirectoryNormalized
listed   = SKILL.md,café.md
```

`plain === norm` 说明 roundtrip 目录里的文件名已是 **NFC**；而 baseline 是 **NFD** 形式的 plain checksum。`verifyImageSources`（`lib/libraryImage.js:1162`）在 1198-1200 行同时接受 plain 或 normalized，二者都与 baseline 不匹配。

这意味着 `exportLibraryImage` **无法通过对自己刚产出的归档的自校验**。

## 已排除项（均为实测，非推断）

在真实 `ubuntu-latest` runner 上跑探针得到：

| 环节 | macOS | Linux | 结论 |
| --- | --- | --- | --- |
| `readdir` 返回的形式 | NFD | NFD | 相同 |
| `plain` / `norm` checksum | `9588c10d…` / `a9aac833…` | `9588c10d…` / `a9aac833…` | **逐字节相同** |
| `fs.cp` 是否保持形式 | 是 | 是 | 相同 |
| tar 往返是否保持形式 | 是 | 是 | 相同 |

因此**文件系统、`cp`、tar 三者均已排除**。分歧是在导出流程内部产生的。

## 契约依据

- ADR 0011 Decision 7（`docs/adr/0011-…:117-119`）：NFD 命名产物列在 **Diagnose** 下，"must not block import"；归档存 NFC 字节。
- `docs/LIBRARY_IMAGE_SPEC.md:182`：同一条目列在 Diagnose。
- 导入侧 `lib/libraryImage.js:1198-1200` 已实现该容忍（plain 或 normalized 任一匹配即通过）。
- 导出侧的自校验与 registry baseline 比较，未实现同等容忍。

## 两次失败的修复尝试（均已 revert，保留在历史中）

| commit | 内容 | 结果 |
| --- | --- | --- |
| `c6fda80` | 删除 `normalizeStagingPaths` 的重命名 | 未绿；并破坏导入契约（接收端必须落 NFC） |
| `3d50484` | 给 `normalizeStagingPaths` 加 `renameToNfc` 参数区分调用方 | 未绿；自校验仍失配 |

`3d50484` 之后 `renameToNfc` 选项与 `verifyImageSources` 的 ctime 试验均已回退，当前 `lib/libraryImage.js` 与加 CI 之前一致，另有一处已验证修复（见下）。

## 同批次已修复的问题（供参考，其诊断方法可复用）

`assertImageScopes`（`lib/libraryImage.js:1504`）原本只比较 `${dev}:${ino}`。实测 Linux 上 `rm` + `mkdir` 同一路径返回**完全相同**的 inode（`2049:9180294` 前后一致），因此确认后被替换的 scope 目录无法被 `stale-plan` 检测到；macOS 递增 inode，故从未暴露。

修复：快照额外记录目录条目集合（NFC 归一化后排序）并比较。曾试过 `ctime` 并否决——它也会因内容变化而更新，会在 macOS 上误报。

## 建议的下一步

不要在没有新证据的情况下继续试改。上面已排除的每一项都是实测结果，任何"Linux 文件系统如何如何"的推理都需要先在 runner 上验证。

可能的定位方向（均未验证）：

1. `checkExport:923` 记录 `hashes` 用的是 `checksumDirectory`（plain），而 `verifyImageSources` 比的是 `record.integrity.value`。若某处把 baseline 换成了 NFC 形式的值，失配方向就会反过来。
2. 探查 `prepareStaging` / `walkStaging` 是否在某条路径上重命名了条目——目前只确认 `normalizeStagingPaths` 会重命名，而它在 `verifyPackedImage` 中已被排除。
3. 用 `git bisect` 配合逐步插桩，定位 baseline 记录后到自校验之间哪一步改变了形式。

复现环境需要 Linux；`ubuntu-latest` runner 已被本仓库的 CI 证明可用。

## 当前的 CI 处理

`.github/workflows/ci.yml` 把 `test/libraryImage.test.js` 放在单独的 `known-failures` job，带 `continue-on-error`。主 job 跑其余 328 个断言加 import lint 与 spec gate，两个 Node 版本都通过。

修好之后应移除该 job，并在主 job 恢复完整 `npm test`。
