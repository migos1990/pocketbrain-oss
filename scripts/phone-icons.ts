// SPDX-License-Identifier: AGPL-3.0-only
// Makes the phone app's icon images from the logo (mobile/src/logo.ts): mobile/assets/icon.png
// (the iPhone icon, Night tile, no transparency), adaptive-icon.png (Android's see-through
// foreground) and splash-icon.png (the opening screen). Run after changing the mark:
//   bun scripts/phone-icons.ts
import { chromium } from "playwright";
import { join } from "node:path";
import { iconSvg } from "../mobile/src/logo";

const out = join(import.meta.dir, "..", "mobile", "assets");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [kind, file] of [["icon", "icon.png"], ["adaptive", "adaptive-icon.png"], ["splash", "splash-icon.png"]] as const) {
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${iconSvg(kind)}`);
    await page.screenshot({ path: join(out, file), omitBackground: kind !== "icon", clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    console.log(`wrote mobile/assets/${file}`);
  }
} finally { await browser.close(); }
