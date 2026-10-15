# @csvbox/angular2

> Standalone Angular component for csvbox.io supporting Angular version 14 and above

## ✅ Only for Angular version 14 and above
## ⚠️ For Angular version 13 or less, please use [@csvbox/angular](https://www.npmjs.com/package/@csvbox/angular) package

[![NPM](https://img.shields.io/npm/v/@csvbox/angular2.svg)](https://www.npmjs.com/package/@csvbox/angular2) [![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

## Compatibility

| Angular Version	 | Package |
| ------ | ------ |
|8 to 13|[@csvbox/angular](https://www.npmjs.com/package/@csvbox/angular)|
|14 and above|@csvbox/angular2 (this package)|

## Shell

```bash
npm install @csvbox/angular2
```

## Import
Add `CSVBoxButtonComponent` to your module imports
```ts
import { CSVBoxButtonComponent } from "@csvbox/angular2";

@NgModule({
  ...
  imports: [
    ...
    CSVBoxButtonComponent
  ]
})
```

## Usage

```html
<csvbox-button [licenseKey]="licenseKey" [isImported]="isImported.bind(this)" [user]="user">Import</csvbox-button>
```

## Example

```ts

@Component({
  selector: 'app-root',
  template: `
    <csvbox-button
      [licenseKey]="licenseKey"
      [user]="user"
      [isImported]="isImported.bind(this)">
      Import
    </csvbox-button>
  `
})

export class AppComponent {

  title = 'example';
  licenseKey = 'YOUR_LICENSE_KEY_HERE';
  user = { user_id: 'default123' };

  isImported(result: boolean, data: any) {
    if(result) {
      console.log("Sheet uploaded successfully");
      console.log(data.row_success + " rows uploaded");
    }else{
      console.log("There was some problem uploading the sheet");
    }
  }

}
```

## Events

| Event       | Description                                                               |
| :---------- | :-------------------------------------------------------------------------|
| `isReady`   | Triggers when the importer is initialized and ready for use by the users. |
| `isClosed`   | Triggers when the importer is closed.                                     |
| `isSubmitted`   | Triggers when the user hits the 'Submit' button to upload the validated file. **data** object is available in this event. It contains metadata related to the import.|
| `isImported`   | Triggers when the data is pushed to the destination.<br>Two objects are available in this event:<br>1. result (boolean): It is true when the import is successful and false when the import fails.<br>2. data (object): Contains metadata related to the import.|

## Importing a file you already have

`openModalWithFile(file)` opens the importer on a `File` your own page is holding — from your
own drop target, your own file input, anything — instead of the importer's file picker. The
file still goes through the importer's extension, worksheet and size checks; this skips the
picker, not the validation.

Call it through a template reference variable:

```html
<csvbox-button #importer [licenseKey]="licenseKey" [user]="user" [isImported]="isImported.bind(this)">
  Import
</csvbox-button>

<input type="file" (change)="importer.openModalWithFile($any($event.target).files[0])" />
```

or from the component class with `@ViewChild(CSVBoxButtonComponent) importer: CSVBoxButtonComponent;`
and `this.importer.openModalWithFile(file)`.

The importer can decline a file it is handed, and says why in a console warning
(`[csvbox] importer declined the supplied file: <reason>`):

- `import-in-progress` — the importer is open past its upload step, or is still reading an
  earlier file. An import that is already open stays open.
- `modal-closing` — the importer was closing when the file arrived.
- `import-file-url-configured` — the sheet is set up to load its own file from a URL.

Pass a `File`, not a `Blob`: a `Blob` has no name to read an extension from, and anything that
is not a `File` is ignored.

## Readme

For usage see the guide here - https://help.csvbox.io/getting-started#2-install-code


## License

MIT © [csvbox-io](https://github.com/csvbox-io)
