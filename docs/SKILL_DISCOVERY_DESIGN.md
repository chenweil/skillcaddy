# Hot Skills UI — Design

Status: Draft for review. Revised for the fixed terms below and the homepage/detail references.

## Fixed product decisions

These are fixed and are not renegotiated in this document:

1. **实时热度排行**: the ranking is a hot ranking over a recent window. The default is **24 小时**, and the time window can be switched to any fixed period.
2. **导航栏**: add one new tab, **热门**. Clicking it switches to the new Hot page. The existing library workspace remains the default page.

Everything else — data source, refresh policy, file layout, caching, metadata enrichment, and API shape — is a design decision proposed here.

## Outcome

- The top bar gains a single **热门** tab. The existing library/enablement workspace stays the default `已安装` view.
- **热门** opens a full-width hot-ranking page: category bar with counts, time-window selector, search, and a cover-image card grid.
- A card opens a **detail page** with summary, skill list, SKILL.md preview, related skills, and metadata.
- **Adding is source acquisition into the library root only.** It never creates a project, global, Hermes, or Claude enablement link.

## Product model

| UI label | Domain term | Meaning |
| --- | --- | --- |
| 已安装 / Installed | Source present in the source registry | The source was acquired into the library. Nothing is enabled. |
| 添加到原件库 | Source acquisition | Clone/download, validate, and install into the library root. |
| 启用 | Enablement | Create a scope-specific symlink for one project, the global Agents directory, or Hermes. |
| 热门 / Hot | Hot ranking | A windowed ranking of skill sources and skills by recent install growth. |

`Installed` is a UI label only. Code, tests, and docs keep using **source acquisition** and **source registry** from `CONTEXT.md`. The UI states the distinction:

> 已安装 = 已加入原件库；启用 = 链接到项目、全局或 Hermes。

### Ranking is skill-level; acquisition is source-level

The hot list ranks skills, because that is what the upstream leaderboard measures. Skillcaddy still acquires a whole source (ADR-0001, ADR-0003). The detail page must disclose this before the add action:

> Skillcaddy 以来源为单位管理。添加 `find-skills` 会加入 `vercel-labs/skills` 整个来源（6 个 skill）。

Cards can represent a skill or a source collection. The card title is the skill or collection name; the source is always shown.

## Information architecture

```text
Top bar: [SkillCaddy]  已安装  热门  [版本] [GitHub] [刷新]

已安装 (default)
  └─ existing hero, project controls, enablement panel, library list

热门
  ├─ category bar with counts
  ├─ result count + time-window selector + search
  ├─ card grid (ranked)
  └─ card click → detail

热门 / 详情
  ├─ back to 热门
  ├─ main column: title, category, install block, summary, skills, SKILL.md, related
  └─ sidebar: status, source, stars/installs, first seen, validation
```

### Routing

Use query parameters, composing with the existing `projectPath` parameter:

- `?view=installed` — existing library workspace (default).
- `?view=hot` — Hot page, default window `24h`.
- `?view=hot&window=7d` — another fixed window.
- `?view=hot&window=custom&days=30` — custom fixed period.
- `?view=hot&source=vercel-labs%2Fskills&skill=find-skills` — detail page.

Use `history.pushState` for tab and card navigation, and `popstate` to re-render. `loadState()` keeps using `replaceState` for `projectPath` and preserves the other parameters.

## Hot page

```text
┌ 热门 ────────────────────────────────────────────────────────────┐
│ [全部 600] [工程开发 47] [设计与视频 38] [产品与项目 25] …        │
│                                                                  │
│ 共 600 个热门 · 24 小时        [24 小时 ▾]  [搜索…]              │
│                                                                  │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              │
│ │ #1  cover    │ │ #2  cover    │ │ #3  cover    │              │
│ ├──────────────┤ ├──────────────┤ ├──────────────┤              │
│ │ 标题      ✓  │ │ 标题      ✓  │ │ 标题      ✓  │              │
│ │ 描述两行…    │ │ 描述两行…    │ │ 描述两行…    │              │
│ │ 来源    +12.6k│ │ 来源    +9.8k │ │ 来源    +7.2k │              │
│ └──────────────┘ └──────────────┘ └──────────────┘              │
└──────────────────────────────────────────────────────────────────┘
```

### Category bar

