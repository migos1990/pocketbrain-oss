// SPDX-License-Identifier: AGPL-3.0-only
// The first screens of a phone with no hub paired (src/first.ts, docs/phone-app.md, First run):
// one question, then either the pair screen or the steps to set pocketBrain up on a computer.
// Same Night look as the pair screen; no native module beyond the ones the app already has.
import { useState } from "react";
import { Platform, Pressable, ScrollView, Share, StatusBar, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Mark } from "./Mark";
import { MARK } from "./logo";
import { INIT_COMMAND, INSTALL_COMMAND, shareText } from "./first";
import { PHONE_LINK_COMMAND } from "./commands";

const C = { night: MARK.night, paper: MARK.paper, pink: MARK.pink, raised: "#1C1C1C", line: "#303030", soft: "#A3A29C", faint: "#6E6D69" };
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function Brand({ size }: { size: number }) {
  return (
    <View style={s.brand}>
      <Mark size={size} />
      <Text style={s.word} accessibilityRole="header">pocketBrain</Text>
    </View>
  );
}

export function Welcome({ onHave, onNotYet }: { onHave: () => void; onNotYet: () => void }) {
  return (
    <View style={s.page}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={[s.scroll, s.center]}>
        <Brand size={132} />
        <Text style={s.h1}>pocketBrain lives on your computer.</Text>
        <Text style={s.lede}>Your phone opens it. Is pocketBrain on one of your computers yet?</Text>
        <Pressable onPress={onHave} accessibilityRole="button" style={({ pressed }) => [s.go, pressed && s.pressed]}>
          <Text style={s.goText}>I have it on a computer</Text>
        </Pressable>
        <Pressable onPress={onNotYet} accessibilityRole="button" style={({ pressed }) => [s.second, pressed && s.pressed]}>
          <Text style={s.secondText}>Not yet</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Step({ n, text, cmd, last }: { n: number; text: string; cmd?: string; last?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { if (!cmd) return; await Clipboard.setStringAsync(cmd).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <>
      <View style={s.step}>
        <Text style={s.num}>{n}</Text>
        <View style={s.stepBody}>
          <Text style={s.stepText}>{text}</Text>
          {cmd ? (
            <View style={s.cmdRow}>
              <Text style={s.cmd} selectable>{cmd}</Text>
              <Pressable onPress={copy} accessibilityRole="button" accessibilityLabel={`Copy ${cmd}`} style={({ pressed }) => [s.copy, pressed && s.pressed]}>
                <Text style={s.copyText}>{copied ? "Copied" : "Copy"}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
      {last ? null : <View style={s.rule} />}
    </>
  );
}

export function SetUpSteps({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const send = () => { Share.share({ message: shareText() }).catch(() => {}); };
  return (
    <View style={s.page}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={s.scroll}>
        <Brand size={88} />
        <Text style={s.h1}>Set up pocketBrain on your computer</Text>
        <Text style={s.lede}>On a Mac or Linux computer, or Windows with WSL. It takes about five minutes.</Text>
        <View style={s.steps}>
          <Step n={1} text="Open Terminal and paste:" cmd={INSTALL_COMMAND} />
          <Step n={2} text="Then run:" cmd={INIT_COMMAND} />
          <Step n={3} text="When it's done, run this and paste the link it prints into this app:" cmd={PHONE_LINK_COMMAND} last />
        </View>
        <Pressable onPress={send} accessibilityRole="button" style={({ pressed }) => [s.second, pressed && s.pressed]}>
          <Text style={s.secondText}>Send these steps to my computer</Text>
        </Pressable>
        <Pressable onPress={onDone} accessibilityRole="button" style={({ pressed }) => [s.go, pressed && s.pressed]}>
          <Text style={s.goText}>It's set up, pair this phone</Text>
        </Pressable>
        <Text style={s.foot}>Your computer needs to be on when you use the app.</Text>
        <Pressable onPress={onBack} accessibilityRole="button" style={s.back}>
          <Text style={s.backText}>Back</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.night },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 72, paddingBottom: 40 },
  center: { justifyContent: "center", paddingTop: 40 },
  brand: { alignItems: "center", gap: 14, marginBottom: 32 },
  word: { color: C.paper, fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  h1: { color: C.paper, fontSize: 30, lineHeight: 36, fontWeight: "700", letterSpacing: -0.6, marginBottom: 10 },
  lede: { color: C.soft, fontSize: 16, lineHeight: 24, marginBottom: 28 },
  steps: { backgroundColor: C.raised, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, paddingHorizontal: 16, marginBottom: 20 },
  step: { flexDirection: "row", gap: 14, paddingVertical: 16, alignItems: "flex-start" },
  num: { width: 26, height: 26, lineHeight: 24, borderRadius: 13, borderWidth: 1, borderColor: C.pink, color: C.pink, textAlign: "center", fontFamily: MONO, fontSize: 13, overflow: "hidden" },
  stepBody: { flex: 1, gap: 8, paddingTop: 2 },
  stepText: { color: C.paper, fontSize: 16, lineHeight: 22 },
  // The command over its Copy button, so a long command wraps and never pushes Copy off the screen.
  cmdRow: { backgroundColor: C.night, borderRadius: 8, overflow: "hidden" },
  cmd: { color: C.paper, fontFamily: MONO, fontSize: 13, lineHeight: 18, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6 },
  copy: { alignSelf: "flex-end", paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: "center" },
  copyText: { color: C.pink, fontSize: 14, fontWeight: "600" },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 40 },
  go: { backgroundColor: C.pink, borderRadius: 14, minHeight: 54, alignItems: "center", justifyContent: "center", marginTop: 12 },
  goText: { color: C.night, fontSize: 17, fontWeight: "700" },
  second: { borderRadius: 14, minHeight: 54, alignItems: "center", justifyContent: "center", marginTop: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised },
  secondText: { color: C.paper, fontSize: 17, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  foot: { color: C.soft, fontSize: 14, lineHeight: 20, marginTop: 20, textAlign: "center" },
  back: { alignSelf: "center", padding: 12, marginTop: 4 },
  backText: { color: C.faint, fontSize: 15 },
});
