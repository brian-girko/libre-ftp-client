// index.mjs — options page shell: switches between the General (master
// password) and Accounts (saved ftp accounts) tabs. Activating a tab
// refreshes its view so the lock state and the account list stay current.

const panels = {
  general: document.querySelector('#general-panel'),
  accounts: document.querySelector('#accounts-panel')
};

function show(name) {
  for (const tab of document.querySelectorAll('.op-tab')) {
    tab.classList.toggle('op-active', tab.dataset.tab === name);
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = key !== name;
  }
  const view = document.querySelector(name === 'general' ? 'general-view' : 'accounts-view');
  if (view && typeof view.refresh === 'function') {
    view.refresh();
  }
}

for (const tab of document.querySelectorAll('.op-tab')) {
  tab.addEventListener('click', () => show(tab.dataset.tab));
}