- `全部` plus one entry per non-empty category, with counts.
- Categories are a fixed vocabulary stored as keys; the UI renders labels:

| Key | Label |
| --- | --- |
| `engineering` | 工程开发 |
| `design` | 设计与视频 |
| `product` | 产品与项目 |
| `content` | 内容与知识 |
| `writing` | 写作与研究 |
| `growth` | 营销增长 |
| `docs` | 文档与幻灯片 |
| `other` | 其他 |

- Unknown categories fall back to `other`.
- Counts are computed from the current window's ranked entries, not from all-time totals.
- The bar scrolls horizontally on narrow screens.

### Time-window selector

- `24 小时` (default), `7 天`, `30 天`, `8 周`, `全部`, `自定义`.
- `自定义` opens a small popover with `最近 N 天` (1–90) and applies the value on submit.
- The selector is the only "tool" filter. The reference's "全部工具" is not copied: Skillcaddy skills are agent-agnostic, so there is no per-tool metadata.
- The current window and the actual window used are shown. When history is insufficient for a custom window, the UI labels the fallback: `历史不足，暂用 7 天`.

### Toolbar

- Left: `共 N 个热门 · <窗口>`.
- Right: window selector and search.
- Search matches display name, source, description, author, and tags.
- No additional sort dropdown: the page is a ranking. The window selector is the primary control.

### Cards

- Rank badge `#1`, `#2`, … in the cover corner.
- Cover at a fixed 16:10 aspect ratio. Curated covers come from `catalog/covers/`; missing or broken covers fall back to a deterministic gradient plus a monogram and category label.
- Title, verified check, two-line description, source, and the window's install growth.
- Secondary metric: total installs or GitHub stars when available. If neither is known, hide it; never invent a number.
- `已安装` pill when the containing source is in the registry. It is distinct from the verified check.
- Non-GitHub sources show `暂不支持一键添加` on the detail page, not on the card.
- Whole card is a link to the detail page. No quick-add button: browsing and installing are separated, which matches the references and avoids accidental library writes.
- Keyboard-focusable; Enter/Space opens.
- Images use `loading="lazy"` and `decoding="async"`.

### States

- Loading: skeleton cards.
- Upstream unavailable and no cache: bundled `hot-fallback.json`, labeled `离线快照 · <date>`.
- Upstream unavailable but cache exists: last good data, labeled `数据可能已过期`.
- Empty category: `这个分类还没有热门`.
- No search results: `没有匹配的热门` with `清除筛选`.
- Stale data: show `更新于 HH:mm` and a manual refresh button.

## Detail page

```text
← 热门

┌───────────────────────────────────────────────┬──────────────────────┐
│ find-skills                      [工程开发]   │ 状态                 │
│ by vercel-labs                                │ 未安装 / 已安装       │
│                                               │ 来源类型  Git         │
│ INSTALLATION                                  │ 仓库  vercel-labs/skills│
│ [添加到原件库]  [复制来源地址]                │ Stars  40.0k          │
│ 添加会加入整个来源（6 个 skill）              │ 24h   +126.0k         │
│                                               │ 累计  4.4M            │
│ SUMMARY                                       │ 收录于 2026-11-19     │
│ Discover and install specialized agent skills │ 来源审核 已审核       │
│ …                                             │ 格式校验 通过         │
│                                               │ 内容执行 不执行       │
│ SKILLS IN THIS SOURCE (6)                     │                      │
│ ▸ find-skills        Discover and install …   │                      │
│ ▸ agent-browser      Full browser automation… │                      │
│ ▸ skill-creator      Create, test, publish…   │                      │
│                                               │                      │
│ SKILL.MD                                      │                      │
│ 安装后可查看完整内容；已安装来源直接读取本地   │                      │
│ SKILL.md。                                    │                      │
│                                               │                      │
│ RELATED                                       │                      │
│ 同来源的其他 skill / 同分类的其他热门 …       │                      │
└───────────────────────────────────────────────┴──────────────────────┘
```

### Main column

- Title and category label.
- Source link (`owner/repo` or the stable URL).
- Installation block:
  - Primary `添加到原件库` for GitHub sources.
  - One-line disclosure: the whole source is added.
  - Secondary `复制来源地址` (copies `https://github.com/<source>.git`).
  - Non-GitHub source: disabled action with `暂不支持一键添加` and a link to the source. Skillcaddy's acquisition adapters do not cover arbitrary well-known endpoints in this scope.
  - No foreign `npx skills add` command: the acquisition unit and CLI differ, and showing it would be misleading.
