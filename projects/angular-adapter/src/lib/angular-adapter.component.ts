import {
  Component,
  OnInit,
  Input,
  OnChanges,
  SimpleChanges,
  SecurityContext,
  AfterContentInit,
  OnDestroy,
  ChangeDetectorRef,
  NgZone
} from '@angular/core';

import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { insertCSS } from './utils/insertCSS';
import { buildImportUrl, generateUuid, buildInitPayload, classifyStructuredMessage, classifyLegacyMessage } from '@csvbox/adapter';

// How long we wait for the importer to reply before sending the file anyway.
const ORIGIN_PROBE_TIMEOUT_MS = 1500;
// How long we wait for the importer to confirm a file it was sent before giving up on it.
const FILE_ACK_TIMEOUT_MS = 8000;

// Page-wide record of the importers that are open or opening, shared by every CSVBox adapter
// on the page (it lives on window so separate copies of an adapter see the same list). It does
// two things: the newest importer is stacked on top (every holder is fixed, full screen and
// z-index 2147483647, so equal z-indexes would leave the one that comes first in the DOM on
// top), and the other instances learn that an importer is open so they can disable their button.
interface OpenImporterEntry { getHolder: () => HTMLElement | null; }
interface OpenImporters { open: OpenImporterEntry[]; listeners: Array<() => void>; }
const OPEN_IMPORTERS_KEY = '__csvboxOpenImporters';
const TOP_Z_INDEX = 2147483647;

function openImporters(): OpenImporters {
  const w = window as any;
  if (!w[OPEN_IMPORTERS_KEY]) w[OPEN_IMPORTERS_KEY] = { open: [], listeners: [] };
  return w[OPEN_IMPORTERS_KEY];
}

function restackOpenImporters(reg: OpenImporters): void {
  reg.open.forEach((entry, i) => {
    const holder = entry.getHolder();
    if (holder) holder.style.zIndex = String(TOP_Z_INDEX - (reg.open.length - 1 - i));
  });
}

function registerOpenImporter(entry: OpenImporterEntry): void {
  const reg = openImporters();
  if (reg.open.indexOf(entry) >= 0) return;
  reg.open.push(entry);
  restackOpenImporters(reg);
  reg.listeners.slice().forEach(fn => fn());
}

function unregisterOpenImporter(entry: OpenImporterEntry): void {
  const reg = openImporters();
  const i = reg.open.indexOf(entry);
  if (i < 0) return;
  reg.open.splice(i, 1);
  restackOpenImporters(reg);
  reg.listeners.slice().forEach(fn => fn());
}

function isBlockedByOpenImporter(entry: OpenImporterEntry): boolean {
  const reg = openImporters();
  return reg.open.length > 0 && reg.open.indexOf(entry) < 0;
}

function subscribeOpenImporters(fn: () => void): () => void {
  const reg = openImporters();
  reg.listeners.push(fn);
  return () => {
    const i = reg.listeners.indexOf(fn);
    if (i >= 0) reg.listeners.splice(i, 1);
  };
}

const appVersion = '1.1.16';

@Component({
  selector: 'csvbox-button',
  standalone: true,
  template: `
    <div>
      <button [disabled]="disabled || blockedByOther" (click)="openModal()" [attr.data-csvbox-token]="uuid">
        <ng-content></ng-content>
      </button>
    </div>
  `
})

export class CSVBoxButtonComponent implements OnInit, OnChanges, AfterContentInit, OnDestroy {

  isModalShown = false;

  @Input() onImport?: (success: boolean, metadata?: any) => void;
  @Input() onReady?: () => void;
  @Input() onClose?: () => void;
  @Input() onSubmit?: (metadata: any) => void;

  @Input() isImported?: (success: boolean, metadata?: any) => void;
  @Input() isReady?: () => void;
  @Input() isClosed?: () => void;
  @Input() isSubmitted?: (metadata: any) => void;

  @Input() importerReady?: () => void;
  @Input() closed?: () => void;
  @Input() submitted?: () => void;
  @Input() imported?: (success: boolean, metadata?: any) => void;
  @Input() loadStarted?: () => void;

  @Input() user: { [key: string]: any } | null = null;
  @Input() dynamicColumns: { [key: string]: any } | null = null;
  @Input() licenseKey: string | null = null;
  @Input() options: { [key: string]: any } | null = null;
  @Input() uuid: string = '';
  @Input() customDomain: string | null = null;
  @Input() dataLocation: string | null = null;
  @Input() language: string | null = null;
  @Input() environment: { [key: string]: any } | null = null;

  @Input() theme: string | null = null;

  @Input() isIframeLoaded: boolean = false;
  @Input() openModalOnIframeLoad: boolean = false;

  @Input() lazy: boolean = false;

