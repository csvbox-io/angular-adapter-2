let styleElement: HTMLStyleElement

const GLOBAL_CSS = `
.csvbox-holder {
  z-index: 2147483647;
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  display: none;
}
.csvbox-holder iframe {
  height: 100%;
  width: 100%;
  position: absolute;
  top: 0px;
  left: 0px;
}
`

export const insertCSS = (): void => {
  if (styleElement) {
    return
  }

  styleElement = document.createElement('style')
  styleElement.setAttribute('type', 'text/css')
  const head = document.querySelector('head');
  if (head) {
    head.appendChild(styleElement);
  }

  styleElement.textContent = GLOBAL_CSS
}
