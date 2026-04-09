/**
 * Zotero 7 type declarations for plugin development.
 * Covers the APIs used by Citegeist — not exhaustive.
 */

declare namespace _ZoteroTypes {
  interface Item {
    id: number;
    libraryID: number;
    key: string;
    itemTypeID: number;
    /** String name of the item type, e.g. "journalArticle", "book", "bookSection". */
    itemType: string;
    isRegularItem(): boolean;
    isAttachment(): boolean;
    isNote(): boolean;
    getField(field: string): string;
    setField(field: string, value: string | number): void;
    getCreators(): Creator[];
    setCreators(creators: Creator[]): void;
    getTags(): { tag: string; type?: number }[];
    addTag(tag: string, type?: number): boolean;
    getCollections(): number[];
    addToCollection(collectionID: number): void;
    removeFromCollection(collectionID: number): void;
    getNotes(): number[];
    getAttachments(): number[];
    saveTx(options?: Record<string, unknown>): Promise<number>;
    save(options?: Record<string, unknown>): Promise<number>;
    eraseTx(options?: Record<string, unknown>): Promise<void>;
    deleted: boolean;
  }

  interface Creator {
    firstName: string;
    lastName: string;
    creatorType: string;
    fieldMode?: number;
  }

  interface Collection {
    id: number;
    name: string;
    libraryID: number;
    parentID: number | false;
    hasChildCollections(): boolean;
    getChildCollections(asIDs?: false): Collection[];
    getChildCollections(asIDs: true): number[];
    getChildItems(asIDs?: false): Item[];
    getChildItems(asIDs: true): number[];
  }

  interface Search {
    libraryID: number;
    addCondition(condition: string, operator: string, value: string): void;
    search(): Promise<number[]>;
  }

  interface ProgressWindow {
    changeHeadline(text: string): void;
    show(): void;
    startCloseTimer(ms: number): void;
    ItemProgress: new (icon: string, text: string) => ProgressWindowItem;
  }

  interface ProgressWindowItem {
    setProgress(percent: number): void;
    setText(text: string): void;
  }

  interface ItemsView {
    refreshAndMaintainSelection(): Promise<void>;
  }

  // Item pane section registration types
  interface SectionHookArgs {
    paneID: string;
    doc: Document;
    body: HTMLElement;
    item: Item;
    tabType: string;
    editable: boolean;
  }

  interface SectionRenderArgs extends SectionHookArgs {
    setSectionSummary(summary: string): void;
    setSectionButtonStatus(id: string, options: Record<string, unknown>): void;
  }

  interface SectionItemChangeArgs extends SectionHookArgs {
    setEnabled(enabled: boolean): void;
  }

  interface SectionButtonClickArgs {
    body: HTMLElement;
    item: Item;
    paneID: string;
    setSectionSummary(summary: string): void;
  }

  interface RegisterSectionOptions {
    paneID: string;
    pluginID: string;
    header: {
      l10nID?: string;
      label?: string;
      icon: string;
      darkIcon?: string;
    };
    sidenav: {
      l10nID?: string;
      label?: string;
      icon: string;
      darkIcon?: string;
    };
    bodyXHTML?: string;
    onInit?: (args: SectionHookArgs) => void;
    onDestroy?: (args: SectionHookArgs) => void;
    onItemChange?: (args: SectionItemChangeArgs) => void;
    onRender?: (args: SectionRenderArgs) => void;
    onAsyncRender?: (args: SectionRenderArgs) => void | Promise<void>;
    onToggle?: (args: SectionHookArgs & { isToggled: boolean }) => void;
    sectionButtons?: Array<{
      type: string;
      icon: string;
      darkIcon?: string;
      l10nID?: string;
      label?: string;
      onClick: (args: SectionButtonClickArgs) => void | Promise<void>;
    }>;
  }

  interface RegisterColumnOptions {
    dataKey: string;
    label: string;
    pluginID: string;
    dataProvider?: (item: Item, dataKey: string) => string;
    renderCell?: (
      index: number,
      data: string,
      column: unknown,
      isFirstColumn: boolean,
      doc: Document,
    ) => HTMLElement;
    sortReverse?: boolean;
    zoteroPersist?: string[];
    iconPath?: string;
    flex?: number;
    width?: string;
    fixedWidth?: boolean;
    minWidth?: number;
    showInColumnPicker?: boolean;
    columnPickerSubMenu?: boolean;
  }
}

declare const Zotero: {
  debug(msg: string, level?: number): void;
  log(msg: string): void;
  getActiveZoteroPane(): {
    getSelectedItems(asIDs?: boolean): _ZoteroTypes.Item[];
    getSelectedCollection(): _ZoteroTypes.Collection | null;
    itemsView?: _ZoteroTypes.ItemsView;
  };
  Item: new (itemType: string) => _ZoteroTypes.Item;
  Items: {
    get(id: number): _ZoteroTypes.Item | false;
    get(ids: number[]): _ZoteroTypes.Item[];
    getAsync(id: number): Promise<_ZoteroTypes.Item>;
    getAsync(ids: number[]): Promise<_ZoteroTypes.Item[]>;
    getAll(
      libraryID: number,
      onlyTopLevel?: boolean,
    ): Promise<_ZoteroTypes.Item[]>;
  };
  Libraries: {
    userLibraryID: number;
  };
  Collections: {
    getByLibrary(libraryID: number): _ZoteroTypes.Collection[];
  };
  Prefs: {
    get(pref: string, global?: boolean): unknown;
    set(pref: string, value: unknown, global?: boolean): void;
  };
  HTTP: {
    request(
      method: string,
      url: string,
      options?: {
        headers?: Record<string, string>;
        body?: string;
        responseType?: string;
        timeout?: number;
      },
    ): Promise<{
      status: number;
      responseText: string;
      getResponseHeader(header: string): string | null;
    }>;
  };
  ProgressWindow: new (options?: {
    closeOnClick?: boolean;
  }) => _ZoteroTypes.ProgressWindow;
  Search: new () => _ZoteroTypes.Search;
  ItemTreeManager: {
    registerColumn(
      options: _ZoteroTypes.RegisterColumnOptions,
    ): Promise<string>;
    unregisterColumn(dataKey: string): Promise<void>;
  };
  ItemPaneManager: {
    registerSection(options: _ZoteroTypes.RegisterSectionOptions): void;
    unregisterSection(paneID: string): void;
  };
  PreferencePanes: {
    register(options: {
      pluginID: string;
      src: string;
      label: string;
      image: string;
    }): void;
  };
  launchURL(url: string): void;
  getMainWindow(): Window;
  [key: string]: unknown;
};

declare const ZoteroPane: {
  getSelectedItems(asIDs?: boolean): _ZoteroTypes.Item[];
  getSelectedCollection(): _ZoteroTypes.Collection | null;
  itemsView?: _ZoteroTypes.ItemsView;
};

declare const ChromeUtils: {
  importESModule(url: string): Record<string, unknown>;
};

declare const Services: {
  scriptloader: {
    loadSubScript(url: string, scope?: unknown): void;
  };
  io: {
    newURI(spec: string): unknown;
  };
  prompt: {
    alert(parent: Window | null, title: string, text: string): void;
    confirm(parent: Window | null, title: string, text: string): boolean;
  };
};

/**
 * XUL document extensions available in Zotero's Gecko/Firefox context.
 * Standard Document doesn't include createXULElement.
 */
interface XULDocument extends Document {
  createXULElement(tagName: string): HTMLElement;
}

declare const dump: (msg: string) => void;

// Bootstrap lifecycle constants
declare const APP_SHUTDOWN: number;
