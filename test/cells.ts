// SPDX-License-Identifier: AGPL-3.0-only
// The cells lane (CI runs `PB_CELLS=1 bun test`, invariant 10 in CLAUDE.md): every test starts with
// cells as the run asked for them. A test that turns cells on or off puts back the run's setting,
// never a fixed `false`: bun runs every test file in one process, and one file's `useCells(false)`
// used to switch cells off for every file after it, so much of the lane ran without cells (G801).
// test/setup.ts fails the next test, and the run, when a test leaves the setting changed.
import { useCells } from "../src/cell";

export const LANE_CELLS = process.env.PB_CELLS === "1";
export const restoreCells = () => useCells(LANE_CELLS);
