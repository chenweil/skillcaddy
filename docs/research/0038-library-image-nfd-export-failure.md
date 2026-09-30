# 库镜像：Linux 上 NFD 源导出失败

日期：2026-09-30。状态：**已解决**（`6bede02`）。发现于引入 CI（`.github/workflows/ci.yml`）之后的首次运行，先于 spec-pipeline 工作存在。

本文件的绝大部分记录的是**排查过程**，包括三条错误方向。结论在最后一节。

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

## 结论：根因与修复

**根因是校验与规范化的顺序，不是校验逻辑本身。**

逐点插桩（`globalThis.__STEP` 挂在 `normalizeStagingPaths` 前后）在真实 `ubuntu-latest` 上给出的序列：

| 步骤 | isNFD | plain | norm |
| --- | --- | --- | --- |
| 生产者源目录（baseline） | true | `7c9fab4b` | `64d24639` |
| 解包后的 staging | true | `7c9fab4b` | `64d24639` |
| `normalizeStagingPaths` 之后 | **false** | **`64d24639`** | `64d24639` |
| 导入结果 | — | 抛错 | — |

staging 全程保持生产者的拼写，与 baseline 一致。改写发生在 `normalizeStagingPaths`：它把条目重命名为 NFC，目录的 plain checksum 随之变成 normalized 的值，于是 plain 与 normalized 都不再匹配 NFD baseline。

**为什么只在 Linux。** macOS 上 NFC 路径已经解析到同一 inode，`normalizeStagingPaths` 走「保持原名」分支，plain 始终等于 baseline。Linux 上 NFC 路径不存在，走重命名分支。

**修复**（`6bede02`）：把 `normalizeStagingPaths` 移到 `verifyImageSources` 之后。先用归档里实际的字节做完整性判定，确认可信之后再把树规范化成 NFC。ADR 0011 Decision 7 的承诺不变——接收端最终仍是 NFC 形式,只是这个结论落在「判断归档是否可信」之后,而不是之前。

副作用：`renameToNfc` 参数不再需要,两个调用点的差异随重排序一起消失。

## 建议的下一步（历史，已完成）

不要在没有新证据的情况下继续试改。上面已排除的每一项都是实测结果，任何"Linux 文件系统如何如何"的推理都需要先在 runner 上验证。

可能的定位方向（均未验证）：

1. `checkExport:923` 记录 `hashes` 用的是 `checksumDirectory`（plain），而 `verifyImageSources` 比的是 `record.integrity.value`。若某处把 baseline 换成了 NFC 形式的值，失配方向就会反过来。
2. 探查 `prepareStaging` / `walkStaging` 是否在某条路径上重命名了条目——目前只确认 `normalizeStagingPaths` 会重命名，而它在 `verifyPackedImage` 中已被排除。
3. 用 `git bisect` 配合逐步插桩，定位 baseline 记录后到自校验之间哪一步改变了形式。

复现环境需要 Linux；`ubuntu-latest` runner 已被本仓库的 CI 证明可用。

## 当前的 CI 处理

修复后 `.github/workflows/ci.yml` 已恢复为单个 `npm test` job（Node 20 与 22），`known-failures` job 已移除。三个 job 全部通过。
