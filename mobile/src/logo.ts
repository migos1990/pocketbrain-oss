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
  legs: { w: 2.6 }, // stroke width of a leg, round caps
} as const;

// The brain's legs, only in the app's own screens (never the icon or splash). Each pose is two
// legs, each a shin and a foot as [x1, y1, x2, y2] in mark units, plus how far the whole body
// moves down (sit).
export const POSES = ["stand", "step", "sit"] as const;
export type Pose = (typeof POSES)[number];
type Seg = readonly [number, number, number, number];
export const LEGS: Record<Pose, { body: number; segs: readonly Seg[] }> = {
  stand: { body: 0, segs: [[26, 52, 26, 62], [26, 62, 31, 62], [38, 51, 38, 62], [38, 62, 43, 62]] },
  step: { body: 0, segs: [[26, 52, 25, 62], [25, 62, 30, 62], [38, 51, 40, 59], [40, 59, 45, 59.5]] },
  sit: { body: 4, segs: [[27, 52, 45, 58], [45, 58, 47, 53.5], [36, 50, 54, 56], [54, 56, 56, 51.5]] },
};

/** A segment with round caps drawn as a box: its centre, its length including both caps, and its angle. */
export function segBox([x1, y1, x2, y2]: Seg, w: number): { cx: number; cy: number; len: number; deg: number } {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { cx: r((x1 + x2) / 2), cy: r((y1 + y2) / 2), len: r(Math.hypot(x2 - x1, y2 - y1) + w), deg: r((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) };
}

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