- Summary: from `catalog/overrides.json` when available; otherwise `来自 <source> 的 skill`.
- Skills in this source: from the leaderboard's same-source entries and the overrides. For installed sources, selecting a skill loads its local SKILL.md.
- SKILL.md:
  - Installed source: read the local file, render a safe Markdown subset, offer `展开全文` / `收起`.
  - Not installed: show the curated summary and `安装后可查看完整 SKILL.md`. No upstream fetch in the MVP; a lazy GitHub fetch can be added in phase 1.5.
- Related:
  - Other skills from the same source.
  - Up to six same-category entries from the current hot list.

### Sidebar

- Status: `未安装`, `添加中…`, `已安装`.
- Source type: Git for GitHub sources; `外部来源` for non-GitHub.
- Repository / stable URL.
- GitHub stars when known, with `截至 <date>`.
- `24h` or the selected window's growth, plus cumulative installs.
- `收录于 <firstSeen>` — the local first-seen date, not an upstream claim.
- Validation:
  - `来源审核` — `已审核` / `未审核` from overrides.
  - `格式校验` — `通过` or `N 条提示` from acquisition.
  - `内容执行` — always `不执行`.
  - `完整性` — `已登记` for non-Git sources with an integrity baseline.
- No third-party audit logos or scores. Skillcaddy does not run Snyk/Socket/Gen Agent Trust Hub, so it must not display them.

### Detail states

- Not installed: summary and skill list from the hot data; SKILL.md placeholder.
- Installing: primary button disabled; sidebar status updates.
- Installed: `已安装` pill; `查看原件` switches to `已安装` and sets the search query to the source name.
- Acquisition failure: inline error with retry; no partial library state.
- Source collision: `同名来源已存在，未覆盖` with a CLI hint.
- Non-GitHub source: disabled add action and an explanation.

## Data source

### Provider contract

The Hot page is driven by a replaceable provider, not by a bundled recommendation list:

```js
// lib/hot/hotProvider.js
fetchHotRanking({ window, signal, cache }) → {
  generatedAt,
  source: 'skills.sh',
  window: { requested, actual, label, kind },
  entries: [{ source, skillId, name, installs, windowInstalls, isOfficial }],
  stale
}
```

- The provider is isolated behind this contract. The rest of the app never parses upstream HTML.
- The default provider is **skills.sh**, because it is the source behind the reference pages and it exposes the needed install counts.
- `SKILLCADDY_HOT_SOURCE=off` disables live fetching and uses the bundled fallback. This is the escape hatch for offline use, upstream changes, or terms concerns.

### skills.sh adapter

The site is a Next.js app. The leaderboard data is embedded in the server-rendered RSC payload as `initialSkills`. Three pages cover the required windows:

| Page | Payload | Fields |
| --- | --- | --- |
| `https://skills.sh/hot` | `initialSkills` | `source`, `skillId`, `name`, `installs`, `installsYesterday`, `change`, `isOfficial` |
| `https://skills.sh/trending` | `initialSkills` | `source`, `skillId`, `name`, `installs`, `isOfficial` |
| `https://skills.sh/` | `initialSkills` | `source`, `skillId`, `name`, `installs`, `weeklyInstalls[8]`, `isOfficial` |

The adapter:

1. Fetches the page with a 5 s timeout, a 2 MB response cap, `Accept-Encoding: gzip`, and a `User-Agent` of `skillcaddy/<version>`.
2. Extracts `self.__next_f.push([1,"…"])` chunks, concatenates and unescapes them.
3. Finds `"initialSkills":[` and parses the JSON array with a bracket matcher that respects strings.
4. Validates every entry and drops malformed ones.
5. Returns the normalized list.

The parser is covered by fixtures. If the upstream changes its payload, only this adapter breaks, and the fallback path keeps the page usable.

### Window computation

