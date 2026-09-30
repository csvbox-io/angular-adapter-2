import {
  Component,
  OnInit,
  ViewChild,
  Input,
  OnChanges,
  SimpleChanges,
  SecurityContext,
  AfterContentInit
} from '@angular/core';

import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { insertCSS } from './utils/insertCSS';

// Sent to the importer as `library-version`, and deliberately NOT this package's version. The
// importer picks its message protocol from it: with framework=angular, 1.0.6 (tested against
// app.csvbox.io, 2026-09-30) gets the legacy `mainModalShown` instead of `csvbox-modal-shown`,
// which breaks openModalWithFile(). Every @csvbox/angular2 release so far has sent 1.1.16.
const appVersion = '1.1.16';

@Component({
  selector: 'csvbox-button',
  standalone: true,
  template: `
    <div>
      <button [disabled]="disabled" #initiator (click)="openModal()" [attr.data-csvbox-token]="uuid">
        <ng-content></ng-content>
      </button>
    </div>
  `
})

export class CSVBoxButtonComponent implements OnInit, OnChanges, AfterContentInit {

  isModalShown = false;

  @ViewChild('initiator', { static: false }) initiator: any;
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

  targetOrigin: string = '';

  ngOnInit(): void {
    this.uuid = this.generateUuid();
    let domain = this.customDomain ? this.customDomain : "app.csvbox.io";
    if (this.dataLocation) { domain = `${this.dataLocation}-${domain}`; }
    // Only postPendingFile() uses this. The config messages keep their "*" target: narrowing
    // those would silently drop the handshake for any customDomain that redirects to another
    // host, and breaking existing importers is not worth it. A file is different — its bytes
    // are the end user's, so they go to a named origin or nowhere.
    this.targetOrigin = `https://${domain}`;
    let iframeUrl = `https://${domain}/embed/${this.licenseKey}`;
    iframeUrl += `?library-version=${appVersion}`;
    iframeUrl += "&framework=angular";
    if (this.dataLocation) {
      iframeUrl += "&preventRedirect";
    }
    if (this.language) {
      iframeUrl += "&language=" + this.language;
    }
    if (this.theme) {
      iframeUrl += "&theme=" + this.theme;
    }
    if (this.environment) {
      const environment = JSON.stringify(this.environment).replace(/['"]/g, (match) => '\\' + match);
      iframeUrl += `&env=${environment}`;
    }
    this.safeUrl = this.sanitizer.sanitize(SecurityContext.RESOURCE_URL, this.sanitizer.bypassSecurityTrustResourceUrl(iframeUrl));
  }

  generateUuid(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
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

  ngAfterContentInit(): void {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event && typeof event.data === "object") {
        if (event.data && event.data.data && event.data.data.unique_token === this.uuid) {
          if (event.data.type && event.data.type === "data-on-submit") {
            const metadata = event.data.data;
            metadata["column_mappings"] = event.data.column_mapping;
            delete metadata["unique_token"];
            if (this.onSubmit) this.onSubmit(metadata);
            if (this.isSubmitted) this.isSubmitted(metadata);
            if (this.submitted) this.submitted();
          } else if (event.data.type && event.data.type === "data-push-status") {
            if (event.data.data.import_status === "success") {
              if (event.data.row_data) {
                const primary_row_data = event.data.row_data;
                const headers = event.data.headers;
                const rows: any[] = [];
                const dynamic_columns_indexes = event.data.dynamicColumnsIndexes;
                const virtual_columns_indexes = event.data.virtualColumnsIndexes || [];

                primary_row_data.forEach((row_data: any) => {
                  const x: { [key: string]: any } = {};
                  const dynamic_columns: { [key: string]: any } = {};
                  const virtual_data: { [key: string]: any } = {};

                  row_data.data && row_data.data.forEach((col: any, i: number) => {
                    if (col === undefined) { col = ""; }

                    if (dynamic_columns_indexes.includes(i)) {
                      dynamic_columns[headers[i]] = col;
                    } else if (virtual_columns_indexes.includes(i)) {
                      virtual_data[headers[i]] = col;
                    } else {
                      x[headers[i]] = col;
                    }
                  });
                  if (row_data && row_data.unmapped_data) {
                    x["_unmapped_data"] = row_data.unmapped_data;
                  }
                  if (dynamic_columns && Object.keys(dynamic_columns).length > 0) {
                    x["_dynamic_data"] = dynamic_columns;
                  }
                  if (virtual_data && Object.keys(virtual_data).length > 0) {
                    x["_virtual_data"] = virtual_data;
                  }
                  rows.push(x);
                });
                const metadata = event.data.data;
                metadata["rows"] = rows;
                metadata["column_mappings"] = event.data.column_mapping;
                metadata["raw_columns"] = event.data.raw_columns;
                metadata["ignored_columns"] = event.data.ignored_column_row;
                delete metadata["unique_token"];
                if (this.onImport) this.onImport(true, metadata);
                if (this.isImported) this.isImported(true, metadata);
                if (this.imported) this.imported(true, metadata);
              } else {
                const metadata = event.data.data;
                delete metadata["unique_token"];
                if (this.onImport) this.onImport(true, metadata);
                if (this.isImported) this.isImported(true, metadata);
                if (this.imported) this.imported(true, metadata);
              }
            } else {
              const metadata = event.data.data;
              delete metadata["unique_token"];
              if (this.onImport) this.onImport(false, metadata);
              if (this.isImported) this.isImported(false, metadata);
              if (this.imported) this.imported(false, metadata);
            }
          } else if (event.data.type && event.data.type === "csvbox-modal-shown") {
            // What the file path in openModal() is waiting for. display as well as
            // pointer-events: a second file declined while the first was still opening the
            // modal has put the holder away in the meantime.
            this.isModalShown = true;
            if (this.holder) {
              this.holder.style.display = 'block';
              this.holder.style.pointerEvents = 'auto';
            }
          } else if (event.data.type && event.data.type === "csvbox-set-file-rejected") {
            // The importer has the file and will not take it. Put the holder away only if the
            // modal was never confirmed up: a file declined while it is open (an import past
            // the upload step, a fade-out under way) leaves that modal where it is, and its
            // own 'csvbox-modal-hidden' will put the holder away when it closes.
            if (!this.isModalShown && this.holder) {
              this.holder.style.display = 'none';
              this.holder.style.pointerEvents = 'auto';
            }
            console.warn("[csvbox] importer declined the supplied file: " + event.data.data.reason);
          } else if (event.data.type && event.data.type === "csvbox-modal-hidden") {
            if (this.holder) {
              this.holder.style.display = 'none';
              this.holder.style.pointerEvents = 'auto';
            }
            this.isModalShown = false;
            if (this.onClose) this.onClose();
            if (this.isClosed) this.isClosed();
            if (this.closed) this.closed();
          } else if (event.data.type && event.data.type === "csvbox-upload-successful") {
            if (this.onImport) this.onImport(true);
            if (this.isImported) this.isImported(true);
            if (this.imported) this.imported(true);
          } else if (event.data.type && event.data.type === "csvbox-upload-failed") {
            if (this.onImport) this.onImport(false);
            if (this.isImported) this.isImported(false);
            if (this.imported) this.imported(false);
          }
        }
      }
    }, false);

    if (this.lazy) {
      this.disabled = false;
    } else {
      this.disabled = true;
      this.initImporter();
    }
  }

