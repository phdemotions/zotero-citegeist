citegeist-pane-header = Citation Intelligence
citegeist-pane-sidenav = Citations
citegeist-pane-refresh =
    .title = Refresh citation data
citegeist-pane-settings =
    .title = Citegeist settings

# Context-menu labels (Zotero 8+ MenuManager path). MenuManager applies these
# via `dataset.l10nId` on a XUL <menuitem>, so they MUST use Fluent attribute
# syntax (.label / .accesskey). A bare `id = value` message has no text node to
# land in on a menuitem and renders blank — the cause of issue #67. Accesskeys
# mirror the DOM fallback path's audited mnemonics (item menu: G is free;
# collection menu: I is free). The DOM fallback on Zotero 7.0.x sets its own
# labels via setAttribute and never reads these messages.
citegeist-menu-fetch =
    .label = Fetch Citation Counts
    .accesskey = G
citegeist-menu-citing =
    .label = View Citing Works…
citegeist-menu-refs =
    .label = View References…
citegeist-menu-fetch-collection =
    .label = Fetch All Citation Counts (Citegeist)
    .accesskey = I
