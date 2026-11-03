// SPDX-License-Identifier: AGPL-3.0-only
// Script the app runs in each owner page (docs/phone-app.md). The page's "Sign in again" button
// signs the browser out and texts a link; in the app it asks for Face ID instead. A signed-out
// page (its "Text me a sign-in link" form) asks once by itself, since the device key signs the
// phone in. With `faceId` false (Face ID was cancelled or failed, or a fresh sign-in didn't stick)
// the page's own buttons work as in a browser, so the owner can still text a link.
// Every page also says "ready" or "blank" (whether its body holds anything), so the app never leaves a
// blank screen up (src/page.ts). It only posts a word to the app; it sends nothing from the page.
// It also gives every page pull to refresh (below).
// Pull to refresh, in the page: a pull down from the top past PULL px loads the page again with a GET
// (any #part dropped, so it always loads). The web view's built-in one left its spinner up and never
// loaded (owner, 2026-11-03). Not from inside a text box, so typing never refreshes.
const PULL = 90;
const refresh = `(() => {
  let y0 = null, dy = 0, pill = null;
  const say = (w) => {
    if (!pill) { pill = document.createElement("div"); pill.setAttribute("aria-live", "polite"); pill.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top) + 10px);z-index:2147483647;padding:6px 14px;border-radius:999px;background:#121212;color:#EEEDE8;font:600 14px/20px -apple-system,system-ui,sans-serif;pointer-events:none"; document.body.appendChild(pill); }
    pill.replaceChildren(document.createTextNode(w)); pill.hidden = false;
  };
  const hide = () => { if (pill) pill.hidden = true; };
  addEventListener("touchstart", (e) => {
    const t = e.target, typing = t && t.closest && t.closest("textarea,input,select,[contenteditable]");
    y0 = e.touches.length === 1 && window.scrollY <= 0 && !typing ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 30) say(dy >= ${PULL} ? "Release to refresh" : "Pull to refresh"); else hide();
  }, { passive: true });
  addEventListener("touchend", () => {
    if (y0 === null) return;
    y0 = null;
    if (dy >= ${PULL}) { say("Loading…"); location.replace(location.href.split("#")[0]); } else hide();
  }, { passive: true });
  addEventListener("touchcancel", () => { y0 = null; hide(); }, { passive: true });
})();`;
const drawn = `window.ReactNativeWebView && window.ReactNativeWebView.postMessage(document.body && document.body.childElementCount ? "ready" : "blank");`;
export const inject = (faceId: boolean) => faceId ? `(() => {
  const ask = () => window.ReactNativeWebView && window.ReactNativeWebView.postMessage("fresh");
  document.addEventListener("submit", (e) => {
    const a = e.target && e.target.getAttribute && e.target.getAttribute("action");
    if (a === "/action/sign-in-again" || a === "/send-link") { e.preventDefault(); ask(); }
  }, true);
  ${drawn}
  ${refresh}
  if (document.querySelector('form[action="/send-link"]')) ask();
})(); true;` : `${drawn} ${refresh} true;`;