| UI window | Upstream data | Computation | Fallback |
| --- | --- | --- | --- |
| 24 小时 | `/hot` | `change` (today − yesterday), clamped at 0 | local rolling 24h snapshot delta; then `/hot` `installs` |
| 7 天 | `/trending` | `installs` | sum of the latest `weeklyInstalls` bucket |
| 30 天 | `/` | sum of the latest four `weeklyInstalls` buckets (28 days) | local snapshot delta |
| 8 周 | `/` | sum of all `weeklyInstalls` buckets | local snapshot delta |
| 全部 | `/` | cumulative `installs` | bundled fallback |
| 自定义 N 天 | local snapshots | `cumulative(now) − cumulative(now − N days)` | nearest available window, labeled in the UI |

"Any fixed period" is implemented with local snapshots. The first run has no history, so a custom window falls back to the nearest upstream window and says so. After enough snapshots, any `N` in 1–90 days is computed locally.

### Snapshot store

- Location: `~/.skillcaddy/cache/hot/` — user cache, not the library, not the code root, not part of the library image or sync.
- Files: `snapshots/YYYY-MM-DDTHH.json` with `{ capturedAt, entries: [{ key, installs }] }`.
- `meta.json` records `firstSeen` per key and the last successful refresh.
- Retention: hourly snapshots for 7 days, daily snapshots for 90 days. Prune on write.
- Writes are atomic (temp file + rename). The server is single-process, so an in-process promise chain is enough to serialize writes.
- Snapshot deltas power custom windows, rolling 24h after the first day, rank changes, and `firstSeen`.
- If a key disappears from the upstream, keep its last snapshot and mark it `已下架`; do not silently delete history.

### Cache and refresh policy

- Server memory cache, keyed by upstream page:
  - `/hot`: 60 s.
  - `/trending`: 5 min.
  - `/`: 10 min.
- On a stale request, fetch once; if the fetch fails, serve the last cached result with `stale: true`.
- Respect `429` and `Retry-After`; do not retry in a tight loop.
- No background timers or daemons. Refresh is request-driven.
- Client refresh:
  - On entering `热门`, load the selected window.
  - Poll every 60 s for `24 小时`, every 5 min for longer windows, only while the page is visible.
  - Pause when `document.hidden`.
  - Manual refresh button; server rate-limits forced refresh to once per 30 s.
- The UI shows `更新于 HH:mm:ss` and `数据来源：skills.sh`. "实时" is bounded by the upstream update cadence and the 60 s cache; the timestamp is the honest signal.

### Fallback data

- `catalog/hot-fallback.json`: a recent leaderboard snapshot in the same normalized shape, shipped with releases.
- Used when the live source and the local cache are both unavailable.
- Labeled `离线快照 · <date>` in the UI.
- `SKILLCADDY_HOT_SOURCE=off` uses this file directly.

### Attribution and terms

- Show `数据来源：skills.sh` with a link. Do not imply affiliation.
- Use text attribution only; do not copy the site's logos or artwork.
- The adapter is replaceable. Before release, confirm the upstream's terms and robots policy. If live fetching is not acceptable, switch the default to the bundled snapshot or a self-hosted provider.
- The browser never contacts skills.sh directly; only the local server does. No user data is sent.

## Metadata enrichment

The leaderboard provides only source, skill, and install counts. Descriptions, categories, covers, stars, and verification come from a curated override file:

`catalog/overrides.json`

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-19",
  "sources": {
    "vercel-labs/skills": {
      "category": "engineering",
      "description": "A collection of agent workflow skills.",
      "homepage": "https://github.com/vercel-labs/skills",
      "cover": "covers/vercel-labs-skills.webp",
      "verified": true,
      "stars": 40000,
      "starsCapturedAt": "2026-11-19"
    }
  },
  "skills": {
    "vercel-labs/skills/find-skills": {
      "displayName": "find-skills",
      "category": "engineering",
      "description": "Discover and install specialized agent skills from the open ecosystem.",
      "verified": true
    }
  }
}
```

Merge precedence:

1. Skill override.
2. Source override.
3. Defaults: display name = `name`, description = `来自 <source> 的 skill`, category = `other`, cover = generated, verified = false.

- Curated covers live in `catalog/covers/`, are WebP, roughly 16:10, ≤ 200 KB each, and are original or licensed artwork. Do not copy covers from the reference sites.
- Missing covers fall back to a deterministic gradient and monogram; the grid never shows broken images.
- Stars are curated snapshots when present; the detail page may fetch stars lazily from the GitHub API for the selected repo, cached 24 h. The list does not fan out star requests for every card.
- `firstSeen` comes from the local snapshot store, not from the upstream.
- `verified` means a maintainer reviewed the source. It is not a security guarantee and does not skip acquisition validation.
- Categories are curated in the same file. Entries without a category fall into `其他`; the counts show the real distribution.

## Installed detection

Installed state is derived from the **source registry**, never from a hot-list flag.

- **GitHub source** (`owner/repo`): canonicalize `https://github.com/<source>.git` and the registry record's `origin.remote` with `canonicalGitRepositoryLocation()`. Compare `host/owner/repo`. This makes HTTPS, SSH, `.git`, and tree URL variants equivalent.
- **Non-GitHub source**: no install action in this scope, so installed state is not applicable.
- Installed is **source-level**. A skill is installed when its containing source is in the registry. A repository installed with or without a focus path counts as installed.
- Bundled `skills/` appear in `已安装` but are never marked as hot-installed.

