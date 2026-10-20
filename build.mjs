// Builds the change vault into a static site in ./docs, for GitHub Pages.
// The page set is exactly what the vault's git repo tracks, so the site never shows a file the repo doesn't hold.
//
//   VAULT=~/Documents/change node build.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Marked } from 'marked';

const VAULT = path.resolve((process.env.VAULT ?? '~/Documents/change').replace(/^~/, os.homedir()));
const OUT = path.resolve('docs');
const SITE = 'change';
const SKIP = [/^\.obsidian\//, /(^|\/)\.gitkeep$/, /^\.gitignore$/];

// Where each part of the vault sits in the map, in the order the vault's own flow reads.
const SECTIONS = [
  ['now', 'now', /^now\.md$/],
  ['inbox', 'inbox', /^inbox\.md$/],
  ['ideas', 'ideas', /^ideas\//],
  ['projects', 'projects', /^projects\//],
  ['wiki', 'wiki', /^wiki\//],
  ['sources', 'sources', /^sources\//],
  ['archive', 'archive', /^archive\//],
  ['notebook', 'notebook', /^(notebook\.md|.*\.ipynb)$/],
  ['how it works', 'agents', /^(AGENTS|CLAUDE)\.md$|^docs\/|^templates\/|^\.claude\//],
];

const git = (...args) => execFileSync('git', ['-C', VAULT, ...args], { encoding: 'utf8' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

// ── collect ─────────────────────────────────────────────────────────────────────────

const files = git('ls-files').split('\n').filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));
if (!files.length) throw new Error(`no tracked files in ${VAULT}`);

/** Vault path → site path. Dot-folders become plain folders, since some hosts hide them. */
const urlOf = (file) => file.replace(/^\./, '').replace(/\/\./g, '/').replace(/\.(md|ipynb)$/, '.html');
const sectionOf = (file) => SECTIONS.find(([, , re]) => re.test(file)) ?? ['vault', 'vault'];

const pages = [];
const assets = [];
for (const file of files) {
  if (!/\.(md|ipynb)$/.test(file)) { assets.push(file); continue; }
  const [sectionLabel, section] = sectionOf(file);
  const updated = git('log', '-1', '--format=%cs', '--', file).trim();
  pages.push({ file, url: urlOf(file), section, sectionLabel, updated, links: new Set() });
}

// Wikilinks resolve by path first ([[projects/say/brief]]), then by name ([[finetune-on-mlx]]).
const byPath = new Map(pages.map((p) => [p.file.replace(/\.(md|ipynb)$/, ''), p]));
const byName = new Map();
for (const p of pages) {
  const name = path.basename(p.file).replace(/\.(md|ipynb)$/, '');
  if (!byName.has(name) || p.section === 'wiki') byName.set(name, p); // a bare name means the wiki page when there's a choice
}
const resolve = (target) => {
  const t = target.replace(/\.md$/, '');
  // A bare project or idea name ([[radar]]) means that project's brief, or that idea.
  return byPath.get(t) ?? byPath.get(`projects/${t}/brief`) ?? byPath.get(`ideas/${t}`) ?? byName.get(path.basename(t));
};

// ── render ──────────────────────────────────────────────────────────────────────────

let current = null; // the page being rendered, so links can be made relative to it
const rel = (url) => path.posix.relative(path.posix.dirname(current.url), url) || path.posix.basename(url);
const toRoot = (page) => '../'.repeat(page.url.split('/').length - 1);

const md = new Marked({ gfm: true });
md.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenizer(src) {
      const m = /^\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
      if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), hash: m[2] ?? '', label: (m[3] ?? m[1]).trim() };
    },
    renderer(tok) {
      const page = resolve(tok.target);
      if (!page) return `<span class="wl missing" title="not written yet">${esc(tok.label)}</span>`;
      current.links.add(page);
      return `<a class="wl" href="${esc(rel(page.url) + tok.hash)}">${esc(tok.label)}</a>`;
    },
  }],
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slug(text);
      current.toc.push({ depth, text: text.replace(/<[^>]+>/g, ''), id });
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      let to = href;
      const external = /^[a-z]+:/i.test(href) || href.startsWith('#');
      if (!external && /\.md(#|$)/.test(href)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(current.file), href.replace(/#.*/, '')));
        const page = byPath.get(target.replace(/\.md$/, ''));
        if (!page) return `<span class="wl missing" title="not written yet">${text}</span>`;
        current.links.add(page);
        to = rel(page.url) + (href.match(/#.*/)?.[0] ?? '');
      }
      return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ''}${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${text}</a>`;
    },
  },
});

/** `---` frontmatter at the top: a small key/value list, shown beside the page. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: [], body: text };
  const meta = m[1].split('\n').map((line) => /^([\w-]+):\s*(.*)$/.exec(line)).filter(Boolean).map(([, k, v]) => [k, v]);
  return { meta, body: text.slice(m[0].length) };
}

function renderMarkdown(page, text) {
  const { meta, body } = frontmatter(text);
  const h1 = /^\s*# (.+)$/m.exec(body);
  page.title = h1 ? h1[1].trim() : path.basename(page.file, '.md');
  page.meta = meta;
  page.html = md.parse(h1 ? body.replace(h1[0], '') : body);
  page.text = body.replace(/[#*_`>|[\]-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderNotebook(page, text) {
  const nb = JSON.parse(text);
  const src = (s) => (Array.isArray(s) ? s.join('') : s ?? '');
  page.title = path.basename(page.file);
  page.meta = [['kind', 'Jupyter notebook'], ['cells', String(nb.cells.length)]];
  page.html = nb.cells.map((cell, i) => {
    if (cell.cell_type === 'markdown') return `<section class="cell md">${md.parse(src(cell.source))}</section>`;
    const outs = (cell.outputs ?? []).map((o) => {
      if (o.data?.['image/png']) return `<img alt="output ${i + 1}" src="data:image/png;base64,${o.data['image/png'].replace(/\s/g, '')}">`;
      const t = o.text ?? o.data?.['text/plain'] ?? (o.ename ? `${o.ename}: ${o.evalue}` : '');
      return t ? `<pre class="out">${esc(src(t))}</pre>` : '';
    }).join('');
    const body = src(cell.source).trim();
    return `<section class="cell code"><span class="cell-n">[${cell.execution_count ?? ' '}]</span><pre><code>${esc(body || '(empty cell)')}</code></pre>${outs}</section>`;
  }).join('\n');
  page.text = nb.cells.map((c) => src(c.source)).join(' ').slice(0, 4000);
}

for (const page of pages) {
  current = page;
  page.toc = [];
  const text = fs.readFileSync(path.join(VAULT, page.file), 'utf8');
  if (page.file.endsWith('.ipynb')) renderNotebook(page, text); else renderMarkdown(page, text);
}

// Backlinks: who points here.
for (const p of pages) p.backlinks = [];
for (const p of pages) for (const target of p.links) if (target !== p) target.backlinks.push(p);

// ── templates ───────────────────────────────────────────────────────────────────────

const FONTS = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=DM+Mono:wght@300;400&display=swap';

function nav(page) {
  const groups = SECTIONS.map(([label, key]) => [label, key, pages.filter((p) => p.section === key)]).filter(([, , list]) => list.length);
  const item = (p) => {
    const name = p.section === 'projects' ? p.file.split('/').slice(1).join(' / ').replace(/\.md$/, '') : p.title;
    return `<li><a href="${esc(rel(p.url))}"${p === page ? ' aria-current="page"' : ''}>${esc(name)}</a></li>`;
  };
  return groups.map(([label, key, list]) => {
    const open = page.section === key || list.length <= 2;
    return `<details class="group"${open ? ' open' : ''}><summary>${esc(label)} <span class="n">${list.length}</span></summary><ul>${list.map(item).join('')}</ul></details>`;
  }).join('');
}

function side(page) {
  const parts = [];
  if (page.meta?.length) {
    parts.push(`<section><h2>about</h2><dl>${page.meta.map(([k, v]) => {
      const val = esc(v).replace(/(https?:\/\/[^\s,)]+)/g, '<a href="$1" rel="noopener">$1</a>');
      return `<dt>${esc(k)}</dt><dd>${val}</dd>`;
    }).join('')}</dl></section>`);
  }
  if (page.backlinks.length) {
    parts.push(`<section><h2>links here</h2><ul>${page.backlinks.map((b) => `<li><a href="${esc(rel(b.url))}">${esc(b.title)}</a><span class="sec">${esc(b.sectionLabel)}</span></li>`).join('')}</ul></section>`);
  }
  const toc = page.toc.filter((h) => h.depth === 2);
  if (toc.length > 2) parts.push(`<section><h2>on this page</h2><ul class="toc">${toc.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></section>`);
  return parts.join('');
}

function shell(page, { main, sideHtml, title, description, root = toRoot(page) }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
${root.startsWith('/') ? `<base href="${root}">` : ''}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23d9481e' stroke-width='4'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${root}style.css">
<script>try{const t=localStorage.getItem('change:theme');if(t)document.documentElement.dataset.theme=t}catch{}</script>
<script src="${root}app.js" defer></script>
</head>
<body data-root="${root}">
<a class="skip" href="#main">Skip to the page</a>
<header class="top">
  <a class="brand" href="${root}index.html">${SITE}</a>
  <div class="search">
    <input id="q" type="search" placeholder="search the vault" autocomplete="off" aria-label="search the vault"><kbd>/</kbd>
    <ol id="hits" hidden></ol>
  </div>
  <button id="theme" type="button" aria-label="switch light and dark">◐</button>
</header>
<div class="layout">
  <details class="mobile-nav"><summary>the vault</summary><nav>${nav(page)}</nav></details>
  <nav class="rail" aria-label="the vault">${nav(page)}</nav>
  <main id="main">${main}</main>
  <aside class="side">${sideHtml}</aside>
</div>
<footer class="foot"><span>${SITE} · ${pages.length} pages · built ${new Date().toISOString().slice(0, 10)}</span><span>a working notebook, published as it is</span></footer>
</body>
</html>
`;
}

function pageHtml(page) {
  const crumbs = page.file.split('/').slice(0, -1).map((c) => c.replace(/^\./, '')).join(' / ');
  const main = `<p class="crumbs">${esc(crumbs || page.sectionLabel)}${page.updated ? ` <span>· updated ${page.updated}</span>` : ''}</p>
<h1>${esc(page.title)}</h1>
<article class="prose">${page.html}</article>`;
  return shell(page, { main, sideHtml: side(page), title: `${page.title} · ${SITE}`, description: page.text.slice(0, 160) });
}

// The front page: what matters now, the flow of the vault, and every section with its pages.
function homeHtml() {
  const home = { url: 'index.html', section: 'home', file: 'index.html', backlinks: [], toc: [] };
  current = home;
  // Pages shown on the front page are rendered again from here, so their links point the right way.
  const embed = (file) => {
    const p = byPath.get(file);
    if (!p) return '';
    const copy = { ...p, url: 'index.html', links: new Set(), toc: [] };
    current = copy;
    renderMarkdown(copy, fs.readFileSync(path.join(VAULT, p.file), 'utf8'));
    current = home;
    return copy.html;
  };
  const now = pages.find((p) => p.file === 'now.md');
  const count = (key) => pages.filter((p) => p.section === key).length;
  const projects = [...new Set(pages.filter((p) => p.section === 'projects').map((p) => p.file.split('/')[1]))];
  const recent = [...pages].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, 8);
  const projectRows = projects.map((name) => {
    const brief = byPath.get(`projects/${name}/brief`);
    const parts = pages.filter((p) => p.file.startsWith(`projects/${name}/`));
    const status = brief?.meta.find(([k]) => k === 'status')?.[1] ?? '';
    return `<li><a href="${esc(rel((brief ?? parts[0]).url))}">${esc(name)}</a><span class="status">${esc(status)}</span><span class="parts">${parts.map((p) => `<a href="${esc(rel(p.url))}">${esc(path.basename(p.file, '.md'))}</a>`).join('')}</span></li>`;
  }).join('');
  const ideaRows = pages.filter((p) => p.section === 'ideas').map((p) => {
    const status = p.meta.find(([k]) => k === 'status')?.[1] ?? '';
    return `<li><a href="${esc(rel(p.url))}">${esc(p.title)}</a><span class="status">${esc(status)}</span></li>`;
  }).join('');
  const main = `
<section class="hero">
  <p class="eyebrow">a working notebook</p>
  <h1 class="wordmark">${SITE}</h1>
  <p class="lede">Ideas, projects and what they taught, kept in one plain-text vault and published as it stands.</p>
</section>
<section class="flow" aria-label="how things move through the vault">
  <a href="#ideas">inbox</a><i></i><a href="#ideas">ideas</a><i></i><a href="#projects">projects</a><i></i><span>archive</span>
  <span class="flow-down"><a href="#wiki">sources → wiki</a> <em>every project teaches the wiki something</em></span>
</section>
${now ? `<section class="now"><h2 id="now"><a href="${esc(rel(now.url))}">now</a></h2><div class="prose">${embed('now')}</div></section>` : ''}
<section class="ledger">
  <div class="col"><h2 id="projects">projects <span class="n">${projects.length}</span></h2><ul class="rows">${projectRows}</ul></div>
  <div class="col"><h2 id="ideas">ideas <span class="n">${count('ideas')}</span></h2><ul class="rows">${ideaRows}</ul></div>
</section>
<section class="wiki-list"><h2 id="wiki">wiki <span class="n">${count('wiki')}</span></h2>
  ${byPath.get('wiki/index') ? `<div class="prose">${embed('wiki/index')}</div>` : ''}
</section>
<section class="recent"><h2>recently changed</h2><ul class="rows">${recent.map((p) => `<li><a href="${esc(rel(p.url))}">${esc(p.title)}</a><span class="status">${esc(p.sectionLabel)}</span><span class="date">${esc(p.updated ?? '')}</span></li>`).join('')}</ul></section>`;
  return shell(home, { main, sideHtml: '', title: `${SITE} — a working notebook`, description: 'Ideas, projects and what they taught, kept in one plain-text vault.' });
}

// ── write ───────────────────────────────────────────────────────────────────────────

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const page of pages) {
  current = page;
  const out = path.join(OUT, page.url);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pageHtml(page));
}
for (const file of assets) {
  const out = path.join(OUT, urlOf(file));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(VAULT, file), out);
}
fs.writeFileSync(path.join(OUT, 'index.html'), homeHtml());
fs.writeFileSync(path.join(OUT, 'search.json'), JSON.stringify(pages.map((p) => ({ t: p.title, u: p.url, s: p.sectionLabel, x: p.text.slice(0, 3000) }))));
current = { url: 'index.html' };
fs.writeFileSync(path.join(OUT, '404.html'), shell({ url: '404.html', section: '', file: '404.html', backlinks: [], toc: [] },
  { main: '<p class="crumbs">404</p><h1>Not in the vault</h1><article class="prose"><p>That page isn\'t here. Try the search, or go back to <a href="/change/index.html">the front page</a>.</p></article>', sideHtml: '', title: `not found · ${SITE}`, description: 'Not found', root: `/${SITE}/` }));
fs.copyFileSync('site/style.css', path.join(OUT, 'style.css'));
fs.copyFileSync('site/app.js', path.join(OUT, 'app.js'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as they are; no Jekyll processing

const missing = new Set();
for (const p of pages) for (const m of p.html.matchAll(/class="wl missing"[^>]*>([^<]+)</g)) missing.add(`${p.file} → ${m[1]}`);
console.log(`built ${pages.length} pages + ${assets.length} files from ${VAULT} → ${OUT}`);
if (missing.size) console.log(`not written yet (shown as faint links):\n  ${[...missing].join('\n  ')}`);
