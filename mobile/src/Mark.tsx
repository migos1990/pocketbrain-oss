// SPDX-License-Identifier: AGPL-3.0-only
// The logo drawn live for the opening screen: the eyes look left and right while the hub loads,
// as in the launch film, and stay still when the phone asks for less motion.
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, View } from "react-native";
import { MARK } from "./logo";

export function Mark({ size }: { size: number }) {
  const u = size / 64;
  const look = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined, gone = false;
    const to = (v: number, ms: number) => Animated.timing(look, { toValue: v, duration: ms, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
    AccessibilityInfo.isReduceMotionEnabled().then((still) => {
      if (still || gone) return; // gone: the screen closed before the phone answered
      loop = Animated.loop(Animated.sequence([Animated.delay(500), to(-1, 350), Animated.delay(600), to(1, 500), Animated.delay(600), to(0, 350)]));
      loop.start();
    });
    return () => { gone = true; loop?.stop(); };
  }, [look]);
  const dot = (cx: number, cy: number, r: number) => ({ position: "absolute" as const, left: (cx - r) * u, top: (cy - r) * u, width: 2 * r * u, height: 2 * r * u, borderRadius: r * u });
  const b = MARK.bar, e = MARK.eye;
  return (
    <View style={{ width: size, height: size }} accessibilityLabel="pocketBrain" accessible>
      {MARK.cloud.map((c, i) => <View key={i} style={[dot(c.cx, c.cy, c.r), { backgroundColor: MARK.pink }]} />)}
      <View style={{ position: "absolute", left: b.x * u, top: b.y * u, width: b.w * u, height: b.h * u, borderRadius: (b.h / 2) * u, backgroundColor: MARK.paper }} />
      {MARK.eyes.map((p, i) => (
        <View key={i} style={[dot(p.cx, p.cy, e.r), { backgroundColor: MARK.white, borderWidth: e.rim * u, borderColor: MARK.night }]}>
          <Animated.View style={[dot(e.r - e.rim, e.r - e.rim, e.pupil), { backgroundColor: MARK.night, transform: [{ translateX: Animated.multiply(look, e.look * u) }] }]} />
        </View>
      ))}
    </View>
  );
}