## Server and API

### Modules

- `lib/hot/hotProvider.js` — provider contract and selection (`skills.sh` or off).
- `lib/hot/skillsShProvider.js` — fetch, parse, normalize, timeout, response cap.
- `lib/hot/hotRanking.js` — window computation, snapshot deltas, rank changes, fallback labeling.
- `lib/hot/hotCache.js` — in-memory TTL cache, stale serving, 429 handling.
- `lib/hot/snapshotStore.js` — atomic snapshot writes, retention, `firstSeen`, prune.
- `lib/hot/hotMetadata.js` — overrides merge, categories, covers, stars.
- `lib/hot/skillPreview.js` — safe local SKILL.md read and render contract.
- `lib/catalog.js` — installed detection and install pipeline shared with the existing catalog surface.

### Endpoints

`GET /api/hot?window=24h&category=engineering`

```json
{
  "generatedAt": "2026-11-19T09:30:00Z",
  "source": "skills.sh",
  "stale": false,
  "window": { "requested": "24h", "actual": "24h", "label": "24 小时" },
  "categories": [
    { "key": "engineering", "label": "工程开发", "count": 47 }
  ],
  "entries": [
    {
      "id": "vercel-labs/skills/find-skills",
      "source": "vercel-labs/skills",
      "skillId": "find-skills",
      "name": "find-skills",
      "displayName": "find-skills",
      "description": "…",
      "category": "engineering",
      "cover": "/catalog-assets/covers/vercel-labs-skills.webp",
      "installs": 4436719,
      "windowInstalls": 126000,
      "stars": 40000,
      "verified": true,
      "installed": true,
      "installable": true,
      "rank": 1
    }
  ]
}
```

`GET /api/hot/skill?source=vercel-labs%2Fskills&skill=find-skills`

Returns the merged entry plus:

- `installed`, `installedSourceId`
- `sourceType` (`git` or `external`)
- `skillMd` for an installed source
- `validation` summary
- `related` entries

`POST /api/hot/install`

Request:

```json
{ "source": "vercel-labs/skills", "skill": "find-skills" }
```

- Validates that `source` appears in the current hot data or overrides.
- Requires `source` to match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; constructs `https://github.com/<source>.git`.
- Calls `planAddSource` / `applyAddSource`. No enablement calls.
- Returns the acquisition result.
- Non-GitHub sources return `unsupported_source`.

`POST /api/hot/refresh`

- Forces an upstream refresh, rate-limited to once per 30 s.
- Same-origin guard applies.

`GET /catalog-assets/*`

- Serves bundled covers from `catalog/` with path-traversal protection and a long-lived cache header.

### Install pipeline

1. Resolve `source` and `skill` against the current hot data or overrides. The client never supplies a URL.
2. Reject if the same source is already in flight.
3. `planAddSource({ rootDir: libraryRoot }, { input: 'https://github.com/<source>.git' })`.
4. `applyAddSource({ rootDir: libraryRoot }, plan)`.
5. Return the acquisition result. Do not call any enablement function.

The existing staging, validation, collision, and cleanup semantics are reused unchanged. A failed acquisition leaves no half-installed source.

Concurrency:

- Deduplicate by resolved source id.
- Allow at most two concurrent acquisitions.
- No server-side timeout. The client shows progress; a later refresh reconciles the actual state.

After success, refresh `/api/state` and `/api/hot/skill`.

### SKILL.md rendering

