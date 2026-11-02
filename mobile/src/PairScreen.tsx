// SPDX-License-Identifier: AGPL-3.0-only
// The first screen of a phone that isn't paired yet (docs/phone-app.md, Pairing): the logo on
// Night, as the icon and the opening screen, then the two steps and one button.
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Mark } from "./Mark";
import { MARK } from "./logo";

const C = {
  night: MARK.night, paper: MARK.paper, pink: MARK.pink,
  raised: "#1C1C1C", line: "#303030", soft: "#A3A29C", faint: "#6E6D69", alert: "#FF8CCB",
};
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
import { PHONE_LINK_COMMAND } from "./commands";
export { PHONE_LINK_COMMAND };

export function PairScreen({ busy, msg, onPair, onBack }: { busy: boolean; msg: string; onPair: (link: string) => void; onBack?: () => void }) {
  const [link, setLink] = useState("");
  const [focus, setFocus] = useState(false);
  const paste = async () => { const t = await Clipboard.getStringAsync().catch(() => ""); if (t) { setLink(t.trim()); onPair(t); } };
  const ready = link.trim().length > 0 && !busy;
  return (
    <View style={s.page}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.brand}>
            <Mark size={104} />
            <Text style={s.word} accessibilityRole="header">pocketBrain</Text>
          </View>

          <Text style={s.h1}>Pair this phone with your brain</Text>
          <Text style={s.lede}>Your brain stays on your own computer. Pair once, and Face ID opens it from then on.</Text>

          <View style={s.steps}>
            <View style={s.step}>
              <Text style={s.num}>1</Text>
              <View style={s.stepBody}>
                <Text style={s.stepText}>On your computer, run</Text>
                <Text style={s.cmd} selectable>{PHONE_LINK_COMMAND}</Text>
              </View>
            </View>
            <View style={s.rule} />
            <View style={s.step}>
              <Text style={s.num}>2</Text>
              <View style={s.stepBody}>
                <Text style={s.stepText}>Copy the link it prints, then paste it here.</Text>
              </View>
            </View>
          </View>

          <View style={[s.field, focus && s.fieldOn, !!msg && s.fieldErr]}>
            <TextInput style={s.input} value={link} onChangeText={setLink} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
              placeholder="https://…/login?key=…" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false}
              keyboardType="url" returnKeyType="go" onSubmitEditing={() => ready && onPair(link)} editable={!busy}
              accessibilityLabel="Sign-in link" />
            <Pressable onPress={paste} disabled={busy} style={({ pressed }) => [s.paste, pressed && s.pressed]} accessibilityRole="button" accessibilityLabel="Paste the link and pair">
              <Text style={s.pasteText}>Paste</Text>
            </Pressable>
          </View>
          {msg ? <Text style={s.err} accessibilityLiveRegion="polite">{msg}</Text> : null}

          <Pressable onPress={() => onPair(link)} disabled={!ready} accessibilityRole="button" accessibilityState={{ disabled: !ready, busy }}
            style={({ pressed }) => [s.go, !ready && s.goOff, pressed && s.pressed]}>
            <Text style={[s.goText, !ready && s.goTextOff]}>{busy ? "Pairing…" : "Pair"}</Text>
          </Pressable>

          <Text style={s.foot}>Got the link by text? Open it on this phone and tap Open in the pocketBrain app.</Text>
          {onBack ? (
            <Pressable onPress={onBack} accessibilityRole="button" style={s.back}>
              <Text style={s.backText}>No pocketBrain on a computer yet?</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.night },
  fill: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 72, paddingBottom: 40, gap: 0 },
  brand: { alignItems: "center", gap: 14, marginBottom: 36 },
  word: { color: C.paper, fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  h1: { color: C.paper, fontSize: 30, lineHeight: 36, fontWeight: "700", letterSpacing: -0.6, marginBottom: 10 },
  lede: { color: C.soft, fontSize: 16, lineHeight: 24, marginBottom: 28 },
  steps: { backgroundColor: C.raised, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, paddingHorizontal: 16, marginBottom: 20 },
  step: { flexDirection: "row", gap: 14, paddingVertical: 16, alignItems: "flex-start" },
  num: { width: 26, height: 26, lineHeight: 24, borderRadius: 13, borderWidth: 1, borderColor: C.pink, color: C.pink, textAlign: "center", fontFamily: MONO, fontSize: 13, overflow: "hidden" },
  stepBody: { flex: 1, gap: 8, paddingTop: 2 },
  stepText: { color: C.paper, fontSize: 16, lineHeight: 22 },
  cmd: { color: C.paper, fontFamily: MONO, fontSize: 13, lineHeight: 18, backgroundColor: C.night, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, overflow: "hidden" },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 40 },
  field: { flexDirection: "row", alignItems: "center", backgroundColor: C.raised, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingLeft: 14, minHeight: 52 },
  fieldOn: { borderColor: C.paper },
  fieldErr: { borderColor: C.alert },
  input: { flex: 1, color: C.paper, fontFamily: MONO, fontSize: 14, paddingVertical: 14 },
  paste: { paddingHorizontal: 16, alignSelf: "stretch", justifyContent: "center" },
  pasteText: { color: C.pink, fontSize: 16, fontWeight: "600" },
  err: { color: C.alert, fontSize: 15, lineHeight: 22, marginTop: 10 },
  go: { backgroundColor: C.pink, borderRadius: 14, minHeight: 54, alignItems: "center", justifyContent: "center", marginTop: 20 },
  goOff: { backgroundColor: C.raised, borderWidth: 1, borderColor: C.line },
  goTextOff: { color: C.faint },
  goText: { color: C.night, fontSize: 17, fontWeight: "700" },
  pressed: { opacity: 0.7 },
  back: { alignSelf: "center", padding: 12, marginTop: 8 },
  backText: { color: C.pink, fontSize: 15 },
  foot: { color: C.faint, fontSize: 14, lineHeight: 20, marginTop: 24, textAlign: "center" },
});
