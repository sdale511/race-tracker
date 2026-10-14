// The tab bar every admin UI shares (base, markset/mark, RTK-only and the boat's own dashboard), so moving between a
// mode's pages is always one click on the same bar instead of a "back to dashboard" link. Each mode passes its own list
// of tabs; the CSS and markup are the same everywhere.

const TABS_CSS = `
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 14px; }
  .tabs a { padding: 8px 18px; border-radius: 8px; border: 1px solid #262c36; background: #161b22; color: #8b94a3; font-size: 14px; font-weight: 600; text-decoration: none; }
  .tabs a:hover { text-decoration: none; background: #1c222b; color: #e6e9ef; }
  .tabs a.on { background: #1f6feb; border-color: #388bfd; color: #fff; }`;

// tabs: [{ id, href, label }] - label is trusted HTML (it may contain &amp;).
function renderTabs(tabs, active) {
  return `<nav class="tabs">${tabs.map((t) => `<a href="${t.href}"${t.id === active ? ' class="on"' : ''}>${t.label}</a>`).join('')}</nav>`;
}

// Base station (npm run base / basertk). The Map tab only appears once there is a course to show.
function baseTabs(hasCourse) {
  return [
    { id: 'home', href: '/', label: 'Regatta &amp; boats' },
    { id: 'radio', href: '/radio', label: 'Radio, GPS &amp; system' },
    { id: 'data', href: '/data', label: 'Data' },
    ...(hasCourse ? [{ id: 'map', href: '/map', label: 'Map' }] : []),
    { id: 'console', href: '/console', label: 'Console' },
    { id: 'config', href: '/config', label: 'Config' },
  ];
}

// Base station in markset / mark mode: the map is the home page and there is no dashboard to tab to.
function markTabs() {
  return [
    { id: 'map', href: '/map', label: 'Map' },
    { id: 'console', href: '/console', label: 'Console' },
    { id: 'config', href: '/config', label: 'Config' },
  ];
}

// The boat's own dashboard. The Map tab appears once the boat has marks or a GPS fix.
function roverTabs(hasMap) {
  return [
    { id: 'home', href: '/', label: 'Boat' },
    ...(hasMap ? [{ id: 'map', href: '/map', label: 'Map' }] : []),
    { id: 'console', href: '/console', label: 'Console' },
    { id: 'config', href: '/config', label: 'Config' },
  ];
}

// RTK-only mode (npm run rtk): the base GPS receiver on its own - no console page.
function rtkTabs() {
  return [
    { id: 'home', href: '/', label: 'Base GPS' },
    { id: 'map', href: '/map', label: 'Map' },
    { id: 'config', href: '/config', label: 'Config' },
  ];
}

module.exports = { TABS_CSS, renderTabs, baseTabs, markTabs, roverTabs, rtkTabs };