SKILL.md is untrusted content. The detail page must:

- Escape all HTML and never render raw HTML from the file.
- Render a safe Markdown subset: headings, paragraphs, lists, inline code, fenced code blocks, emphasis, and HTTPS links.
- Reject `javascript:`, `data:`, and other non-HTTPS links.
- Not load remote images; render alt text or a placeholder.
- Cap rendered content (for example 20,000 characters) with `展开全文`.
- Label the section: `内容来自来源，Skillcaddy 不执行它`.

A small local renderer is preferred over adding a Markdown dependency. If a library is used, it must escape HTML, disable raw HTML and images, and pass through a sanitizer.

## Security

### Request origin

Add a shared guard for all `POST` endpoints:

- If `Origin` is present, it must match the server's own `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- If `Sec-Fetch-Site` is present, it must be `same-origin` or `none`.
- Reject `Origin: null`.
- Require `Content-Type: application/json` for JSON bodies.

Requests without `Origin` (CLI, tests, curl) remain allowed. This blocks a malicious website from driving the local server through the browser.

### Upstream fetching

- Only fixed upstream URLs; no user-supplied URL reaches the fetcher.
- 5 s timeout, 2 MB response cap, `text/html` content type check.
- Parse only the embedded JSON; no `eval`, no script execution.
- Respect `429`/`Retry-After`; serve stale data instead of hammering.
- The browser never contacts the upstream directly.

### Install allowlist

- The Web UI can only install a source present in the current hot data or overrides.
- The source must be a GitHub `owner/repo`; the server constructs the URL.
- Non-GitHub sources are visible but not installable in this scope.
- This prevents the Web surface from becoming a drive-by clone or SSRF primitive.

### Trust boundaries

- Acquisition still runs the full source validation path; hot-list presence never skips it.
- Fetched content is never executed.
- No enablement links are created, so an acquired source cannot affect any project until the user explicitly enables it.
- SKILL.md is rendered as untrusted text.
- No telemetry, no remote images, no third-party runtime calls from the browser.

### Limits

- Maximum two concurrent acquisitions.
- Forced refresh once per 30 s.
- Catalog metadata limits: description ≤ 280 characters, at most 5 tags.
- Cover assets are size-capped and served with path-traversal protection.
- Snapshot retention is bounded (7 days hourly, 90 days daily).

## Implementation plan

1. `lib/hot/skillsShProvider.js` — fetch and parse the three leaderboard pages; fixture tests.
2. `lib/hot/hotRanking.js` — window computation, snapshot deltas, fallbacks, rank changes.
3. `lib/hot/snapshotStore.js` — atomic writes, retention, `firstSeen`, prune.
4. `lib/hot/hotCache.js` — TTL cache, stale serving, 429 handling.
5. `lib/hot/hotMetadata.js` — overrides merge, categories, covers, stars.
6. `lib/catalog.js` — installed detection and install pipeline.
7. `lib/hot/skillPreview.js` — safe local SKILL.md read/render.
8. `server.js` — `/api/hot`, `/api/hot/skill`, `/api/hot/install`, `/api/hot/refresh`, cover assets, origin guard.
9. `public/index.html` — top nav (`已安装` / `热门`), Hot container, detail container; keep the existing workspace markup.
10. `public/hotUi.js` — Hot and detail rendering, separate from the large `app.js`.
11. `public/app.js` — view routing, hot state, polling, install action, back/forward handling.
12. `public/hot.css` — category bar, cards, covers, detail layout, sidebar, skeletons.
13. `catalog/overrides.json`, `catalog/covers/`, `catalog/hot-fallback.json`.
14. `package.json` — add `catalog/` to `files`; add hot tests to the test script.
15. `test/hotProvider.test.js`, `test/hotRanking.test.js`, `test/hotCache.test.js`, `test/hotApi.test.js`, `test/publicUi.test.js`.
16. Docs: `CONTEXT.md` terms, `README.md` / `README_CN.md`, `CHANGELOG.md`.
17. Verify `npm pack --dry-run` includes the catalog and covers and keeps the package size reasonable.

## Acceptance criteria

