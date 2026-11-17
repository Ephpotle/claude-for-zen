browser.runtime.sendMessage({ type: 'status' }).then(({ sessions }) => {
  document.getElementById('dot').classList.toggle('on', sessions > 0);
  document.getElementById('label').textContent = sessions
    ? `Connected to ${sessions} Claude Code session${sessions > 1 ? 's' : ''}`
    : 'Not connected';
  document.getElementById('hint').textContent = sessions
    ? 'Claude Code can see and control tabs in this browser.'
    : 'Connects by itself within a few seconds of a Claude Code session or the chat panel starting.';
});

// The add-on's own chat sidebar. This has to run straight from the click:
// the browser only lets a sidebar be opened in answer to a user's action.
document.getElementById('sidebar').addEventListener('click', () => {
  browser.sidebarAction.toggle();
  window.close();
});

document.getElementById('comment').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'comment_mode' });
  window.close();
});

const explain = document.getElementById('explain');
browser.storage.local.get({ explainButton: true }).then((saved) => (explain.checked = saved.explainButton));
explain.addEventListener('change', () => browser.storage.local.set({ explainButton: explain.checked }));

// Updates arrive by themselves within a day or so. Zen gives add-ons no way to
// ask for that check, so this looks up the latest release itself and, when
// there is a newer one, opens the signed file: Zen then offers to install it.
const manifest = browser.runtime.getManifest();
const update = document.getElementById('update');
const note = document.getElementById('update-note');
const say = (text) => {
  note.textContent = text;
  note.hidden = false;
};
const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
document.getElementById('version').textContent = `Version ${manifest.version}`;

let found = null; // { version, link } once a newer release is known
update.addEventListener('click', async () => {
  if (found) {
    await browser.tabs.create({ url: found.link });
    window.close();
    return;
  }
  const feed = manifest.browser_specific_settings?.gecko?.update_url;
  if (!feed) return say('This copy has no update address (it was loaded for development).');
  update.disabled = true;
  update.textContent = 'Checking…';
  try {
    const res = await fetch(feed, { cache: 'no-store' });
    if (!res.ok) throw new Error(`the release page answered ${res.status}`);
    const releases = (await res.json()).addons?.[manifest.browser_specific_settings.gecko.id]?.updates ?? [];
    const latest = releases.reduce((best, r) => (!best || newer(r.version, best.version) ? r : best), null);
    if (latest && newer(latest.version, manifest.version) && latest.update_link.startsWith(feed.slice(0, feed.indexOf('/releases/') + 10) + 'download/')) {
      found = { version: latest.version, link: latest.update_link };
      say(`Version ${latest.version} is available. Zen will ask you to confirm the install.`);
      update.textContent = `Install ${latest.version}`;
    } else {
      say(`You have the latest version (${manifest.version}).`);
      update.textContent = 'Check for updates';
    }
  } catch (err) {
    say(`Could not check: ${err.message}`);
    update.textContent = 'Check for updates';
  }
  update.disabled = false;
});
