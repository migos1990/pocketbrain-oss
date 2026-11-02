// SPDX-License-Identifier: AGPL-3.0-only
// Script the app runs in each owner page (docs/phone-app.md). The page's "Sign in again" button
// signs the browser out and texts a link; in the app it asks for Face ID instead. A signed-out
// page (its "Text me a sign-in link" form) asks once by itself, since the device key signs the
// phone in. With `faceId` false (Face ID was cancelled or failed, or a fresh sign-in didn't stick)
// the page's own buttons work as in a browser, so the owner can still text a link.
// Every page also says "ready" or "blank" (whether its body holds anything), so the app never leaves a
// blank screen up (src/page.ts). It only posts a word to the app; it sends nothing from the page.
const drawn = `window.ReactNativeWebView && window.ReactNativeWebView.postMessage(document.body && document.body.childElementCount ? "ready" : "blank");`;
export const inject = (faceId: boolean) => faceId ? `(() => {
  const ask = () => window.ReactNativeWebView && window.ReactNativeWebView.postMessage("fresh");
  document.addEventListener("submit", (e) => {
    const a = e.target && e.target.getAttribute && e.target.getAttribute("action");
    if (a === "/action/sign-in-again" || a === "/send-link") { e.preventDefault(); ask(); }
  }, true);
  ${drawn}
  if (document.querySelector('form[action="/send-link"]')) ask();
})(); true;` : `${drawn} true;`;
