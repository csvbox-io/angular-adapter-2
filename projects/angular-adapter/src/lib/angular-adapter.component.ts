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
import { buildImportUrl, generateUuid, buildInitPayload, classifyStructuredMessage } from '@csvbox/adapter';

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
    window.removeEventListener("message", this.messageListener);
  }

  handleModalClosed(): void {
    if (this.holder) this.holder.style.display = 'none';
    this.isModalShown = false;
    this.isIframeLoaded = false;
    this.openModalOnIframeLoad = false;
    if (this.holder) this.holder.remove();
    this.holder = null;
    this.iframe = null;
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
    if (!this.iframe) {
      this.openModalOnIframeLoad = true;
      this.initImporter();
      return;
    }
    if (!this.isModalShown) {
      if (this.isIframeLoaded) {
        this.isModalShown = true;
        if (this.holder) this.holder.style.display = 'block';
        if (this.iframe && this.iframe.contentWindow) {
          this.iframe.contentWindow.postMessage('openModal', '*');
        }
      } else {
        this.openModalOnIframeLoad = true;
      }
    }
  }
}