  initImporter(): void {
    if (this.loadStarted) this.loadStarted();

    insertCSS();

    const iframe = document.createElement("iframe");
    this.iframe = iframe;
    iframe.setAttribute("src", this.safeUrl?.toString() || '');
    iframe.setAttribute("allow", "clipboard-read; clipboard-write *");
    iframe.frameBorder = "0";

    const self = this;
    iframe.onload = function () {
      if (self.onReady) self.onReady();
      if (self.isReady) self.isReady();
      if (self.importerReady) self.importerReady();

      self.disabled = false;
      self.isIframeLoaded = true;
      if (self.iframe && self.iframe.contentWindow) {
        self.iframe.contentWindow.postMessage({
          "customer": self.user ? self.user : null,
          "columns": self.dynamicColumns ? self.dynamicColumns : null,
          "options": self.options ? self.options : null,
          "unique_token": self.uuid
        }, "*");
      }
      if (self.openModalOnIframeLoad) {
        self.openModal();
      }
    }

    this.holder = document.createElement('div');
    this.holder.classList.add('csvbox-holder');
    this.holder.setAttribute('id', `csvbox-embed-${this.uuid}`);
    this.holder.appendChild(iframe);

    document.body.insertAdjacentElement(
      'beforeend', this.holder
    );
  }

  openModal(): void {
    if (this.lazy) {
      if (!this.iframe) {
        this.openModalOnIframeLoad = true;
        this.initImporter();
        return;
      }
    }
    if (!this.isModalShown) {
      if (this.isIframeLoaded) {
        if (this.pendingFile) {
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
          if (this.holder) {
            this.holder.style.pointerEvents = 'none';
            this.holder.style.display = 'block';
          }
          this.postPendingFile();
        } else {
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
   * object and applies its own extension, worksheet and size rules to it — this does not
   * bypass any of them. Pass a File; a Blob has no name for the importer to read an
   * extension from.
   */
  openModalWithFile(file: File): void {
    if (typeof File === 'undefined' || !(file instanceof File)) {
      return;
    }

    this.pendingFile = file;

    // Already open: hand it over now rather than holding it for the next open. The importer
    // takes it only while it is still on the upload step, and ignores it once the user has a
    // dataset and a mapping in progress.
    if (this.isModalShown && this.iframe && this.isIframeLoaded) {
      this.postPendingFile();
      return;
    }

    this.openModal();
  }

  postPendingFile(): void {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({
        type: 'csvbox-set-file',
        file: this.pendingFile,
        unique_token: this.uuid
      }, this.targetOrigin);
    }
    this.pendingFile = null;
  }
}