- The top bar shows exactly one new tab, `热门`; clicking it switches to the Hot page, and `已安装` remains the default.
- The Hot page defaults to 24 小时 and shows category counts, search, cards, and a visible update time.
- The window selector supports 24 小时, 7 天, 30 天, 8 周, 全部, and 自定义 N 天; a fallback window is labeled when history is insufficient.
- Cards rank by window install growth and show a real metric; no number is fabricated.
- A card opens the detail page; browser back returns to the Hot page with the previous window, category, search, and scroll position.
- The detail page shows title, category, source, summary, skills, real metrics, and validation state.
- The detail page discloses that adding a skill adds the whole containing source.
- `POST /api/hot/install` adds the source to the library and creates no project, global, Hermes, or Claude link.
- Adding an already-installed source returns `already-installed` and changes nothing.
- Non-GitHub sources show `暂不支持一键添加` and cannot be installed through the API.
- Installed detection is correct for HTTPS, SSH, `.git`, and tree URL variants.
- Installed sources show a rendered SKILL.md preview; not-installed entries show a placeholder and never fetch upstream from the browser.
- Upstream failure serves the last good cache or the bundled snapshot, labeled accordingly; `已安装` stays fully functional.
- A foreign-origin POST returns 403 and produces no filesystem change.
- `npm test` passes, including provider parsing, window computation, cache fallback, and install allowlisting.
- `npm pack --dry-run` includes `catalog/` and keeps the package size reasonable.

## Phases

**MVP**

- `热门` tab and Hot page.
- skills.sh provider for 24h, 7d, 30d, 8w, all, and custom windows via snapshots.
- In-memory cache, snapshot store, bundled fallback.
- Category counts, search, cover fallback.
- Detail page, source-granular install, installed detection.
- Safe local SKILL.md preview.
- Origin guard and install allowlist.

**Phase 1.5**

- Lazy GitHub SKILL.md fetch for not-installed entries, cached and size-capped.
- Skill-level related recommendations.
- Rank-change indicators (`↑ 3`, `↓ 2`, `NEW`) from snapshot history.
- More curated covers and descriptions.

**Phase 2**

- Self-hosted or authorized leaderboard provider.
- "Update available" on installed sources, reusing the source upgrade path.
- Curated collections and featured rows.
- Optional well-known endpoint acquisition for non-GitHub sources.

**Not planned**

- Arbitrary URL install from the Web UI.
- Auto-enable.
- Ratings, comments, accounts.
- Fabricated security audits.
- Per-skill partial installation.
- Remote cover images.

## Open decisions

1. **Live source.** Recommendation: skills.sh as the default provider, isolated behind an adapter, with `SKILLCADDY_HOT_SOURCE=off` and a bundled snapshot fallback. A self-hosted aggregator can replace it without touching the UI.
2. **Custom windows.** Recommendation: local snapshots for arbitrary `N` days, with a labeled fallback until enough history exists.
3. **Metadata enrichment.** Recommendation: curated `overrides.json` for descriptions, categories, covers, and stars; lazy GitHub star lookup only on the detail page.
4. **SKILL.md before install.** Recommendation: placeholder in the MVP; lazy GitHub fetch in phase 1.5.

## Risks

- **Upstream fragility.** The leaderboard is server-rendered HTML with an embedded payload, not a public API. Isolate the parser, test it with fixtures, and keep the fallback path.
- **Upstream terms and load.** Confirm the site's terms before shipping live fetching; cache aggressively, identify the client, and provide an off switch.
- **Metadata gaps.** The leaderboard has no descriptions, categories, or covers. Without overrides, the long tail looks generic; the UI must degrade gracefully, not invent data.
- **Skill-level expectations.** Users may expect a skill entry to install only that skill. The detail page and button label must disclose source-granular acquisition.
- **Snapshot history.** Custom windows need history. Label the fallback instead of silently showing a different window.
- **Markdown XSS.** SKILL.md is untrusted. Escaping, a safe subset, and no raw HTML are mandatory.
- **Cover licensing and size.** Only original or licensed artwork; cap file sizes and verify at build time.
- **Stale data.** "实时" is bounded by the upstream cadence and the 60 s cache. The visible timestamp is the honest signal.
- **Non-GitHub sources.** Many leaderboard entries are site-hosted. They can be shown but not installed until an adapter exists; do not fake support.
- **Web write surface.** Origin checks and the install allowlist are mandatory.
- **Terminology drift.** UI `已安装` must not leak into code as `install`; the domain term remains source acquisition.
