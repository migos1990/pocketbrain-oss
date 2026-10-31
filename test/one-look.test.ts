// SPDX-License-Identifier: AGPL-3.0-only
// One look (outside review, 2026-10-29): the pages behind Settings and Edit this page wear the home's
// header row (back to Home, Settings), its column and type scale, not a second design.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { layout, CSS } from "../src/dashboard/html";
import { CSS as HOME_CSS } from "../src/dashboard/html-home";

test("every other page has the home's header row and type scale", () => {
  const html = layout({ root: makeBrain() }, { title: "Brain", tab: "brain", body: "<h1>Brain</h1>" });
  expect(html).toContain('<nav aria-label="Pages"><a href="/">Home</a>');
  expect(html).toContain('<a href="/overview">Settings</a></nav>');
  expect(html).not.toContain('class="logo"');
  expect(CSS).toContain('.top nav a:first-child::before{content:"‹ " / ""}');
  // The home's h1 and section label, and its column width, win over the old scale.
  expect(CSS).toContain("h1{font-size:24px;line-height:32px;font-weight:600");
  expect(CSS).toContain("text-transform:uppercase;color:var(--muted)");
  expect(HOME_CSS).toContain("max-width:640px");
  expect(CSS).toContain("main{max-width:640px");
});
