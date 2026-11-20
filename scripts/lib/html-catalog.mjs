/**
 * Generates a self-contained, zero-dependency, deterministic static HTML catalog
 * (`site/index.html`) from a validated Format 1 DSH plugin market index.
 */

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function pickText(localized, lang = 'zh') {
  if (typeof localized === 'string') return localized
  if (!localized || typeof localized !== 'object') return ''
  return localized[lang] ?? localized.en ?? Object.values(localized)[0] ?? ''
}

/**
 * Render the static catalog page HTML. Deterministic for identical `index` inputs.
 */
export function renderCatalogHtml(index) {
  const titleZh = pickText(index.title, 'zh')
  const titleEn = pickText(index.title, 'en')
  const descZh = pickText(index.description, 'zh')
  const latestTimestamp = index.plugins.reduce(
    (max, plugin) => Math.max(max, plugin.versions[0]?.publishTimestamp ?? 0),
    0,
  )
  const totalVersions = index.plugins.reduce((sum, p) => sum + p.versions.length, 0)
  const payload = {
    index,
    stats: {
      pluginCount: index.plugins.length,
      versionCount: totalVersions,
      latestTimestamp,
    },
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(titleZh || titleEn)}</title>
  <meta name="description" content="${escapeHtml(descZh)}" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f8fafc;
      --bg-elev: #ffffff;
      --bg-subtle: #f1f5f9;
      --text: #0f172a;
      --text-muted: #475569;
      --border: #e2e8f0;
      --accent: #2563eb;
      --accent-soft: rgba(37, 99, 235, 0.1);
      --accent-text: #1d4ed8;
      --ok: #15803d;
      --ok-soft: rgba(21, 128, 61, 0.1);
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 4px 16px rgba(15, 23, 42, 0.04);
      --radius: 14px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1120;
        --bg-elev: #111827;
        --bg-subtle: #1e293b;
        --text: #f1f5f9;
        --text-muted: #94a3b8;
        --border: #243044;
        --accent: #60a5fa;
        --accent-soft: rgba(96, 165, 250, 0.14);
        --accent-text: #93c5fd;
        --ok: #4ade80;
        --ok-soft: rgba(74, 222, 128, 0.14);
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.25);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px 20px 64px;
    }
    header {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
    }
    .header-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .title-group h1 {
      margin: 0;
      font-size: clamp(1.5rem, 3vw, 2rem);
      letter-spacing: -0.02em;
      line-height: 1.25;
    }
    .title-group p {
      margin: 8px 0 0;
      color: var(--text-muted);
      max-width: 720px;
      font-size: 0.96rem;
    }
    .lang-toggle {
      display: inline-flex;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px;
      gap: 2px;
    }
    .lang-toggle button {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font: inherit;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 999px;
      cursor: pointer;
    }
    .lang-toggle button.active {
      background: var(--bg-elev);
      color: var(--text);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }
    .index-box {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .index-row {
      display: flex;
      gap: 10px;
      align-items: stretch;
      flex-wrap: wrap;
    }
    .index-url {
      flex: 1 1 320px;
      font-family: var(--mono);
      font-size: 0.88rem;
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg-subtle);
      color: var(--text);
      overflow-x: auto;
      white-space: nowrap;
      display: flex;
      align-items: center;
    }
    .btn {
      border: 1px solid var(--border);
      background: var(--bg-elev);
      color: var(--text);
      font: inherit;
      font-size: 0.88rem;
      font-weight: 600;
      padding: 9px 16px;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      transition: transform 0.08s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .btn:hover { border-color: var(--accent); }
    .btn:active { transform: translateY(1px); }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .btn-primary:hover { filter: brightness(1.06); border-color: var(--accent); }
    .btn-copied {
      background: var(--ok);
      border-color: var(--ok);
      color: #ffffff;
    }
    .guide-line {
      font-size: 0.85rem;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      align-items: center;
    }
    .guide-line code {
      font-family: var(--mono);
      font-size: 0.82rem;
      background: var(--bg-subtle);
      padding: 2px 6px;
      border-radius: 6px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      margin: 24px 0 18px;
    }
    .categories {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pill {
      border: 1px solid var(--border);
      background: var(--bg-elev);
      color: var(--text-muted);
      font: inherit;
      font-size: 0.85rem;
      font-weight: 500;
      padding: 6px 13px;
      border-radius: 999px;
      cursor: pointer;
    }
    .pill.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
    .search-sort {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      flex: 0 1 auto;
    }
    .search-input, .sort-select {
      font: inherit;
      font-size: 0.88rem;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg-elev);
      color: var(--text);
    }
    .search-input { min-width: 220px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .card-head {
      display: flex;
      gap: 14px;
      align-items: flex-start;
    }
    .icon-box {
      width: 48px;
      height: 48px;
      flex: 0 0 48px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg-subtle);
      display: grid;
      place-items: center;
      overflow: hidden;
      font-weight: 700;
      font-size: 1.05rem;
      color: var(--accent-text);
    }
    .icon-box img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 5px;
    }
    .card-title-wrap { min-width: 0; flex: 1; }
    .card-title {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
      line-height: 1.3;
      word-break: break-word;
    }
    .pkg-name {
      font-family: var(--mono);
      font-size: 0.79rem;
      color: var(--text-muted);
      word-break: break-all;
    }
    .desc {
      margin: 0;
      font-size: 0.9rem;
      color: var(--text-muted);
      flex: 1;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 2px 9px;
      border-radius: 999px;
      background: var(--bg-subtle);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .badge-cat {
      background: var(--accent-soft);
      color: var(--accent-text);
      border-color: transparent;
    }
    .badge-ok {
      background: var(--ok-soft);
      color: var(--ok);
      border-color: transparent;
    }
    .meta-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      font-size: 0.8rem;
      color: var(--text-muted);
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
    .meta-grid code {
      font-family: var(--mono);
      font-size: 0.76rem;
    }
    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .links {
      display: flex;
      gap: 12px;
      font-size: 0.82rem;
    }
    .links a {
      color: var(--accent-text);
      text-decoration: none;
      font-weight: 500;
    }
    .links a:hover { text-decoration: underline; }
    .btn-sm {
      font-size: 0.78rem;
      padding: 5px 10px;
      border-radius: 8px;
    }
    .empty {
      grid-column: 1 / -1;
      text-align: center;
      padding: 48px 16px;
      color: var(--text-muted);
      background: var(--bg-elev);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
    }
    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      font-size: 0.84rem;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 10px 24px;
      justify-content: space-between;
      align-items: center;
    }
    footer a { color: var(--accent-text); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="header-top">
        <div class="title-group">
          <h1 id="market-title">${escapeHtml(titleZh || titleEn)}</h1>
          <p id="market-desc">${escapeHtml(descZh)}</p>
        </div>
        <div class="lang-toggle" role="group" aria-label="Language">
          <button type="button" id="lang-zh" class="active">中文</button>
          <button type="button" id="lang-en">EN</button>
        </div>
      </div>

      <section class="index-box">
        <div class="index-row">
          <div class="index-url" id="index-url-display">index.json</div>
          <button type="button" class="btn btn-primary" id="copy-index-btn">复制 index.json 地址</button>
          <a class="btn" href="./index.json" target="_blank" rel="noopener" id="open-json-link">查看原始 JSON</a>
        </div>
        <div class="guide-line" id="guide-line"></div>
      </section>
    </header>

    <section class="controls">
      <div class="categories" id="category-pills"></div>
      <div class="search-sort">
        <input type="search" class="search-input" id="search-input" placeholder="搜索插件名、描述或关键词…" />
        <select class="sort-select" id="sort-select"></select>
      </div>
    </section>

    <main class="grid" id="plugin-grid"></main>

    <footer id="footer"></footer>
  </div>

  <script id="market-data" type="application/json">${safeJsonForScript(payload)}</script>
  <script>
    (() => {
      const { index, stats } = JSON.parse(document.getElementById('market-data').textContent);
      const state = { lang: 'zh', category: 'all', query: '', sort: 'default' };

      const I18N = {
        zh: {
          copyIndex: '复制 index.json 地址',
          copied: '已复制',
          openJson: '查看原始 JSON',
          guide: '在 DSH 中添加：<code>DSH → 插件 (Plugins) → 发现 (Discover) → 自定义插件索引</code>，粘贴上方 URL 即可直接使用。',
          all: '全部',
          searchPlaceholder: '搜索插件名、描述或关键词…',
          sortDefault: '默认精选排序',
          sortDownloads: '按 npm 周下载量',
          sortRecent: '按最近更新',
          weeklyDl: '周下载',
          versions: '个版本',
          dshCompat: 'DSH 要求',
          anyDsh: '通用',
          author: '作者',
          repo: '仓库',
          homepage: '主页',
          copySpec: '复制安装 spec',
          empty: '没有匹配的插件，试试切换分类或清空搜索词。',
          footerStats: (p, v) => \`Format 1 索引 · 共 \${p} 个精选插件 · \${v} 个可安装版本\`,
          attribution: '社区插件发现与筛选参考自 <a href="https://dsh.so" target="_blank" rel="noopener">dsh.so</a>，包元数据实时采自 npm 注册表。',
        },
        en: {
          copyIndex: 'Copy index.json URL',
          copied: 'Copied!',
          openJson: 'Raw JSON',
          guide: 'Add in DSH: <code>DSH → Plugins → Discover → Custom plugin indexes</code> and paste the URL above.',
          all: 'All',
          searchPlaceholder: 'Search plugin name, description, or keywords…',
          sortDefault: 'Curated order',
          sortDownloads: 'npm weekly downloads',
          sortRecent: 'Recently updated',
          weeklyDl: 'weekly dl',
          versions: 'releases',
          dshCompat: 'DSH',
          anyDsh: 'any',
          author: 'Author',
          repo: 'Repository',
          homepage: 'Homepage',
          copySpec: 'Copy spec',
          empty: 'No matching plugins found. Try another category or search term.',
          footerStats: (p, v) => \`Format 1 Index · \${p} curated plugins · \${v} installable versions\`,
          attribution: 'Community plugin discovery credited to <a href="https://dsh.so" target="_blank" rel="noopener">dsh.so</a>; package metadata fetched directly from npm.',
        },
      };

      const t = (val) => {
        if (typeof val === 'string') return val;
        if (!val || typeof val !== 'object') return '';
        return val[state.lang] || val.en || Object.values(val)[0] || '';
      };

      const resolveIndexUrl = () => {
        try {
          if (location.protocol === 'http:' || location.protocol === 'https:') {
            return new URL('index.json', location.href).href;
          }
        } catch {}
        return './index.json';
      };

      const indexUrl = resolveIndexUrl();
      document.getElementById('index-url-display').textContent = indexUrl;

      const copyText = async (text, button, labelAfter) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        const prev = button.textContent;
        button.textContent = I18N[state.lang].copied;
        button.classList.add('btn-copied');
        setTimeout(() => {
          button.textContent = labelAfter || prev;
          button.classList.remove('btn-copied');
        }, 1500);
      };

      const copyIndexBtn = document.getElementById('copy-index-btn');
      copyIndexBtn.addEventListener('click', () => copyText(indexUrl, copyIndexBtn, I18N[state.lang].copyIndex));

      const formatNum = (n) => new Intl.NumberFormat(state.lang === 'zh' ? 'zh-CN' : 'en-US').format(n);
      const formatDate = (sec) => {
        if (!sec) return '';
        return new Date(sec * 1000).toISOString().slice(0, 10);
      };

      const monogram = (name) => {
        const clean = name.replace(/^@[^/]+\//, '').replace(/^dsh[-_]/i, '');
        return (clean.slice(0, 2) || name.slice(0, 2)).toUpperCase();
      };

      const render = () => {
        const copy = I18N[state.lang];
        document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
        document.getElementById('lang-zh').classList.toggle('active', state.lang === 'zh');
        document.getElementById('lang-en').classList.toggle('active', state.lang === 'en');
        document.getElementById('market-title').textContent = t(index.title);
        document.getElementById('market-desc').textContent = t(index.description);
        copyIndexBtn.textContent = copy.copyIndex;
        document.getElementById('open-json-link').textContent = copy.openJson;
        document.getElementById('guide-line').innerHTML = copy.guide;
        document.getElementById('search-input').placeholder = copy.searchPlaceholder;

        // Sort select
        const sortSel = document.getElementById('sort-select');
        const hasDownloads = Boolean(index.metadata?.sortKeys?.npm_weekly_downloads);
        const sortOpts = [
          ['default', copy.sortDefault],
          ...(hasDownloads ? [['downloads', copy.sortDownloads]] : []),
          ['recent', copy.sortRecent],
        ];
        sortSel.innerHTML = '';
        for (const [val, label] of sortOpts) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          opt.selected = state.sort === val;
          sortSel.appendChild(opt);
        }

        // Category pills
        const pillsEl = document.getElementById('category-pills');
        pillsEl.innerHTML = '';
        const categories = index.metadata?.categories || {};
        const counts = { all: index.plugins.length };
        for (const p of index.plugins) {
          const c = p.metadata?.category;
          if (c) counts[c] = (counts[c] || 0) + 1;
        }
        const addPill = (id, label) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pill' + (state.category === id ? ' active' : '');
          btn.textContent = \`\${label} (\${counts[id] || 0})\`;
          btn.addEventListener('click', () => { state.category = id; render(); });
          pillsEl.appendChild(btn);
        };
        addPill('all', copy.all);
        for (const [id, decl] of Object.entries(categories)) {
          if (counts[id]) addPill(id, t(decl.title));
        }

        // Filter & sort plugins
        const q = state.query.trim().toLowerCase();
        let list = index.plugins.filter((p) => {
          if (state.category !== 'all' && p.metadata?.category !== state.category) return false;
          if (!q) return true;
          const hay = [
            p.name,
            t(p.title),
            typeof p.title === 'object' ? Object.values(p.title).join(' ') : '',
            t(p.description),
            typeof p.description === 'object' ? Object.values(p.description).join(' ') : '',
            p.author || '',
            ...(p.metadata?.keywords || []),
          ].join(' ').toLowerCase();
          return hay.includes(q);
        });

        if (state.sort === 'downloads') {
          list = [...list].sort((a, b) => (b.metadata?.sortKeys?.npm_weekly_downloads ?? -1) - (a.metadata?.sortKeys?.npm_weekly_downloads ?? -1));
        } else if (state.sort === 'recent') {
          list = [...list].sort((a, b) => (b.versions[0]?.publishTimestamp ?? 0) - (a.versions[0]?.publishTimestamp ?? 0));
        }

        const grid = document.getElementById('plugin-grid');
        grid.innerHTML = '';
        if (list.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = copy.empty;
          grid.appendChild(empty);
        }

        const labelDefs = index.metadata?.labels || {};
        for (const p of list) {
          const latest = p.versions[0];
          const card = document.createElement('article');
          card.className = 'card';

          const head = document.createElement('div');
          head.className = 'card-head';

          const iconBox = document.createElement('div');
          iconBox.className = 'icon-box';
          if (p.icon) {
            const img = document.createElement('img');
            img.src = p.icon;
            img.alt = t(p.title) || p.name;
            img.loading = 'lazy';
            iconBox.appendChild(img);
          } else {
            iconBox.textContent = monogram(p.name);
          }

          const titleWrap = document.createElement('div');
          titleWrap.className = 'card-title-wrap';
          const h2 = document.createElement('h2');
          h2.className = 'card-title';
          h2.textContent = t(p.title) || p.name;
          const pkgEl = document.createElement('div');
          pkgEl.className = 'pkg-name';
          pkgEl.textContent = \`\${p.name}@\${latest.version}\`;
          titleWrap.append(h2, pkgEl);
          head.append(iconBox, titleWrap);

          const badges = document.createElement('div');
          badges.className = 'badges';
          if (p.metadata?.category && categories[p.metadata.category]) {
            const b = document.createElement('span');
            b.className = 'badge badge-cat';
            b.textContent = t(categories[p.metadata.category].title);
            badges.appendChild(b);
          }
          for (const lid of (p.metadata?.labels || [])) {
            const b = document.createElement('span');
            b.className = 'badge' + (lid === 'verified' ? ' badge-ok' : '');
            b.textContent = labelDefs[lid] ? t(labelDefs[lid].title) : lid;
            badges.appendChild(b);
          }

          const desc = document.createElement('p');
          desc.className = 'desc';
          desc.textContent = t(p.description);

          const meta = document.createElement('div');
          meta.className = 'meta-grid';
          const parts = [];
          const dl = p.metadata?.sortKeys?.npm_weekly_downloads;
          if (typeof dl === 'number') parts.push(\`<span>⬇ \${formatNum(dl)} \${copy.weeklyDl}</span>\`);
          const stars = p.metadata?.sortKeys?.github_stars;
          if (typeof stars === 'number') parts.push(\`<span>★ \${formatNum(stars)}</span>\`);
          parts.push(\`<span>\${p.versions.length} \${copy.versions}</span>\`);
          if (latest.publishTimestamp) parts.push(\`<span>\${formatDate(latest.publishTimestamp)}</span>\`);
          if (p.author) parts.push(\`<span>\${copy.author}: \${p.author.replace(/</g, '&lt;')}</span>\`);
          const dshEngine = latest.engines?.dsh;
          parts.push(\`<span>\${copy.dshCompat}: <code>\${(dshEngine || copy.anyDsh).replace(/</g, '&lt;')}</code></span>\`);
          meta.innerHTML = parts.join('');

          const actions = document.createElement('div');
          actions.className = 'card-actions';
          const links = document.createElement('div');
          links.className = 'links';
          if (p.repository?.url) {
            const a = document.createElement('a');
            a.href = p.repository.url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = copy.repo;
            links.appendChild(a);
          }
          if (p.homepage && p.homepage !== p.repository?.url) {
            const a = document.createElement('a');
            a.href = p.homepage;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = copy.homepage;
            links.appendChild(a);
          }
          if (latest.source?.type === 'npm') {
            const a = document.createElement('a');
            a.href = \`https://www.npmjs.com/package/\${p.name}\`;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'npm';
            links.appendChild(a);
          }

          const spec = latest.source?.type === 'npm'
            ? \`\${p.name}@\${latest.version}\`
            : \`git+\${latest.source.url.endsWith('.git') ? latest.source.url : latest.source.url + '.git'}#\${latest.source.commit}\${latest.source.path ? '&path:/' + latest.source.path : ''}\`;
          const copySpecBtn = document.createElement('button');
          copySpecBtn.type = 'button';
          copySpecBtn.className = 'btn btn-sm';
          copySpecBtn.textContent = copy.copySpec;
          copySpecBtn.addEventListener('click', () => copyText(spec, copySpecBtn, copy.copySpec));

          actions.append(links, copySpecBtn);
          card.append(head, badges, desc, meta, actions);
          grid.appendChild(card);
        }

        document.getElementById('footer').innerHTML =
          \`<span>\${copy.footerStats(stats.pluginCount, stats.versionCount)}</span><span>\${copy.attribution}</span>\`;
      };

      document.getElementById('lang-zh').addEventListener('click', () => { state.lang = 'zh'; render(); });
      document.getElementById('lang-en').addEventListener('click', () => { state.lang = 'en'; render(); });
      document.getElementById('search-input').addEventListener('input', (e) => { state.query = e.target.value; render(); });
      document.getElementById('sort-select').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

      render();
    })();
  </script>
</body>
</html>
`
}