  safeUrl: SafeUrl | null = null;

  iframe: HTMLIFrameElement | null = null;

  @Input() disabled: boolean = true;

  constructor(public sanitizer: DomSanitizer, private cdr: ChangeDetectorRef, private zone: NgZone) {}

  // True while a different importer on the page is open: the button stays disabled.
  blockedByOther: boolean = false;

  private registryEntry: OpenImporterEntry = { getHolder: () => this.holder };

  private unsubscribeOpenImporters: (() => void) | null = null;

  holder: HTMLDivElement | null = null;

  pendingFile: File | null = null;

  targetOrigin: string | undefined;

  // Data-location sheets redirect to another host, so the iframe origin can differ from
  // targetOrigin. baseDomain is used to check the real origin before trusting it.
  baseDomain: string = "app.csvbox.io";

  importerOrigin: string | null = null;

  probingOrigin: boolean = false;

  private probeTimer: any = null;
  private fileAckTimer: any = null;

  ngOnInit(): void {
    this.uuid = generateUuid();
    const iframeUrl = buildImportUrl(
      {
        licenseKey: this.licenseKey,
        customDomain: this.customDomain,
        dataLocation: this.dataLocation,
        language: this.language,
        theme: this.theme,
        environment: this.environment
      },
      "angular",
      appVersion
    );
    // Default place to send the file. A file is only ever sent to a named origin, never "*".
    this.targetOrigin = new URL(iframeUrl).origin;
    this.baseDomain = this.customDomain || "app.csvbox.io";
    this.safeUrl = this.sanitizer.sanitize(SecurityContext.RESOURCE_URL, this.sanitizer.bypassSecurityTrustResourceUrl(iframeUrl));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['user'] && changes['user'].currentValue !== changes['user'].previousValue) {
      this.updateUserVariable(changes['user'].currentValue);
    }
  }

  updateUserVariable(data: { [key: string]: any }): void {
    this.user = data;
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({
        "customer": data
      }, "*");
    }
  }

  private messageListener = (event: MessageEvent) => {
    // Older importers send these as bare strings, without a token.
    const legacy = classifyLegacyMessage(event.data);
    if (legacy) {
      // Legacy messages carry no token, so the only way to tell which importer sent one is its
      // window. Ignore those that came from another instance's iframe (or anywhere else).
      if (!this.iframe || event.source !== this.iframe.contentWindow) {
        return;
      }
      if (legacy.type === "mainModalHidden") {
        this.handleModalClosed();
      } else if (legacy.type === "uploadSuccessful") {
        if (this.onImport) this.onImport(true);
        if (this.isImported) this.isImported(true);
        if (this.imported) this.imported(true);
      } else if (legacy.type === "uploadFailed") {
        if (this.onImport) this.onImport(false);
        if (this.isImported) this.isImported(false);
        if (this.imported) this.imported(false);
      }
      return;
    }

    // Set-file handshake messages. The shared core does not classify these, so they are
    // read here, behind the same unique_token check the core applies.
    const raw = event.data;
    if (raw && typeof raw === "object" && raw.data && raw.data.unique_token == this.uuid) {
      this.learnImporterOrigin(event);

      if (raw.type === "csvbox-set-file-rejected" && raw.data.reason === "not-a-file") {
        // Reply to our probe (it has no file). It only tells us the origin, so do nothing.
        return;
      }
      if (raw.type === "csvbox-modal-shown") {
        this.clearFileAckTimer();
        registerOpenImporter(this.registryEntry);
        // What the file path in openModal() is waiting for. display as well as
        // pointer-events: a second file declined while the first was still opening the
        // modal has put the holder away in the meantime.
        this.isModalShown = true;
        if (this.holder) {
          this.holder.style.display = 'block';
          this.holder.style.pointerEvents = 'auto';
        }
        return;
      }
      if (raw.type === "csvbox-set-file-rejected") {
        this.clearFileAckTimer();
        // The importer has the file and will not take it. Put the holder away only if the
        // modal was never confirmed up: a file declined while it is open leaves that modal
        // where it is, and its own 'csvbox-modal-hidden' will put the holder away.
        if (!this.isModalShown && this.holder) {
          this.holder.style.display = 'none';
          this.holder.style.pointerEvents = 'auto';
          unregisterOpenImporter(this.registryEntry);
        }
        console.warn("[csvbox] importer declined the supplied file: " + raw.data.reason);
        return;
      }
    }

    const message = classifyStructuredMessage(event.data, this.uuid);
    if (!message) {
      return;
    }

    if (message.type === "data-on-submit") {
      if (this.onSubmit) this.onSubmit(message.metadata);
      if (this.isSubmitted) this.isSubmitted(message.metadata);
      if (this.submitted) this.submitted();
    } else if (message.type === "data-push-status") {
      if (!message.success) {
        delete message.metadata["unique_token"];
      }
      if (this.onImport) this.onImport(message.success, message.metadata);
      if (this.isImported) this.isImported(message.success, message.metadata);
      if (this.imported) this.imported(message.success, message.metadata);
    } else if (message.type === "csvbox-modal-hidden") {
      this.handleModalClosed();
    } else if (message.type === "csvbox-upload-successful") {
      if (this.onImport) this.onImport(true);
      if (this.isImported) this.isImported(true);
      if (this.imported) this.imported(true);
    } else if (message.type === "csvbox-upload-failed") {
      if (this.onImport) this.onImport(false);
      if (this.isImported) this.isImported(false);
      if (this.imported) this.imported(false);
    }
  };

  ngAfterContentInit(): void {
    window.addEventListener("message", this.messageListener, false);
    this.syncBlocked();
    this.unsubscribeOpenImporters = subscribeOpenImporters(() => this.syncBlocked());

    if (this.lazy) {
      this.disabled = false;
    } else {
      this.disabled = true;
      this.initImporter();
    }
  }

  private syncBlocked(): void {
    const blocked = isBlockedByOpenImporter(this.registryEntry);
    if (blocked !== this.blockedByOther) {
      // The registry can call back from outside Angular's zone (another instance, another app).
      this.zone.run(() => {
        this.blockedByOther = blocked;
        this.cdr.markForCheck();
      });
    }
  }

  ngOnDestroy(): void {
    this.clearProbeTimer();
    window.removeEventListener("message", this.messageListener);
    unregisterOpenImporter(this.registryEntry);
    if (this.unsubscribeOpenImporters) {
      this.unsubscribeOpenImporters();
      this.unsubscribeOpenImporters = null;
    }
  }

  handleModalClosed(): void {
    if (this.holder) {
      this.holder.style.display = 'none';
      this.holder.style.pointerEvents = 'auto';
    }
    this.isModalShown = false;
    this.isIframeLoaded = false;
    this.openModalOnIframeLoad = false;
    if (this.holder) this.holder.remove();
    this.holder = null;
    this.iframe = null;
    // A new iframe is built on the next open, so the origin is learned again.
    this.importerOrigin = null;
    this.probingOrigin = false;
    this.clearProbeTimer();
    unregisterOpenImporter(this.registryEntry);
    if (this.onClose) this.onClose();
    if (this.isClosed) this.isClosed();
    if (this.closed) this.closed();
  }

  initImporter(): void {
    if (this.loadStarted) this.loadStarted();

    this.uuid = generateUuid();

    insertCSS();

    const iframe = document.createElement("iframe");
    this.iframe = iframe;
    iframe.setAttribute("src", this.safeUrl?.toString() || '');
    iframe.setAttribute("allow", "clipboard-read; clipboard-write *");
    iframe.frameBorder = "0";

    iframe.onload = () => {
      if (this.onReady) this.onReady();
      if (this.isReady) this.isReady();
      if (this.importerReady) this.importerReady();

      this.disabled = false;
      this.isIframeLoaded = true;
      if (this.iframe && this.iframe.contentWindow) {
        this.iframe.contentWindow.postMessage(buildInitPayload(this.user, this.dynamicColumns, this.options, this.uuid), "*");
      }
      if (this.openModalOnIframeLoad) {
        this.openModal();
      }
    };

    this.holder = document.createElement('div');
    this.holder.classList.add('csvbox-holder');
    this.holder.setAttribute('id', `csvbox-embed-${this.uuid}`);
    this.holder.appendChild(iframe);

    document.body.insertAdjacentElement(
      'beforeend', this.holder
    );
    // The holder did not exist yet if openModal() asked for the importer before it was built.
    restackOpenImporters(openImporters());
  }

  openModal(): void {
    // Counts as open from the moment it is requested, so the other buttons are disabled while
    // this importer is still loading, and so it is stacked above any importer opened earlier.
    registerOpenImporter(this.registryEntry);
    if(!this.iframe) {
        this.openModalOnIframeLoad = true;
        this.initImporter();
        return;
    }
    if(!this.isModalShown) {
      if(this.isIframeLoaded) {
        if(this.pendingFile) {
          // The importer opens its own modal once it has the file, so that it can inject on
          // 'shown.bs.modal'. Sending 'openModal' as well would race that.
          //
          // It can also decline: wrong step, an import file URL configured on the sheet, or
          // an importer too old to know the message at all. So the holder goes up
          // click-through and stays that way until 'csvbox-modal-shown' confirms the modal
          // is really up. It covers the viewport at z-index 2147483647 and the importer
          // renders transparent with its modal closed, so arming it on an unanswered message
          // leaves an invisible sheet over the host page eating every click.
          //
          // display:block regardless, so the iframe lays out and animates normally; only
          // pointer-events is held back. isModalShown likewise waits for the confirmation,
          // or a declined file would latch the importer shut for good.
          if(this.holder) {
            this.holder.style.pointerEvents = 'none';
            this.holder.style.display = 'block';
          }
          this.postPendingFile();
        } else {
          this.isModalShown = true;
          if(this.holder) {
            // Explicit: a previously declined file leaves the holder click-through.
            this.holder.style.pointerEvents = 'auto';
            this.holder.style.display = 'block';
          }
          if(this.iframe && this.iframe.contentWindow) {
            this.iframe.contentWindow.postMessage('openModal', '*');
          }
        }
      } else {
          this.openModalOnIframeLoad = true;
      }
    }
  }

  /**
   * Open the importer on a File the host page already has, instead of the file picker.
   *
   * Reachable through a template reference (`#importer` then `importer.openModalWithFile(file)`)
   * or `@ViewChild(CSVBoxButtonComponent)`.
   *
   * The File crosses to the iframe by structured clone, so the importer receives the real
   * object and applies its own extension, worksheet and size rules to it -- this does not
   * bypass any of them. Pass a File; a Blob has no name for the importer to read an
   * extension from.
   */
  openModalWithFile(file: File): void {
    if(typeof File === 'undefined' || !(file instanceof File)) {
      return;
    }

    this.pendingFile = file;

    // Already open: hand it over now rather than holding it for the next open. The importer
    // takes it only while it is still on the upload step, and ignores it once the user has a
    // dataset and a mapping in progress.
    if(this.isModalShown && this.iframe && this.isIframeLoaded) {
      this.postPendingFile();
      return;
    }

    this.openModal();
  }

  postPendingFile(): void {
    if(this.importerOrigin) {
      this.sendPendingFile(this.importerOrigin);
      return;
    }

    // Origin not known yet: send a probe without the file, and send the file to the origin
    // that replies. If nobody replies in time, use targetOrigin like before.
    if(this.probingOrigin) {
      return;
    }
    if(this.iframe && this.iframe.contentWindow) {
      this.probingOrigin = true;
      this.iframe.contentWindow.postMessage({
        type: 'csvbox-set-file',
        unique_token: this.uuid
      }, '*');
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        this.probingOrigin = false;
        this.sendPendingFile(this.targetOrigin as string);
      }, ORIGIN_PROBE_TIMEOUT_MS);
    }
  }

  sendPendingFile(origin: string): void {
    if(!this.pendingFile || !this.iframe || !this.iframe.contentWindow) {
      return;
    }
    this.iframe.contentWindow.postMessage({
      type: 'csvbox-set-file',
      file: this.pendingFile,
      unique_token: this.uuid
    }, origin);
    this.pendingFile = null;
    this.startFileAckTimer();
  }

  // Remember the importer's origin, only from our own iframe, with our token, and a csvbox host.
  learnImporterOrigin(event: MessageEvent): void {
    if(this.importerOrigin || !this.iframe || event.source !== this.iframe.contentWindow) {
      return;
    }
    if(!this.isImporterOrigin(event.origin)) {
      return;
    }
    this.importerOrigin = event.origin;
    if(this.probingOrigin) {
      this.probingOrigin = false;
      this.clearProbeTimer();
      this.sendPendingFile(this.importerOrigin);
    }
  }

  isImporterOrigin(origin: string): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch (e) {
      return false;
    }
    if(url.protocol !== 'https:') {
      return false;
    }
    return url.host === this.baseDomain || url.host.endsWith(`-${this.baseDomain}`);
  }

  clearProbeTimer(): void {
    this.clearFileAckTimer();
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  startFileAckTimer(): void {
    this.clearFileAckTimer();
    this.fileAckTimer = setTimeout(() => {
      this.fileAckTimer = null;
      this.giveUpOnFile();
    }, FILE_ACK_TIMEOUT_MS);
  }

  clearFileAckTimer(): void {
    if (this.fileAckTimer) {
      clearTimeout(this.fileAckTimer);
      this.fileAckTimer = null;
    }
  }

  // The importer never confirmed the file it was sent (an origin we do not trust, or an importer too
  // old to know the message). Without this the holder would stay up, invisible and click-through,
  // and the other instances' buttons would stay disabled for good.
  giveUpOnFile(): void {
    if (this.isModalShown) {
      return;
    }
    const holder = this.holder;
    if (holder) {
      holder.style.display = 'none';
      holder.style.pointerEvents = 'auto';
    }
    unregisterOpenImporter(this.registryEntry);
    console.warn("[csvbox] the importer did not respond to the supplied file");
  }
}
