// SPDX-License-Identifier: AGPL-3.0-only
// What the app shows when the hub's page can't be shown (src/page.ts): the logo on Night, one
// sentence and Try again, never a blank screen.
import { Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { Mark } from "./Mark";
import { MARK } from "./logo";

export function Trouble({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={s.page}>
      <StatusBar barStyle="light-content" />
      <Mark size={120} />
      <Text style={s.h1} accessibilityRole="header">Couldn't open your brain</Text>
      <Text style={s.p}>Check that Tailscale is on, on this phone and on your computer, then try again.</Text>
      <Pressable onPress={onRetry} accessibilityRole="button" style={({ pressed }) => [s.go, pressed && s.pressed]}>
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
