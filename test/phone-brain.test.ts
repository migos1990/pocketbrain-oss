// SPDX-License-Identifier: AGPL-3.0-only
// The new-user phone run (2026-10-24) found that on a phone the Brain page's "Needs a look" rows
// squeezed their text into a one-word column with the buttons drawn over the names.
import { test, expect } from "bun:test";
import { CSS } from "../src/dashboard/html";

test("on a phone a Brain row wraps, so its buttons go under the text, not over it", () => {
  const phone = CSS.slice(CSS.indexOf("@media (max-width:720px){.top{"));
  expect(phone).toMatch(/\.b-row\{flex-wrap:wrap\}/);
});
