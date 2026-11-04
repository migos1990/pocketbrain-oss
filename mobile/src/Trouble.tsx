// SPDX-License-Identifier: AGPL-3.0-only
// What the app shows when the hub's page can't be shown (src/page.ts): the logo on Night, one
// sentence and Try again, never a blank screen.
import { useEffect, useRef, useState } from "react";
import { Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { Mark } from "./Mark";
import { MARK } from "./logo";

// `slow`: the page is still loading (G659), so the heading says the app is waiting, not that it failed.
export function Trouble({ onRetry, slow = false }: { onRetry: () => void; slow?: boolean }) {
  // The brain sits, looking up at the heading; Try again stands it up, then the page loads again.
  const [up, setUp] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const retry = () => {
    if (up) return;
    setUp(true);
    // The app closes this screen when the page loads again; if it stays up, the next tap still works.
    timer.current = setTimeout(() => { onRetry(); setUp(false); }, 350);
  };
  return (
    <View style={s.page}>
      <StatusBar barStyle="light-content" />
      <Mark size={120} pose={up ? "stand" : "sit"} gaze={up ? { x: 0, y: 0 } : { x: 0, y: -1 }} />
      <Text style={s.h1} accessibilityRole="header">{slow ? "Still waiting for your hub" : "Couldn't open your brain"}</Text>
      <Text style={s.p}>{slow ? "It's taking longer than usual. It opens here as soon as your hub answers, or check that Tailscale is on and try again." : "Check that Tailscale is on, on this phone and on your computer, then try again."}</Text>
      <Pressable onPress={retry} accessibilityRole="button" style={({ pressed }) => [s.go, pressed && s.pressed]}>
        <Text style={s.goText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  page: { ...StyleSheet.absoluteFillObject, backgroundColor: MARK.night, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  h1: { color: MARK.paper, fontSize: 24, lineHeight: 30, fontWeight: "700", letterSpacing: -0.4, marginTop: 28, textAlign: "center" },
  p: { color: "#A3A29C", fontSize: 16, lineHeight: 24, marginTop: 10, textAlign: "center" },
  go: { backgroundColor: MARK.pink, borderRadius: 14, minHeight: 54, alignSelf: "stretch", alignItems: "center", justifyContent: "center", marginTop: 32 },
  goText: { color: MARK.night, fontSize: 17, fontWeight: "700" },
  pressed: { opacity: 0.7 },
});
