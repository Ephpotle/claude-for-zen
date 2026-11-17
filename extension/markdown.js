// Small, safe Markdown subset: paragraphs, lists, code, emphasis, links.
// Everything is HTML-escaped first, so the result is safe to assign to innerHTML.
// Shared by the chat panel page and the on-page explain card.

(() => {
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inline(text) {
    // Finished pieces of HTML (code spans, link tags) are set aside as
    // placeholders, so that no later pass can match inside them. Without this,
    // the bare-address pass could match a second address inside a link's href
    // and break out of the attribute.
    const held = [];
    const hold = (html) => {
      held.push(html);
      return `\u0000${held.length - 1}\u0000`;
    };
    const open = (url) => hold(`<a href="${url}" target="_blank" rel="noreferrer">`);
    let out = escapeHtml(text.replace(/\u0000/g, '')).replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
    out = out
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, (_, label, url) => open(url) + label + hold('</a>'))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+[^\s<).,;:!?\u0000])/g, (_, before, url) => before + open(url) + url + hold('</a>'))
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
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
      // A table: consecutive lines that start with "|". The "|---|---|" line only marks the header.
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i].trim().slice(1, -1).split('|').map((cell) => cell.trim()));
        i--;
        const ruled = rows.length > 1 && rows[1].every((cell) => /^:?-{2,}:?$/.test(cell));
        const body = ruled ? rows.slice(2) : rows;
        const cells = (row, tag) => `<tr>${row.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join('')}</tr>`;
        html.push(`<table>${ruled ? `<thead>${cells(rows[0], 'th')}</thead>` : ''}<tbody>${body.map((row) => cells(row, 'td')).join('')}</tbody></table>`);
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
