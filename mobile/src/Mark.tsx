// SPDX-License-Identifier: AGPL-3.0-only
// The logo drawn live in the app's own screens, with the brain's two legs (
// docs/phone-app.md, The brain). It takes a pose (stand, step, sit) and where to look. "step" is
// the opening screen's loop: a weight shift with the eyes looking left and right while the hub
// loads. Every other change is one move of about 300 ms when the pose, gaze or blink changes, so it
// moves only on a page load or a tap. When the phone asks for less motion, poses cut instead.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, View } from "react-native";
import { LEGS, MARK, POSES, segBox, type Pose } from "./logo";

export type Gaze = { x: number; y: number }; // -1..1 each, in units of MARK.eye.look

const MOVE = 320;

export function Mark({ size, pose = "stand", gaze = { x: 0, y: 0 }, blink = 0 }: { size: number; pose?: Pose; gaze?: Gaze; blink?: number }) {
  const u = size / 64;
  const [still, setStill] = useState(true); // until the phone answers, don't move
  useEffect(() => {
    let gone = false;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (!gone) setStill(v); }).catch(() => {});
    return () => { gone = true; };
  }, []);

  const lookX = useRef(new Animated.Value(gaze.x)).current;
  const lookY = useRef(new Animated.Value(gaze.y)).current;
  const lid = useRef(new Animated.Value(1)).current; // 1 open, ~0 shut
  const body = useRef(new Animated.Value(LEGS[pose === "step" ? "stand" : pose].body)).current;
  const show = useRef(Object.fromEntries(POSES.map((p) => [p, new Animated.Value(p === (pose === "step" ? "stand" : pose) ? 1 : 0)])) as Record<Pose, Animated.Value>).current;

  const ease = (v: Animated.Value, to: number, ms = MOVE) => Animated.timing(v, { toValue: to, duration: ms, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
  const legsTo = (p: Pose, ms = MOVE) => Animated.parallel([...POSES.map((q) => ease(show[q], q === p ? 1 : 0, ms)), ease(body, LEGS[p].body, ms)]);

  // The pose: one move to it, or the opening screen's loop.
  useEffect(() => {
    if (pose === "step") {
      if (still) { legsTo("stand", 0).start(); lookX.setValue(0); return; }
      const loop = Animated.loop(Animated.sequence([
        Animated.delay(500),
        Animated.parallel([legsTo("step", 350), ease(lookX, -1, 350)]),
        Animated.delay(600),
        Animated.parallel([legsTo("stand", 350), ease(lookX, 1, 500)]),
        Animated.delay(600),
        ease(lookX, 0, 350),
      ]));
      loop.start();
      return () => loop.stop();
    }
    const a = legsTo(pose, still ? 0 : MOVE); a.start(); return () => a.stop();
  }, [pose, still]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where it looks (the step loop drives x itself).
  useEffect(() => {
    if (pose === "step") return;
    const a = Animated.parallel([ease(lookX, gaze.x, still ? 0 : MOVE), ease(lookY, gaze.y, still ? 0 : MOVE)]); a.start(); return () => a.stop();
  }, [gaze.x, gaze.y, pose, still]); // eslint-disable-line react-hooks/exhaustive-deps

  // One blink each time `blink` changes (an error on the pair screen).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (still) return;
    const a = Animated.sequence([ease(lid, 0.08, 120), ease(lid, 1, 160)]); a.start(); return () => a.stop();
  }, [blink]); // eslint-disable-line react-hooks/exhaustive-deps

  const dot = (cx: number, cy: number, r: number) => ({ position: "absolute" as const, left: (cx - r) * u, top: (cy - r) * u, width: 2 * r * u, height: 2 * r * u, borderRadius: r * u });
  const b = MARK.bar, e = MARK.eye, w = MARK.legs.w;
  const leg = (sg: (typeof LEGS)[Pose]["segs"][number], i: number) => {
    const { cx, cy, len, deg } = segBox(sg, w);
    return <View key={i} style={{ position: "absolute", left: (cx - len / 2) * u, top: (cy - w / 2) * u, width: len * u, height: w * u, borderRadius: (w / 2) * u, backgroundColor: MARK.paper, transform: [{ rotate: `${deg}deg` }] }} />;
  };
  const shift = (v: Animated.Value) => Animated.multiply(v, e.look * u);
  return (
    <View style={{ width: size, height: size }} accessibilityLabel="pocketBrain" accessible>
      <Animated.View style={{ position: "absolute", left: 0, top: 0, width: size, height: size, transform: [{ translateY: Animated.multiply(body, u) }] }}>
        {POSES.map((p) => (
          <Animated.View key={p} style={{ position: "absolute", left: 0, top: 0, width: size, height: size, opacity: show[p] }}>
            {LEGS[p].segs.map(leg)}
          </Animated.View>
        ))}
        {MARK.cloud.map((c, i) => <View key={`c${i}`} style={[dot(c.cx, c.cy, c.r), { backgroundColor: MARK.pink }]} />)}
        <View style={{ position: "absolute", left: b.x * u, top: b.y * u, width: b.w * u, height: b.h * u, borderRadius: (b.h / 2) * u, backgroundColor: MARK.paper }} />
        {MARK.eyes.map((p, i) => (
          <Animated.View key={`e${i}`} style={[dot(p.cx, p.cy, e.r), { backgroundColor: MARK.white, borderWidth: e.rim * u, borderColor: MARK.night, overflow: "hidden", transform: [{ scaleY: lid }] }]}>
            <Animated.View style={[dot(e.r - e.rim, e.r - e.rim, e.pupil), { backgroundColor: MARK.night, transform: [{ translateX: shift(lookX) }, { translateY: shift(lookY) }] }]} />
          </Animated.View>
        ))}
      </Animated.View>
    </View>
  );
}
