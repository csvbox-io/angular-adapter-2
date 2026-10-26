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
import {
  buildImportUrl,
  generateUuid,
  buildInitPayload,
  createModalLifecycle,
  createMessageGate,
  createImportTracker,
  createFileSender,
  classifyStructuredMessage,
  classifyLegacyMessage,
  registerOpenImporter,
  unregisterOpenImporter,
  isBlockedByOpenImporter,
  subscribeOpenImporters,
  restackOpenImporters,
  OpenImporterEntry
} from '@csvbox/adapter';

// How long we wait for the importer to confirm a file it was sent before giving up on it.
const FILE_ACK_TIMEOUT_MS = 8000;

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
  @Input() submitted?: (metadata: any) => void;
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
  // No longer read: whether to open once the iframe has loaded is tracked by `lifecycle`. Kept so
  // templates that already bind it still compile.
  @Input() openModalOnIframeLoad: boolean = false;

  @Input() lazy: boolean = false;

  safeUrl: SafeUrl | null = null;

  iframe: HTMLIFrameElement | null = null;

  @Input() disabled: boolean = true;

  constructor(public sanitizer: DomSanitizer, private cdr: ChangeDetectorRef, private zone: NgZone) {}

  // True while a different importer on the page is open: the button stays disabled.
  blockedByOther: boolean = false;

  private lifecycle = createModalLifecycle();
  private messageGate = createMessageGate();
  private closeReported = false;
  private importTracker = createImportTracker();

  private registryEntry: OpenImporterEntry = { getHolder: () => this.holder };

  private fileSender = createFileSender({
    getIframe: () => this.iframe,
    getToken: () => this.uuid as string,
    getTargetOrigin: () => this.targetOrigin as string,
    getBaseDomain: () => this.baseDomain,
    takeFile: () => {
      const file = this.pendingFile;
      this.pendingFile = null;
      return file;
    },
    onSent: () => this.startFileAckTimer()
  });

  private unsubscribeOpenImporters: (() => void) | null = null;

  holder: HTMLDivElement | null = null;

  pendingFile: File | null = null;

  targetOrigin: string | undefined;

  // Data-location sheets redirect to another host, so the iframe origin can differ from
  // targetOrigin. baseDomain is used to check the real origin before trusting it.
  baseDomain: string = "app.csvbox.io";

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
      // A newer importer sends the typed message as well; act on that one only.
      if (!this.messageGate.allowLegacy()) {
        return;
      }
      const ended = this.importTracker.observe(legacy);
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
      this.finishImport(ended);
      return;
    }

    // File handshake messages (what openModalWithFile waits for). handleMessage also learns the
    // importer's origin from any message that carries this instance's token.
    const fileMessage = this.fileSender.handleMessage(event);
    if (fileMessage) {
      if (fileMessage.type === "probe-reply") {
        // Reply to our probe (it has no file). It only tells us the origin, so do nothing.
        return;
      }
      if (fileMessage.type === "modal-shown") {
        this.clearFileAckTimer();
        registerOpenImporter(this.registryEntry);
        // What the file path in openModal() is waiting for. display as well as
        // pointer-events: a second file declined while the first was still opening the
        // modal has put the holder away in the meantime.
        this.isModalShown = true;
        this.closeReported = false;
        this.lifecycle.requestOpen();
        if (this.holder) {
          this.holder.style.display = 'block';
          this.holder.style.pointerEvents = 'auto';
        }
        return;
      }
      if (fileMessage.type === "rejected") {
        this.clearFileAckTimer();
        // The importer has the file and will not take it. Put the holder away only if the
        // modal was never confirmed up: a file declined while it is open leaves that modal
        // where it is, and its own 'csvbox-modal-hidden' will put the holder away.
        if (!this.isModalShown && this.holder) {
          this.holder.style.display = 'none';
          this.holder.style.pointerEvents = 'auto';
          unregisterOpenImporter(this.registryEntry);
        }
        console.warn("[csvbox] importer declined the supplied file: " + fileMessage.reason);
        return;
      }
    }

    const message = classifyStructuredMessage(event.data, this.uuid);
    if (!message) {
      return;
    }
    this.messageGate.markTyped();
    const ended = this.importTracker.observe(message);

    if (message.type === "data-on-submit") {
      if (this.onSubmit) this.onSubmit(message.metadata);
      if (this.isSubmitted) this.isSubmitted(message.metadata);
      if (this.submitted) this.submitted(message.metadata);
    } else if (message.type === "data-push-status") {
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
    this.finishImport(ended);
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
    window.removeEventListener("message", this.messageListener);
    // Takes the holder out of document.body: left there, it would keep covering the page with
    // an invisible full-screen layer that nothing is left to hide.
    this.destroyImporter();
    if (this.unsubscribeOpenImporters) {
      this.unsubscribeOpenImporters();
      this.unsubscribeOpenImporters = null;
    }
  }

  handleModalClosed(): void {
    // A repeated close message must not call onClose a second time. The flag is cleared when the importer is opened again.
    if (this.closeReported) {
      return;
    }
    this.closeReported = true;
    if (this.importTracker.isInFlight()) {
      // Closed after submitting and before the result arrived: keep the iframe and its listener
      // so the late result still reaches onImport. It is removed once that result has been
      // delivered (see finishImport), so the next open is a fresh load.
      if (this.holder) {
        this.holder.style.display = 'none';
        this.holder.style.pointerEvents = 'auto';
      }
      this.lifecycle.markHidden();
      this.isModalShown = false;
      this.clearFileAckTimer();
      unregisterOpenImporter(this.registryEntry);
    } else {
      this.destroyImporter();
    }
    if (this.onClose) this.onClose();
    if (this.isClosed) this.isClosed();
    if (this.closed) this.closed();
  }

  // Called after the result of an import has been delivered. If the modal was closed in the
  // meantime the iframe was only hidden, so remove it now.
  private finishImport(ended: boolean): void {
    if (ended && !this.isModalShown && this.iframe) {
      this.destroyImporter();
    }
  }

  // Puts the importer away: the next open builds a new iframe with a new token.
  private destroyImporter(): void {
    if (this.holder) {
      this.holder.style.display = 'none';
      this.holder.style.pointerEvents = 'auto';
      this.holder.remove();
    }
    this.holder = null;
    this.iframe = null;
    this.isModalShown = false;
    this.isIframeLoaded = false;
    this.lifecycle.markClosed();
    this.messageGate.reset();
    this.importTracker.reset();
    // A new iframe is built on the next open, so the origin is learned again.
    this.clearProbeTimer();
    unregisterOpenImporter(this.registryEntry);
  }

  initImporter(): void {
    if (this.loadStarted) this.loadStarted();

    this.uuid = generateUuid();
    this.messageGate.reset();
    this.importTracker.reset();
    this.closeReported = false;

    insertCSS();

    const iframe = document.createElement("iframe");
    this.iframe = iframe;
    iframe.setAttribute("src", this.safeUrl?.toString() || '');
    iframe.setAttribute("allow", "clipboard-read; clipboard-write *");
    iframe.frameBorder = "0";

    iframe.onload = () => {
      this.disabled = false;
      this.isIframeLoaded = true;
      // The handshake goes first: a consumer that calls openModalWithFile() from the ready
      // callback needs the importer to already have its customer, columns, options and token.
      if (this.iframe && this.iframe.contentWindow) {
        this.iframe.contentWindow.postMessage(buildInitPayload(this.user, this.dynamicColumns, this.options, this.uuid), "*");
      }
      if (this.onReady) this.onReady();
      if (this.isReady) this.isReady();
      if (this.importerReady) this.importerReady();

      if (this.lifecycle.markReady()) {
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
    restackOpenImporters();
  }

  openModal(): void {
    // Counts as open from the moment it is requested, so the other buttons are disabled while
    // this importer is still loading, and so it is stacked above any importer opened earlier.
    registerOpenImporter(this.registryEntry);
    this.closeReported = false;
    if (!this.iframe) {
      this.lifecycle.requestOpen();
      this.initImporter();
      return;
    }

    if (this.pendingFile) {
      if (!this.isIframeLoaded) {
        // Deferred: onload's markReady() calls openModal() again once the iframe is up.
        this.lifecycle.requestOpen();
        return;
      }
      // The importer opens its own modal once it has the file, so that it can inject on
      // 'shown.bs.modal'. Sending 'openModal' as well would race that.
      //
      // It can also decline: wrong step, an import file URL configured on the sheet, or an
      // importer too old to know the message at all. So the holder goes up click-through and
      // stays that way until 'csvbox-modal-shown' confirms the modal is really up. It covers the
      // viewport at z-index 2147483647 and the importer renders transparent with its modal
      // closed, so arming it on an unanswered message leaves an invisible sheet over the host
      // page eating every click.
      //
      // display:block regardless, so the iframe lays out and animates normally; only
      // pointer-events is held back. isModalShown likewise waits for the confirmation, or a
      // declined file would latch the importer shut for good.
      if (this.holder) {
        this.holder.style.pointerEvents = 'none';
        this.holder.style.display = 'block';
      }
      this.fileSender.send();
      return;
    }

    if (this.lifecycle.requestOpen()) {
      this.isModalShown = true;
      if (this.holder) {
        // Explicit: a previously declined file leaves the holder click-through.
        this.holder.style.pointerEvents = 'auto';
        this.holder.style.display = 'block';
      }
      if (this.iframe && this.iframe.contentWindow) {
        this.iframe.contentWindow.postMessage('openModal', '*');
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
      this.fileSender.send();
      return;
    }

    this.openModal();
  }

  clearProbeTimer(): void {
    this.clearFileAckTimer();
    this.fileSender.reset();
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
