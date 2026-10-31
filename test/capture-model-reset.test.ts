// SPDX-License-Identifier: AGPL-3.0-only
// Tests swap the capture model and put the hub's own back afterwards. Putting it back must give
// the metered default: the old pattern, a hook that calls captureModel, called itself forever
// (a tail call, so it spun instead of overflowing) and hung every later test file that extracts.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { captureModel, useCaptureModel } from "../src/capture";
import { makeModel } from "../src/model";

test("useCaptureModel() with no argument puts the hub's own metered model back", () => {
  const root = makeBrain();
  useCaptureModel(() => makeModel({ provider: "fake", model: "swapped" }));
  expect(captureModel(root).config.model).toBe("swapped");
  useCaptureModel();
  const m = captureModel(root);
  expect(m.config.model).not.toBe("swapped");
  expect(m.config.provider).not.toBe("fake");
});
