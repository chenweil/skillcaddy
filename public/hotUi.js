/**
 * Hot page and detail page rendering.
 *
 * Kept out of `app.js` on purpose: the existing library workspace is large and
 * unrelated, and this surface owns its own state, its own polling, and its own
 * DOM. `app.js` only decides which view is active and pushes history entries.
 *
 * Security notes, because both inputs are untrusted:
 *   - SKILL.md is rendered by building DOM nodes. `innerHTML` is never used, so
 *     there is no path from file content to script execution.
 *   - Links inside SKILL.md must be `https:`; anything else renders as text.
 *   - Cover URLs come from the curated overrides file; a failing image falls
 *     back to a deterministic gradient, never a broken image.
 */

const WINDOWS = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: '8w', label: '8 周' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' }
];

const POLL_INTERVAL_LONG_MS = 300_000;
const POLL_INTERVAL_SHORT_MS = 60_000;
const SKILLMD_COLLAPSE_CHARS = 1200;
/** 超过这个数量就不再整块铺开，改成限高滚动。 */
const SKILL_LIST_SCROLL_THRESHOLD = 8;
/** 超过这个数量额外给一个来源内筛选框。 */
const SKILL_FILTER_THRESHOLD = 12;

export function createHotView({ onNavigate = () => {}, onReplace = () => {} } = {}) {
  const root = document.querySelector('#hotView');
  if (!root) throw new Error('Hot view root is missing');

  const els = {
    ranking: root.querySelector('#hotRanking'),
    detail: root.querySelector('#hotDetail'),
    categories: root.querySelector('#hotCategories'),
    grid: root.querySelector('#hotGrid'),
    empty: root.querySelector('#hotEmpty'),
    summary: root.querySelector('#hotSummary'),
    notice: root.querySelector('#hotNotice'),
    windowSelect: root.querySelector('#hotWindow'),
    custom: root.querySelector('#hotCustom'),
    customDays: root.querySelector('#hotCustomDays'),
    customApply: root.querySelector('#hotCustomApply'),
    search: root.querySelector('#hotSearch'),
    refresh: root.querySelector('#hotRefresh')
  };

  const state = {
    route: null,
    list: null,
    listQuery: null,
    animateCards: false,
    animateMd: false,
    loading: false,
    listError: null,
    detail: null,
    detailState: 'idle',
    switching: null,
    skillsError: null,
    skillQuery: '',
    install: { status: 'idle', message: '' },
    pollTimer: null,
    searchTimer: null
  };

  els.windowSelect.addEventListener('change', () => {
    const value = els.windowSelect.value;
    if (value === 'custom') {
      els.custom.hidden = false;
      els.customDays.focus();
      els.customDays.select();
      return;
    }
    els.custom.hidden = true;
    onNavigate({ window: value, days: null });
  });

  els.customApply.addEventListener('click', () => {
    const days = clampDays(els.customDays.value);
    els.customDays.value = String(days);
    onNavigate({ window: 'custom', days });
  });

  els.customDays.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    els.customApply.click();
  });

  els.search.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      onNavigate({ q: els.search.value.trim() }, { replace: true });
    }, 200);
  });

  els.refresh.addEventListener('click', () => refresh(true));

  // 事件委托：详情页每次局部重渲染都不必重新绑定行内监听。
  els.detail.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-skill-id]');
    if (!row || !els.detail.contains(row)) return;
    selectSkill(row.dataset.skillId);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.route?.view === 'hot' && !isDetailOpen()) {
      loadList({ background: true });
    }
  });

  return {
    async applyRoute(route) {
      state.route = route;
      els.windowSelect.value = route.window;
      els.custom.hidden = route.window !== 'custom';
      if (route.window === 'custom') els.customDays.value = String(route.days || 14);
      els.search.value = route.q || '';

      if (route.source && route.skill) {
        await openDetail(route);
        return;
      }

      closeDetail();
      // 分类和搜索词都在已取回的数据里过滤，不该为每次按键再打一次上游。
      if (loadMatchesRoute(route)) {
        renderList();
      } else {
        await loadList({});
      }
      schedulePoll();
    },

    hide() {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  };

  // ---------- list ----------

  /** 当前缓存的数据是否已经覆盖这个路由的窗口。 */
  function loadMatchesRoute(route) {
    if (!state.list || !state.listQuery) return false;
    return state.listQuery.window === route.window && state.listQuery.days === (route.days || null);
  }

  async function loadList({ background = false } = {}) {
    const route = state.route;
    if (!route || route.view !== 'hot' || isDetailOpen()) return;
    if (state.loading && !background) return;

    state.loading = true;
    state.listError = null;
    if (!background) {
      renderSkeletons();
      renderSummary(null);
    }

    try {
      const params = new URLSearchParams({ window: route.window });
      if (route.window === 'custom') params.set('days', String(route.days || 14));
      const payload = await apiJson(`/api/hot?${params.toString()}`);
      state.list = payload;
      state.listQuery = { window: route.window, days: route.days || null };
      state.listError = null;
      // 后台轮询静默更新，不重播入场动画，否则用户正在读的时候会突然抖一下。
      state.animateCards = !background;
      renderList();
    } catch (error) {
      state.listError = error;
      renderListError(error);
    } finally {
      state.loading = false;
    }
  }

  async function refresh(force) {
    if (!force) {
      await loadList({});
      return;
    }
    els.refresh.disabled = true;
    try {
      await apiJson('/api/hot/refresh', { method: 'POST', body: '{}' });
      await loadList({});
    } catch (error) {
      showNotice(error.message || '刷新失败，先显示已有数据');
    } finally {
      els.refresh.disabled = false;
    }
  }

  function schedulePoll() {
    clearInterval(state.pollTimer);
    const ms = state.route?.window === '24h' ? POLL_INTERVAL_SHORT_MS : POLL_INTERVAL_LONG_MS;
    state.pollTimer = setInterval(() => {
      if (document.hidden || isDetailOpen()) return;
      loadList({ background: true });
    }, ms);
  }

  function renderList() {
    const list = state.list;
    if (!list) return;
    const route = state.route;
    const entries = filterEntries(list.entries, route);
    const query = (route.q || '').toLowerCase();
    const category = route.category || 'all';

    renderCategories(list.categories, category, list.windowTotal ?? list.total);
    renderSummary(list);
    renderNotice(list);

    els.grid.replaceChildren();
    if (entries.length === 0) {
      els.grid.hidden = true;
      renderEmpty({ category, query });
      return;
    }

    els.empty.hidden = true;
    els.empty.replaceChildren();
    els.grid.hidden = false;

    // 入场动画只在换了数据时播一次；筛选项变化时重排不应该再抖一次。
    const animate = state.animateCards;
    state.animateCards = false;

    const fragment = document.createDocumentFragment();
    entries.forEach((entry, index) => {
      const card = renderCard(entry);
      card.style.setProperty('--i', String(Math.min(index, 11)));
      fragment.append(card);
    });
    els.grid.append(fragment);

    els.grid.classList.toggle('is-entering', animate);
    if (animate) {
      setTimeout(() => els.grid.classList.remove('is-entering'), 700);
    }
  }

  function filterEntries(entries, route) {
    const category = route.category || 'all';
    const query = (route.q || '').toLowerCase();
    return entries.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (!query) return true;
      const haystack = [
        entry.displayName,
        entry.name,
        entry.source,
        entry.description,
        entry.author,
        ...(entry.tags || [])
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderCategories(categories, active, totalCount) {
    els.categories.replaceChildren();
    const items = [{ key: 'all', label: '全部', count: totalCount ?? 0 }, ...(categories || [])];
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `hot-chip${item.key === active ? ' is-active' : ''}`;
      button.setAttribute('aria-pressed', String(item.key === active));
      const label = document.createElement('span');
      label.textContent = item.label;
      const count = document.createElement('span');
      count.className = 'hot-chip-count';
      count.textContent = String(item.count);
      button.append(label, count);
      button.addEventListener('click', () => onNavigate({ category: item.key }));
      els.categories.append(button);
    }
  }

  function renderSummary(list) {
    if (!list) {
      els.summary.textContent = '正在读取热门…';
      return;
    }
    els.summary.replaceChildren();
    const count = document.createElement('strong');
    count.textContent = String(list.windowTotal ?? list.total);
    els.summary.append('共 ', count, ` 个热门 · ${list.window.label}`);

    const stamp = document.createElement('span');
    stamp.className = 'hot-summary-meta';
    stamp.textContent = `　更新于 ${formatClock(list.fetchedAt)}`;
    els.summary.append(stamp);

    const source = document.createElement('span');
    source.className = 'hot-summary-meta';
    source.textContent = ' · 数据来源：';
    const link = document.createElement('a');
    link.href = 'https://skills.sh';
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = list.source === 'offline' ? '离线快照' : 'skills.sh';
    source.append(link);
    els.summary.append(source);
  }

  function renderNotice(list) {
    const notes = [];
    if (list.offlineSnapshotAt) notes.push(`离线快照 · ${list.offlineSnapshotAt}`);
    else if (list.stale) notes.push('数据可能已过期');
    if (list.window.note) notes.push(list.window.note);
    if (notes.length === 0) {
      els.notice.hidden = true;
      els.notice.textContent = '';
      return;
    }
    els.notice.hidden = false;
    els.notice.textContent = notes.join(' · ');
  }

  function showNotice(text) {
    els.notice.hidden = false;
    els.notice.textContent = text;
  }

  function renderSkeletons() {
    els.grid.hidden = false;
    els.grid.replaceChildren();
    els.empty.hidden = true;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 8; index += 1) {
      const card = document.createElement('div');
      card.className = 'hot-skeleton';
      const cover = document.createElement('div');
      cover.className = 'hot-skeleton-cover';
      const body = document.createElement('div');
      body.className = 'hot-skeleton-body';
      for (const modifier of ['', 'is-short', '']) {
        const line = document.createElement('div');
        line.className = `hot-skeleton-line${modifier ? ` ${modifier}` : ''}`;
        body.append(line);
      }
      card.append(cover, body);
      fragment.append(card);
    }
    els.grid.append(fragment);
  }

  function renderListError(error) {
    els.grid.hidden = true;
    els.empty.hidden = false;
    els.empty.replaceChildren();
    const message = document.createElement('p');
    message.textContent = error.message || '热门数据读取失败';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary';
    retry.textContent = '重试';
    retry.addEventListener('click', () => loadList({}));
    els.empty.append(message, retry);
    els.summary.textContent = '热门数据读取失败';
  }

  function renderEmpty({ category, query }) {
    els.empty.replaceChildren();
    els.empty.hidden = false;
    const message = document.createElement('p');
    if (query) {
      message.textContent = '没有匹配的热门';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'secondary';
      clear.textContent = '清除筛选';
      clear.addEventListener('click', () => onNavigate({ q: '', category: 'all' }));
      els.empty.append(message, clear);
      return;
    }
    message.textContent = category === 'all' ? '这个窗口还没有热门' : '这个分类还没有热门';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'secondary';
    clear.textContent = '看全部分类';
    clear.addEventListener('click', () => onNavigate({ category: 'all' }));
    els.empty.append(message, clear);
  }

  function renderCard(entry) {
    const card = document.createElement('a');
    card.className = 'hot-card';
    card.href = detailHref(entry);
    card.setAttribute('aria-label', `${entry.displayName}，第 ${entry.rank} 名`);
    card.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      onNavigate({ source: entry.source, skill: entry.skillId });
    });

    card.append(renderCover(entry), renderCardBody(entry));
    return card;
  }

  function renderCover(entry) {
    const cover = document.createElement('div');
    cover.className = 'hot-cover';

    if (entry.cover) {
      const img = document.createElement('img');
      img.src = entry.cover;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        cover.replaceChildren(fallbackCover(entry));
      }, { once: true });
      cover.append(img);
    } else {
      cover.append(fallbackCover(entry));
    }

    const rank = document.createElement('span');
    rank.className = 'hot-rank';
    rank.textContent = `#${entry.rank}`;
    cover.append(rank);
    return cover;
  }

  function fallbackCover(entry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'hot-cover-fallback';
    const [a, b] = gradientFor(entry.id || entry.source);
    wrapper.style.setProperty('--cover-a', a);
    wrapper.style.setProperty('--cover-b', b);

    const monogram = document.createElement('span');
    monogram.className = 'hot-cover-monogram';
    monogram.textContent = firstGlyph(entry.displayName || entry.name || '?');

    const category = document.createElement('span');
    category.className = 'hot-cover-category';
    category.textContent = entry.categoryLabel || '';

    wrapper.append(monogram, category);
    return wrapper;
  }

  function renderCardBody(entry) {
    const body = document.createElement('div');
    body.className = 'hot-card-body';

    const title = document.createElement('h3');
    title.className = 'hot-card-title';
    const titleText = document.createElement('span');
    titleText.textContent = entry.displayName;
    title.append(titleText);
    if (entry.verified) {
      const check = document.createElement('span');
      check.className = 'hot-verified';
      check.textContent = '✓';
      check.title = '维护者已审核该来源';
      title.append(check);
    }

    const desc = document.createElement('p');
    desc.className = 'hot-card-desc';
    desc.textContent = entry.description;

    const foot = document.createElement('div');
    foot.className = 'hot-card-foot';
    const source = document.createElement('span');
    source.className = 'hot-card-source';
    source.textContent = entry.source;
    source.title = entry.source;

    const metrics = document.createElement('span');
    metrics.className = 'hot-card-growth hot-growth-window';
    if (state.list?.window?.actual === 'all') {
      metrics.textContent = formatCount(entry.installs);
      metrics.title = '累计安装';
    } else {
      metrics.textContent = `+${formatCount(entry.windowInstalls)}`;
      metrics.title = '当前窗口新增安装';
    }

    foot.append(source, metrics);
    body.append(title, desc, foot);

    if (entry.installed) {
      const pill = document.createElement('span');
      pill.className = 'hot-installed-pill';
      pill.textContent = '已安装';
      title.append(pill);
    }
    return body;
  }

  function detailHref(entry) {
    const params = new URLSearchParams({
      view: 'hot',
      window: state.route?.window || '24h',
      source: entry.source,
      skill: entry.skillId
    });
    if (state.route?.window === 'custom') params.set('days', String(state.route.days || 14));
    if (state.route?.category && state.route.category !== 'all') params.set('category', state.route.category);
    if (state.route?.q) params.set('q', state.route.q);
    return `?${params.toString()}`;
  }

  // ---------- detail ----------

  function isDetailOpen() {
    return Boolean(state.route?.source && state.route?.skill);
  }

  function closeDetail() {
    els.detail.hidden = true;
    els.detail.replaceChildren();
    els.ranking.hidden = false;
    state.detail = null;
    state.detailState = 'idle';
    state.switching = null;
    state.skillsError = null;
    state.skillQuery = '';
    state.install = { status: 'idle', message: '' };
  }

  async function openDetail(route) {
    els.ranking.hidden = true;
    els.detail.hidden = false;
    clearInterval(state.pollTimer);
    state.detailState = 'loading';
    state.switching = null;
    state.skillsError = null;
    state.skillQuery = '';
    state.install = { status: 'idle', message: '' };
    els.detail.replaceChildren(renderDetailSkeleton());

    const params = new URLSearchParams({ source: route.source, skill: route.skill });
    if (route.window) params.set('window', route.window);
    if (route.window === 'custom') params.set('days', String(route.days || 14));

    try {
      state.detail = await apiJson(`/api/hot/skill?${params.toString()}`);
      state.detailState = 'ready';
      state.install = state.detail.installed
        ? { status: 'installed', message: '' }
        : { status: 'idle', message: '' };
      renderDetail();
    } catch (error) {
      state.detailState = 'error';
      els.detail.replaceChildren(renderDetailError(error));
    }
  }

  function renderDetailSkeleton() {
    const wrapper = document.createElement('div');
    wrapper.className = 'hot-detail-main';
    for (let index = 0; index < 3; index += 1) {
      const block = document.createElement('div');
      block.className = 'hot-skeleton';
      const cover = document.createElement('div');
      cover.className = 'hot-skeleton-cover';
      cover.style.aspectRatio = '40 / 9';
      block.append(cover);
      wrapper.append(block);
    }
    return wrapper;
  }

  function renderDetailError(error) {
    const wrapper = document.createElement('div');
    wrapper.className = 'hot-empty';
    const message = document.createElement('p');
    message.textContent = error.message || '详情读取失败';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'secondary';
    back.textContent = '返回热门';
    back.addEventListener('click', () => onNavigate({ source: '', skill: '' }));
    wrapper.append(message, back);
    return wrapper;
  }

  function renderDetail() {
    const detail = state.detail;
    const entry = detail.entry;

    els.detail.replaceChildren();
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'hot-back';
    back.textContent = '← 热门';
    back.addEventListener('click', () => onNavigate({ source: '', skill: '' }));

    const head = document.createElement('div');
    head.className = 'hot-detail-head';
    const title = document.createElement('h2');
    title.className = 'hot-detail-title';
    title.textContent = entry.displayName;
    if (entry.verified) {
      const check = document.createElement('span');
      check.className = 'hot-verified';
      check.textContent = '✓';
      check.title = '维护者已审核该来源';
      title.append(' ', check);
    }
    const category = document.createElement('span');
    category.className = 'hot-detail-category';
    category.textContent = entry.categoryLabel;
    head.append(title, category);

    const byline = document.createElement('p');
    byline.className = 'hot-detail-byline';
    byline.append('by ');
    const sourceLink = document.createElement('a');
    sourceLink.href = entry.homepage || detail.sourceUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noreferrer noopener';
    sourceLink.textContent = entry.source;
    byline.append(sourceLink);

    const grid = document.createElement('div');
    grid.className = 'hot-detail-grid';
    const main = document.createElement('div');
    main.className = 'hot-detail-main';
    main.append(
      renderInstallSection(detail),
      renderSection('SUMMARY', [summaryText(entry)]),
      renderSkillsSection(detail),
      renderSkillMdSection(detail),
      renderRelatedSection(detail)
    );

    grid.append(main, renderSidebar(detail));
    els.detail.append(back, head, byline, grid);
    // 首屏渲染时列表还没进 DOM，尺寸全为 0：挂载后再把「当前」行滚进视口。
    syncSkillListScroll();
  }

  function syncSkillListScroll() {
    const list = els.detail.querySelector('.detail-skills.is-scrollable');
    if (!list) return;
    const current = list.querySelector('.is-current');
    if (!current) return;
    const delta = current.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = Math.max(0, list.scrollTop + delta - 6);
  }

  function renderInstallSection(detail) {
    const section = document.createElement('section');
    section.className = 'detail-section';
    section.append(sectionTitle('INSTALLATION'));

    const block = document.createElement('div');
    block.className = 'install-block';
    const actions = document.createElement('div');
    actions.className = 'install-actions';

    const primary = document.createElement('button');
    primary.type = 'button';
    primary.textContent = detail.installed ? '已加入原件库' : '添加到原件库';
    primary.disabled = detail.installed || !detail.entry.installable || state.install.status === 'installing';
    if (!detail.entry.installable) {
      primary.textContent = '暂不支持一键添加';
      primary.title = 'Skillcaddy 目前只能按 Git 来源获取';
    }
    primary.addEventListener('click', () => install(detail));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = '复制来源地址';
    copy.disabled = !detail.repositoryUrl;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(detail.repositoryUrl);
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制来源地址'; }, 1600);
      } catch {
        copy.textContent = '复制失败';
        setTimeout(() => { copy.textContent = '复制来源地址'; }, 1600);
      }
    });

    actions.append(primary, copy);
    block.append(actions);

    const disclosure = document.createElement('p');
    disclosure.className = 'detail-note';
    const count = detail.skills?.length || 0;
    disclosure.textContent = detail.entry.installable
      ? `添加会加入整个来源${count ? `（${count} 个 skill）` : ''}，不会创建任何项目或全局启用链接。`
      : '该来源不在 GitHub 上，Skillcaddy 的获取适配器暂不覆盖它的下载方式。';
    block.append(disclosure);

    if (state.install.message) {
      const line = document.createElement('p');
      line.className = state.install.status === 'error' ? 'install-error' : 'install-status';
      line.textContent = state.install.message;
      block.append(line);
    }

    if (detail.installed) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'secondary';
      view.textContent = '在已安装里查看';
      view.addEventListener('click', () => {
        sessionStorage.setItem('skillcaddy.pendingSearch', detail.entry.source);
        onNavigate({ view: 'installed', source: '', skill: '', q: '' });
      });
      block.append(view);
    }

    section.append(block);
    return section;
  }

  async function install(detail) {
    if (state.install.status === 'installing') return;
    const source = detail.entry.source;
    state.install = { status: 'installing', message: '正在获取来源，可能需要一会儿…' };
    renderDetail();

    try {
      const result = await apiJson('/api/hot/install', {
        method: 'POST',
        body: JSON.stringify({ source, skill: detail.entry.skillId })
      });
      state.install = {
        status: 'installed',
        message: result.status === 'already-installed'
          ? '该来源已在原件库中，未做改动。'
          : `已加入原件库：${result.sourceId}。启用仍需手动操作。`
      };
      detail.installed = true;
      detail.installedSourceId = result.sourceId || detail.installedSourceId;
      detail.entry.installed = true;
      renderDetail();
    } catch (error) {
      state.install = { status: 'error', message: error.message || '获取失败', retry: true };
      renderDetail();
    }
  }

  function renderSkillsSection(detail) {
    const skills = detail.skills || [];
    const section = document.createElement('section');
    section.className = 'detail-section';
    section.append(sectionTitle(`SKILLS IN THIS SOURCE (${skills.length})`));

    if (skills.length === 0) {
      const note = document.createElement('p');
      note.className = 'detail-note';
      note.textContent = '上游排行榜里没有同一来源的其他条目。';
      section.append(note);
      return section;
    }

    // 大来源（几十个 skill）整块铺开会把 SKILL.MD 顶到很远，所以超过阈值就
    // 限高滚动；再多给一个就地过滤框，按名字/描述筛选。
    const scrollable = skills.length > SKILL_LIST_SCROLL_THRESHOLD;

    let filterInput = null;
    if (skills.length > SKILL_FILTER_THRESHOLD) {
      const filter = document.createElement('label');
      filter.className = 'detail-skills-filter';
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = '在该来源内筛选 skill';
      filterInput = document.createElement('input');
      filterInput.type = 'search';
      filterInput.placeholder = `在 ${skills.length} 个 skill 里筛选…`;
      filterInput.value = state.skillQuery;
      filterInput.autocomplete = 'off';
      filter.append(label, filterInput);
      section.append(filter);
    }

    const list = document.createElement('ul');
    list.className = `detail-skills${scrollable ? ' is-scrollable' : ''}`;
    section.append(list);

    const empty = document.createElement('p');
    empty.className = 'detail-note detail-skills-empty';
    empty.textContent = '没有匹配的 skill';
    empty.hidden = true;
    section.append(empty);

    const paint = () => {
      const query = state.skillQuery;
      const visible = query
        ? skills.filter((skill) => `${skill.name} ${skill.description || ''}`.toLowerCase().includes(query))
        : skills;

      list.replaceChildren();
      for (const skill of visible) list.append(renderSkillRow(skill));
      empty.hidden = visible.length > 0;

      // 让「当前」那一行在滚动框里可见，但不动页面滚动位置。
      if (scrollable && visible.length > 0) {
        const current = list.querySelector('.is-current');
        if (current) {
          const delta = current.getBoundingClientRect().top - list.getBoundingClientRect().top;
          list.scrollTop = Math.max(0, list.scrollTop + delta - 6);
        }
      }
    };

    paint();

    if (filterInput) {
      filterInput.addEventListener('input', () => {
        state.skillQuery = filterInput.value.trim().toLowerCase();
        paint();
      });
    }

    if (state.skillsError) {
      const error = document.createElement('p');
      error.className = 'install-error';
      error.textContent = state.skillsError;
      section.append(error);
    }

    return section;
  }

  function renderSkillRow(skill) {
    const item = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `detail-skill-row${skill.current ? ' is-current' : ''}${state.switching === skill.skillId ? ' is-busy' : ''}`;
    row.dataset.skillId = skill.skillId;
    if (skill.current) row.setAttribute('aria-current', 'true');
    row.title = skill.current ? '当前展示的 skill' : `在下方切换到 ${skill.name}`;

    const name = document.createElement('span');
    name.className = 'detail-skill-name';
    name.textContent = skill.name;
    const desc = document.createElement('span');
    desc.className = 'detail-skill-desc';
    desc.textContent = skill.description || '';
    row.append(name, desc);

    if (skill.current) {
      const marker = document.createElement('span');
      marker.className = 'detail-skill-current';
      marker.textContent = '当前';
      row.append(marker);
    } else {
      const chevron = document.createElement('span');
      chevron.className = 'detail-skill-chevron';
      chevron.textContent = state.switching === skill.skillId ? '读取中…' : '›';
      row.append(chevron);
    }

    item.append(row);
    return item;
  }

  /**
   * Switch the displayed skill in place.
   *
   * The old flow pushed a new route and re-rendered the whole page, which left
   * the reader parked inside a SKILL.md panel with no visible change. This
   * keeps the scroll position, marks the selected row, and names the skill in
   * the SKILL.MD heading so the swap is unmistakable.
   */
  async function selectSkill(skillId) {
    const detail = state.detail;
    if (!detail || state.detailState !== 'ready' || state.switching) return;
    if (!skillId || skillId === detail.entry.skillId) return;

    state.switching = skillId;
    state.skillsError = null;
    renderDetail();

    const scrollY = window.scrollY;
    const params = new URLSearchParams({ source: detail.entry.source, skill: skillId });
    if (state.route?.window) params.set('window', state.route.window);
    if (state.route?.window === 'custom') params.set('days', String(state.route.days || 14));

    try {
      const next = await apiJson(`/api/hot/skill?${params.toString()}`);
      state.detail = next;
      state.switching = null;
      state.animateMd = true;
      state.install = next.installed
        ? { status: 'installed', message: '' }
        : { status: 'idle', message: '' };
      renderDetail();
      window.scrollTo(0, scrollY);
      revealSkillMd();
      onReplace({ source: next.entry.source, skill: next.entry.skillId });
    } catch (error) {
      state.switching = null;
      state.skillsError = error.message || '读取该 skill 失败';
      renderDetail();
      window.scrollTo(0, scrollY);
    }
  }

  function revealSkillMd() {
    const target = els.detail.querySelector('[data-skillmd]');
    target?.scrollIntoView({ block: 'nearest' });
  }

  function renderSkillMdSection(detail) {
    const section = document.createElement('section');
    section.className = 'detail-section';
    section.dataset.skillmd = 'true';
    // 标题带上 skill 名：局部切换后，面板自己说明正在看哪个 skill。
    section.append(sectionTitle(`SKILL.MD · ${detail.entry.skillId}`));

    const preview = detail.skillMd || { available: false };
    if (!preview.available) {
      const placeholder = document.createElement('div');
      placeholder.className = 'skillmd-placeholder';
      placeholder.textContent = '安装后可查看完整 SKILL.md；已安装来源直接读取本地文件。';
      section.append(placeholder);
      return section;
    }

    const article = document.createElement('article');
    article.className = 'skillmd';
    if (state.animateMd) {
      article.classList.add('is-swapping');
      state.animateMd = false;
    }
    renderMarkdown(article, preview.content || '');
    if (preview.truncated || (preview.content || '').length > SKILLMD_COLLAPSE_CHARS) {
      article.classList.add('is-collapsed');
    }
    section.append(article);

    if (article.classList.contains('is-collapsed')) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'secondary skillmd-more';
      more.textContent = '展开全文';
      more.addEventListener('click', () => {
        const collapsed = article.classList.toggle('is-collapsed');
        more.textContent = collapsed ? '展开全文' : '收起';
      });
      section.append(more);
    }

    const note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = '内容来自来源，Skillcaddy 不执行它。';
    section.append(note);
    return section;
  }

  function renderRelatedSection(detail) {
    const related = detail.related || [];
    if (related.length === 0) return document.createDocumentFragment();

    const section = document.createElement('section');
    section.className = 'detail-section';
    section.append(sectionTitle('RELATED'));

    const list = document.createElement('div');
    list.className = 'related-list';
    for (const item of related) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'related-item';
      const name = document.createElement('span');
      name.className = 'related-item-name';
      name.textContent = item.displayName;
      const meta = document.createElement('span');
      meta.className = 'related-item-meta';
      meta.textContent = `${item.source} · +${formatCount(item.windowInstalls)}`;
      button.append(name, meta);
      button.addEventListener('click', () => onNavigate({ source: item.source, skill: item.skillId }));
      list.append(button);
    }
    section.append(list);
    return section;
  }

  function renderSidebar(detail) {
    const entry = detail.entry;
    const aside = document.createElement('aside');
    aside.className = 'hot-detail-side';

    const status = document.createElement('div');
    status.className = 'side-status';
    const statusLabel = document.createElement('span');
    statusLabel.className = 'side-status-label';
    statusLabel.textContent = '状态';
    const statusValue = document.createElement('span');
    statusValue.className = `side-status-value${detail.installed ? ' is-installed' : ''}`;
    statusValue.textContent = state.install.status === 'installing'
      ? '添加中…'
      : detail.installed ? '已安装' : '未安装';
    status.append(statusLabel, statusValue);

    const list = document.createElement('dl');
    list.className = 'meta-list';
    const growthLabel = `${detail.window?.label || '24 小时'}新增`;
    const rows = [
      ['来源类型', detail.sourceTypeLabel],
      ['仓库', entry.source],
      ['Stars', entry.stars === null ? null : `${formatCount(entry.stars)}${entry.starsCapturedAt ? `（截至 ${entry.starsCapturedAt}）` : ''}`],
      // 「全部」窗口的窗口值就是累计值，重复展示没有意义。
      [growthLabel, detail.window?.actual === 'all' || entry.windowInstalls === null ? null : `+${formatCount(entry.windowInstalls)}`],
      ['累计安装', formatCount(entry.installs)],
      ['收录于', detail.firstSeen ? detail.firstSeen.slice(0, 10) : null],
      ['来源审核', detail.validation.sourceReview],
      ['格式校验', detail.validation.formatCheck],
      ['内容执行', detail.validation.execution],
      ['完整性', detail.validation.integrity]
    ];
    for (const [key, value] of rows) {
      if (value === null || value === undefined || value === '') continue;
      const row = document.createElement('div');
      row.className = 'meta-row';
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      row.append(dt, dd);
      list.append(row);
    }

    aside.append(status, list);

    if (detail.stale) {
      const divider = document.createElement('div');
      divider.className = 'side-divider';
      const note = document.createElement('p');
      note.className = 'detail-note';
      note.textContent = '上游数据可能已过期。';
      aside.append(divider, note);
    }
    return aside;
  }

  function summaryText(entry) {
    return entry.description;
  }

  // ---------- markdown ----------

  function renderMarkdown(container, text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      if (line.trim().startsWith('```')) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = codeLines.join('\n');
        pre.append(code);
        container.append(pre);
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        const element = document.createElement(`h${heading[1].length}`);
        renderInline(element, heading[2]);
        container.append(element);
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^>\s?/, ''));
          index += 1;
        }
        const quote = document.createElement('blockquote');
        renderInline(quote, quoteLines.join(' '));
        container.append(quote);
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        const list = document.createElement('ul');
        while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
          const item = document.createElement('li');
          renderInline(item, lines[index].replace(/^[-*]\s+/, ''));
          list.append(item);
          index += 1;
        }
        container.append(list);
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const list = document.createElement('ol');
        while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
          const item = document.createElement('li');
          renderInline(item, lines[index].replace(/^\d+\.\s+/, ''));
          list.append(item);
          index += 1;
        }
        container.append(list);
        continue;
      }

      const paragraphLines = [];
      while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|[-*]\s|\d+\.\s|>|```)/.test(lines[index])) {
        paragraphLines.push(lines[index].trim());
        index += 1;
      }
      const paragraph = document.createElement('p');
      renderInline(paragraph, paragraphLines.join(' '));
      container.append(paragraph);
    }
  }

  function renderInline(target, text) {
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        target.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      if (match[1]) {
        const code = document.createElement('code');
        code.textContent = match[1].slice(1, -1);
        target.append(code);
      } else if (match[2]) {
        const strong = document.createElement('strong');
        strong.textContent = match[2].slice(2, -2);
        target.append(strong);
      } else if (match[3]) {
        const em = document.createElement('em');
        em.textContent = match[3].slice(1, -1);
        target.append(em);
      } else if (match[4] && match[5]) {
        const link = document.createElement('a');
        link.href = match[5];
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.textContent = match[4];
        target.append(link);
      }
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
      target.append(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function sectionTitle(text) {
    const title = document.createElement('h3');
    title.className = 'detail-section-title';
    title.textContent = text;
    return title;
  }

  function renderSection(titleText, nodes) {
    const section = document.createElement('section');
    section.className = 'detail-section';
    section.append(sectionTitle(titleText));
    for (const node of nodes) section.append(node);
    return section;
  }
}

// ---------- helpers ----------

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.code = payload?.code || null;
    throw error;
  }
  return payload;
}

function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trimZero((value / 1000).toFixed(1))}k`;
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

function trimZero(text) {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

function formatClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function clampDays(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 14;
  return Math.min(90, Math.max(1, parsed));
}

function firstGlyph(text) {
  const clean = String(text || '').trim();
  return clean ? [...clean][0].toUpperCase() : '?';
}

/** 固定调色板：随机色相会撞出橄榄绿一类的脏色，这里按 key 哈希取一组。 */
const COVER_PALETTE = [
  ['#2f70fd', '#08122c'],
  ['#1f9d8f', '#06302c'],
  ['#7a5cf0', '#241a4d'],
  ['#e0623f', '#3d1508'],
  ['#2b8a5f', '#08281a'],
  ['#c94a7a', '#3a0f24'],
  ['#3f6fd8', '#101f3f'],
  ['#8a6a2f', '#2a1d06'],
  ['#4aa3c7', '#072430'],
  ['#6d4fa8', '#1d1430']
];

/** Deterministic gradient: the same key always gets the same cover colours. */
function gradientFor(key) {
  let hash = 0;
  for (const char of String(key || '')) {
    hash = (hash * 31 + char.codePointAt(0)) % 100_003;
  }
  return COVER_PALETTE[hash % COVER_PALETTE.length];
}

export { formatCount, formatClock, gradientFor };
