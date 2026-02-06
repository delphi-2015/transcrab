import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';

const CONTENT_ROOT = path.resolve(process.cwd(), 'content', 'articles');

export async function listArticles() {
  let dirs = [];
  try {
    dirs = await fs.readdir(CONTENT_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const slug = d.name;
    const zhPath = path.join(CONTENT_ROOT, slug, 'zh.md');
    try {
      const raw = await fs.readFile(zhPath, 'utf-8');
      const fm = matter(raw);
      items.push({
        slug,
        title: fm.data.title ?? slug,
        date: fm.data.date ?? null,
        sourceUrl: fm.data.sourceUrl ?? null,
      });
    } catch {
      // ignore
    }
  }

  items.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return items;
}

export async function getArticle(slug) {
  const zhPath = path.join(CONTENT_ROOT, slug, 'zh.md');
  try {
    const raw = await fs.readFile(zhPath, 'utf-8');
    const fm = matter(raw);
    const html = marked.parse(fixStrongAdjacency(fm.content));
    return {
      slug,
      title: fm.data.title ?? slug,
      date: fm.data.date ?? null,
      sourceUrl: fm.data.sourceUrl ?? null,
      html,
    };
  } catch {
    return null;
  }
}

// CommonMark-style emphasis rules are strict about delimiter adjacency.
// In Chinese translations we often have patterns like `**Item：**Item` without a space.
// Many parsers render this literally. We insert a space after a closing strong marker
// when it is immediately followed by a CJK/Latin/digit character.
function fixStrongAdjacency(md) {
  return md
    // **bold**Word -> **bold** Word
    .replace(/(\*\*[^\n]*?\*\*)(?=[0-9A-Za-z\u4E00-\u9FFF])/g, '$1 ')
    // __bold__Word -> __bold__ Word
    .replace(/(__[^\n]*?__)(?=[0-9A-Za-z\u4E00-\u9FFF])/g, '$1 ');
}
