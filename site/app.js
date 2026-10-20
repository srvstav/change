// Search across the whole vault (press /), and a light/dark switch that remembers.
const root = document.body.dataset.root ?? '';
const input = document.getElementById('q');
const list = document.getElementById('hits');
let index = null;
let picked = -1;

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function load() {
  if (index) return index;
  try {
    index = await (await fetch(`${root}search.json`)).json();
  } catch {
    index = [];
  }
  return index;
}

// Every word must appear; title hits count most. O(pages × words), fine for a personal vault.
function search(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return index
    .map((p) => {
      const t = p.t.toLowerCase(), x = p.x.toLowerCase();
      if (!words.every((w) => t.includes(w) || x.includes(w))) return null;
      const score = words.reduce((s, w) => s + (t.includes(w) ? 10 : 0) + (x.split(w).length - 1), 0);
      const at = x.indexOf(words[0]);
      const snip = at < 0 ? p.x.slice(0, 120) : p.x.slice(Math.max(0, at - 50), at + 90);
      return { ...p, score, snip };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function show(hits, q) {
  picked = -1;
  if (!q.trim()) { list.hidden = true; return; }
  const mark = (s) => {
    let out = esc(s);
    for (const w of q.split(/\s+/).filter(Boolean)) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return out;
  };
  list.innerHTML = hits.length
    ? hits.map((h) => `<li><a href="${root}${esc(h.u)}"><b>${mark(h.t)}</b><small>${esc(h.s)} · …${mark(h.snip)}…</small></a></li>`).join('')
    : '<li><small style="padding:8px 10px;display:block">nothing in the vault matches that yet</small></li>';
  list.hidden = false;
}

input?.addEventListener('focus', load);
input?.addEventListener('input', async () => { await load(); show(search(input.value), input.value); });
input?.addEventListener('keydown', (e) => {
  const links = [...list.querySelectorAll('a')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!links.length) return;
    picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links.forEach((a, i) => a.classList.toggle('on', i === picked));
  } else if (e.key === 'Enter' && links.length) {
    location.href = links[Math.max(0, picked)].href;
  } else if (e.key === 'Escape') {
    input.value = ''; list.hidden = true; input.blur();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !/input|textarea/i.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    input?.focus();
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) list.hidden = true; });

document.getElementById('theme')?.addEventListener('click', () => {
  const html = document.documentElement;
  const dark = html.dataset.theme ? html.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  html.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('change:theme', html.dataset.theme); } catch { /* private mode: it just won't remember */ }
});
