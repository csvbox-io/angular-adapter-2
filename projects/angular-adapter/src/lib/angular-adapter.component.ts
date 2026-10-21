import {
  Component,
  OnInit,
  Input,
  OnChanges,
  SimpleChanges,
  SecurityContext,
  AfterContentInit,
  OnDestroy
} from '@angular/core';

import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { insertCSS } from './utils/insertCSS';
import { buildImportUrl, generateUuid, buildInitPayload, classifyStructuredMessage, classifyLegacyMessage } from '@csvbox/adapter';

// How long we wait for the importer to reply before sending the file anyway.
const ORIGIN_PROBE_TIMEOUT_MS = 1500;

const appVersion = '1.1.16';

@Component({
  selector: 'csvbox-button',
  standalone: true,
  template: `
    <div>
      <button [disabled]="disabled" (click)="openModal()" [attr.data-csvbox-token]="uuid">
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

  constructor(public sanitizer: DomSanitizer) {}

  holder: HTMLDivElement | null = null;

  pendingFile: File | null = null;

  targetOrigin: string | undefined;

  // Data-location sheets redirect to another host, so the iframe origin can differ from
  // targetOrigin. baseDomain is used to check the real origin before trusting it.
  baseDomain: string = "app.csvbox.io";

  importerOrigin: string | null = null;

  probingOrigin: boolean = false;

  private probeTimer: any = null;

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
        // The importer has the file and will not take it. Put the holder away only if the
        // modal was never confirmed up: a file declined while it is open leaves that modal
        // where it is, and its own 'csvbox-modal-hidden' will put the holder away.
        if (!this.isModalShown && this.holder) {
          this.holder.style.display = 'none';
          this.holder.style.pointerEvents = 'auto';
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

    if (this.lazy) {
      this.disabled = false;
    } else {
      this.disabled = true;
      this.initImporter();
    }
  }

  ngOnDestroy(): void {
    this.clearProbeTimer();
    window.removeEventListener("message", this.messageListener);
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
  }

  openModal(): void {
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
    if(this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }
}
