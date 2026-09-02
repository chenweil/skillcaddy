# #34：macOS library image 在 Linux GNU tar 下的保真度

交给 owner 实操的验证包。产物是一份可直接贴回
[#34](https://github.com/chenweil/skillcaddy/issues/34) 的 Markdown 报告。

这条是 [#35](https://github.com/chenweil/skillcaddy/issues/35) 的强前置：跨平台
保证的口径必须建立在实测事实上，而不是推测。

## 为什么必须由你跑

我在本机 macOS 加 Linux 容器上跑通了全流程，脚本是验证过的。但容器不能代替
真实 Linux 落地：

- 容器 bind mount 的底层是 APFS，不是 ext4/xfs/btrfs。unicode 规范化、mode、
  owner 的最终行为取决于**真实目标文件系统**。
- 容器里跑的是 root。GNU tar 的 `--no-same-owner` 与 `--no-same-permissions`
  文档写明「default for ordinary users」——root 与普通用户的默认行为不同，而
  真实导入很可能以普通用户进行。
- 目标服务器的 GNU tar 版本、发行版、内核可能与 Ubuntu 24.04 / tar 1.35 不同。

所以脚本已就绪，缺的是你在真实 macOS 与真实 Linux 上各跑一次。

## 三步

### 第 1 步：macOS 上打包

```sh
cd docs/research/0034-fidelity
./pack-macos.sh
```

造一棵覆盖 #34 全部待验项的源树，用系统 tar 打包，采集打包侧事实，并在
macOS 上原地回环解包一次（用于把「tar 自身的问题」与「跨平台的问题」分开）。

只在 `/tmp/libimg34-*` 下操作，不触碰活跃原件库。

结束时会打印产物目录，包含 `library-image.tar`、`library-image.tar.gz` 和两份
`facts-macos-*.json`。

### 第 2 步：把产物目录送到 Linux，在那里解包

```sh
scp -r <产物目录> user@linux-host:/tmp/libimg34-in
git clone <skillcaddy> /tmp/skillcaddy   # facts.mjs 需要仓库里的 checksumDirectory

cd /tmp/skillcaddy/docs/research/0034-fidelity
./verify-linux.sh /tmp/libimg34-in /tmp/skillcaddy
```

解两次：不加 flag 的基线，以及 #33 建议的硬化 flag 集合。需要 Node 20+；缺
`getfattr` 时 xattr 一列记为 `unavailable`，不影响主结论。

**如果目标服务器会以普通用户导入，请用普通用户再跑一次**，把两份报告都贴上。

### 第 3 步：出报告

```sh
node compare.mjs /tmp/libimg34-in > report.md
```

任一平台都能跑，纯读 JSON。把 `report.md` 贴回 #34。

## 报告怎么读

分级不是装饰，它直接对应导入侧的真实后果。

`checksumDirectory`（`lib/sourceTree.js`）是导入侧真正的校验闸门，而它只计
**路径串、条目类型、文件内容、软链 target**。#25 已确认它不计 mtime、mode、
owner、xattr。因此：

- **FAIL** —— 会让 `checksumDirectory` 不等，导入侧逐源 sha256 严格校验必然失败。
  这类项必须进 #35。
- **DIAGNOSTIC** —— 平台常量差异，不进哈希，不阻断导入。记录备查。

## 我这轮实测已经拿到的结论

在 Darwin 25.6.0 arm64 / bsdtar 3.5.3 与 Ubuntu 24.04 / GNU tar 1.35（容器，
bind mount 落 APFS，root）之间：

| 比对 | 结论 |
| --- | --- |
| macOS → Linux GNU tar，无 flag | PASS，`checksumDirectory` 与源相等 |
| macOS → Linux GNU tar，#33 硬化 flag | PASS，与无 flag 逐字节同结果 |
| **macOS 原地回环（bsdtar 解包）** | **FAIL** |

一个非预期发现，且方向和直觉相反：**跨平台是好的，本机回环才是坏的。**

非 ASCII 文件名在 bsdtar 解包侧被规范化成了 NFD：

| 环节 | `café.md` 的字节 | 形式 |
| --- | --- | --- |
| APFS 存盘 + `readdir` | `636166c3a92e6d64` | NFC |
| `cp` 复制后 | `636166c3a92e6d64` | NFC |
| 归档 header 与 PAX `path` 记录 | `636166c3a92e6d64` | NFC |
| bsdtar 解包后 | `63616665cc812e6d64` | **NFD** |
| GNU tar 解包后（容器原生 fs） | `636166c3a92e6d64` | NFC |

归档里存的是 NFC，GNU tar 解出 NFC，只有 bsdtar 解出 NFD，复核三次稳定复现，
`--no-mac-metadata` 不影响。所以规范化发生在 bsdtar 的解包路径，不在文件系统、
不在打包、不在归档格式。

这件事对地图的意义：「逐源 sha256 严格校验，任一不匹配则整体失败」这条约束，
在 **macOS 导入 macOS 打出的镜像**这个场景下会因为非 ASCII 文件名而失败，而
macOS → Linux 反倒没问题。

已在本机活跃原件库上确认这不是理论问题：

```
非 ASCII 路径段总数: 39
  NFC: 39   NFD: 0
```

39 个全是 NFC（`github/ClaudeSkills/**/references/命题标准.md` 一类的中文文件名）。
也就是说这些路径在 bsdtar 解包后会全部变成 NFD，`checksumDirectory` 必然不等。
**macOS → macOS 的导入今天就会失败。** 这一项必须由 #35 定口径，不能留给实现。

请在你的真机上复跑这段统计确认口径一致：

```sh
node -e '
const fs=require("fs"), path=require("path");
let nfc=0,nfd=0;
(function walk(d){
  let es; try{es=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
  for(const e of es){
    if(/[^\x00-\x7F]/.test(e.name)){
      e.name===e.name.normalize("NFC") ? nfc++ : nfd++;
    }
    if(e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d,e.name));
  }
})(".");
console.log({nfc,nfd});
'
```

另外三项列为诊断，不阻断：

- 死链的 `lstat` mode 在 macOS 是 `0755`、Linux 是 `0777`，平台常量。
- `mtime` 在无 flag 时有偏移，加 `--delay-directory-restore` 后消失。
- 自定义 xattr `com.skillcaddy.test` 不跨 tar 存活；`com.apple.provenance` 由
  macOS 在落地时重新挂上。

## 打包侧固定的两个 flag

`pack-macos.sh` 打包时加了 `--no-mac-metadata --no-xattrs`。原因：macOS 给每个
文件挂 `com.apple.provenance`，bsdtar 默认把它编成 `LIBARCHIVE.xattr.*` PAX
记录，GNU tar 解包时对**每个文件**报一行 `Ignoring unknown extended header
keyword`。内容无损，但噪音会淹掉真正的错误。两个 flag 实测都被 bsdtar 接受。

这是打包侧的建议，不是已定决策——写进 spec 前需要 #35 认可。

## 一个已知的口径冲突

地图定的产物是单个 `.tar.gz`，但当前 `lib/libraryImage.js` 的 `assertUncompressed`
见到 gzip 签名会直接拒收，理由是 pre-flight 解析裸 tar，若让系统 tar 自行解压，
两者对同一字节流的解读会脱节。已实测确认 `.tar.gz` 会被拒。

`pack-macos.sh` 两种都打，让 #35 拿着实测数据决定：是放弃压缩，还是让 pre-flight
自己解压一遍。这不是我能替它定的。

## 文件

| 文件 | 作用 |
| --- | --- |
| `pack-macos.sh` | 第 1 步。造源树、打包、采集打包侧事实、macOS 回环 |
| `verify-linux.sh` | 第 2 步。Linux 上解包两次并采集事实 |
| `facts.mjs` | 事实采集器。复用仓库自己的 `checksumDirectory` |
| `archive-names.mjs` | 打印归档 header 内真实的文件名字节 |
| `compare.mjs` | 第 3 步。比对并产出 Markdown 报告 |

`facts.mjs` 刻意复用 `lib/sourceTree.js` 的 `checksumDirectory` 而不是重写一份：
重写版一旦与生产实现有任何偏差，这次测试就失去意义。

`archive-names.mjs` 存在的理由是 `tar -tf` 打印的是经过本机 tar 与 locale 处理
后的名字，不是归档里的字节；判定规范化归属必须直接读 header。
