# Item-pane section (Zotero 8/9 ItemPaneManager). Zotero renders the collapsible
# section title from the header message's `.label` attribute, the sidenav strip's
# hover from `.tooltiptext`, and section-button tooltips from `.tooltiptext`. A
# bare `id = value` has NO attribute for these to land on and renders BLANK — the
# blank sidenav-icon / empty-header bug. Attribute syntax is mandatory here.
citegeist-pane-header =
    .label = Citation Intelligence
citegeist-pane-sidenav =
    .tooltiptext = Citations
citegeist-pane-refresh =
    .tooltiptext = Refresh citation data
citegeist-pane-settings =
    .tooltiptext = Citegeist settings

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
citegeist-menu-resolve-authors =
    .label = Resolve Author Identities (Citegeist)
    .accesskey = A
citegeist-menu-resolve-collection =
    .label = Resolve All Author Identities (Citegeist)
    .accesskey = A
