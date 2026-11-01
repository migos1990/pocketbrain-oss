// SPDX-License-Identifier: AGPL-3.0-only
// The logo as the app draws it (docs/phone-app.md, The icon): the pink cloud, the bar, and the
// two eyes from the launch film, on a 64-unit square. The same shapes as src/favicon.ts; the
// icon images are made from iconSvg() by scripts/phone-icons.ts, and Mark.tsx draws them live.
export const MARK = {
  night: "#121212", pink: "#FF48B0", paper: "#EEEDE8", white: "#FFFFFF",
  cloud: [{ cx: 22, cy: 24, r: 13 }, { cx: 36, cy: 20, r: 13 }, { cx: 46, cy: 30, r: 11 }, { cx: 18, cy: 38, r: 12 }, { cx: 32, cy: 40, r: 13 }, { cx: 46, cy: 42, r: 10 }],
  bar: { x: 6, y: 25, w: 52, h: 12 },
  eyes: [{ cx: 26.3, cy: 31.9 }, { cx: 39.3, cy: 31.9 }],
  eye: { r: 5.5, rim: 0.9, pupil: 2.1, look: 2 }, // look: how far a pupil moves left or right
  centre: { x: 31.5, y: 30 }, // the middle of what the cloud covers
} as const;

/** The mark as SVG on a 100-unit square: "icon" on the Night tile, edge to edge (the phone
 * rounds it); "adaptive" and "splash" see-through, smaller, inside Android's safe circle. */
export function iconSvg(kind: "icon" | "adaptive" | "splash", size = 1024): string {
  const scale = kind === "icon" ? 1.6 : 1.0;
  const tx = 50 - MARK.centre.x * scale, ty = 50 - MARK.centre.y * scale;
  const m = MARK, b = m.bar;
  const shapes = [
    ...m.cloud.map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="${m.pink}"/>`),
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.h / 2}" fill="${m.paper}"/>`,
    ...m.eyes.flatMap((e) => [
      `<circle cx="${e.cx}" cy="${e.cy}" r="${m.eye.r - m.eye.rim / 2}" fill="${m.white}" stroke="${m.night}" stroke-width="${m.eye.rim}"/>`,
      `<circle cx="${e.cx}" cy="${e.cy}" r="${m.eye.pupil}" fill="${m.night}"/>`,
    ]),
  ].join("");
  const tile = kind === "icon" ? `<rect width="100" height="100" fill="${m.night}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${tile}<g transform="translate(${tx} ${ty}) scale(${scale})">${shapes}</g></svg>`;
}
