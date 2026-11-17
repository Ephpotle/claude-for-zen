// Small, safe Markdown subset: paragraphs, lists, code, emphasis, links.
// Everything is HTML-escaped first, so the result is safe to assign to innerHTML.
// Shared by the chat panel page and the on-page explain card.

(() => {
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function inline(text) {
    const code = [];
    let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
      code.push(c);
      return `\u0000${code.length - 1}\u0000`;
    });
    out = out
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
  }

  function markdown(source) {
    const html = [];
    const lines = source.split('\n');
    let paragraph = [];
    let list = null; // { tag, items }
    const flush = () => {
      if (paragraph.length) html.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
      paragraph = [];
      if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        const body = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
        html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol';
        if (paragraph.length || (list && list.tag !== tag)) flush();
        list = list || { tag, items: [] };
        list.items.push((bullet || numbered)[1]);
      } else if (heading) {
        flush();
        html.push(`<h3>${inline(heading[1])}</h3>`);
      } else if (!line.trim()) {
        flush();
      } else if (list && /^\s+\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
      } else {
        if (list) flush();
        paragraph.push(line);
      }
    }
    flush();
    return html.join('');
  }

  globalThis.claudeForZenMarkdown = markdown;
})();
