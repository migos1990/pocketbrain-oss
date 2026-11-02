// SPDX-License-Identifier: AGPL-3.0-only
// The pocketBrain phone app (docs/phone-app.md): the hub's own owner pages, full screen, plus
// pairing and Face ID. One web UI for browser and app; the app adds only what a browser can't.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import * as Device from "expo-device";
import { parsePairLink } from "./src/pair";
import { pair, fresh } from "./src/hub";
import { inject } from "./src/inject";
import { Mark } from "./src/Mark";
import { PairScreen } from "./src/PairScreen";
import { SetUpSteps, Welcome } from "./src/FirstRun";
import { firstScreen, type Choice } from "./src/first";
import { Trouble } from "./src/Trouble";
import { pageStep, shell, START, type PageEvent } from "./src/page";
import { MARK } from "./src/logo";

const HUB = "pb.hub";       // the hub's https address, not secret
const KEY = "pb.device";    // the device key, readable only after Face ID
const FIRST = "pb.firstrun"; // the first screen's answer, so it is asked once (src/first.ts)
const INK = { paper: "#EEEDE8", ink: "#121212", pink: "#FF48B0" };

async function saveKey(device: string) {
  await SecureStore.setItemAsync(KEY, device, { requireAuthentication: true, authenticationPrompt: "Unlock pocketBrain", keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY });
}
async function readKey(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(KEY, { requireAuthentication: true, authenticationPrompt: "Unlock pocketBrain" }); }
  catch { return null; } // Face ID cancelled or failed
}

export default function App() {
  const [hub, setHub] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const web = useRef<WebView>(null);
  // Face ID off for this run of the page script: cancelled, or a fresh sign-in that didn't stick
  // (the page asked again within a minute), so the app never loops on Face ID.
  const [faceId, setFaceId] = useState(true);
  const lastFresh = useRef(0);
  // The page in the web view, so a dropped or failed page never leaves a blank screen (src/page.ts).
  const page = useRef(START);
  const [phase, setPhase] = useState(START.phase);
  const [load, setLoad] = useState(0); // bumped to load the page again in a fresh web view
  const step = useCallback((e: PageEvent) => {
    const r = pageStep(page.current, e);
    page.current = r.state; setPhase(r.state.phase);
    if (r.reload) setLoad((n) => n + 1);
  }, []);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => step(st === "active" ? { kind: "foreground", at: Date.now() } : { kind: "background", at: Date.now() }));
    return () => sub.remove();
  }, [step]);

  useEffect(() => { SecureStore.getItemAsync(HUB).then(setHub); }, []);
  // The first screen's answer: "I have it on a computer" is kept, so the question is asked once.
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  useEffect(() => { SecureStore.getItemAsync(FIRST).then((v) => { if (v === "have") setChoice("have"); }).catch(() => {}); }, []);
  const choose = useCallback((c: Choice | undefined) => {
    setChoice(c); setMsg("");
    if (c === "have") SecureStore.setItemAsync(FIRST, "have").catch(() => {});
    else SecureStore.deleteItemAsync(FIRST).catch(() => {});
  }, []);

  const doPair = useCallback(async (raw: string) => {
    const p = parsePairLink(raw);
    if ("error" in p) { setMsg(p.error); return; }
    if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) { setMsg("Set up Face ID or a fingerprint first: the app keeps your key behind it."); return; }
    setBusy(true); setMsg("");
    try {
      const r = await pair(fetch as never, p.hub, p.key, Device.deviceName ?? "phone");
      if ("error" in r) { setMsg(r.error); return; }
      await saveKey(r.device);
      await SecureStore.setItemAsync(HUB, p.hub);
      setHub(p.hub); setFaceId(true);
    } catch { setMsg("Couldn't reach your hub. Is Tailscale on?"); }
    finally { setBusy(false); }
  }, []);

  // A link opened from the hub's sign-in page: pocketbrain://pair?hub=…&key=…
  const url = Linking.useURL();
  useEffect(() => { if (url?.startsWith("pocketbrain://pair")) { choose("have"); doPair(url); } }, [url, doPair, choose]);

  const onFresh = useCallback(async () => {
    if (!hub) return;
    if (Date.now() - lastFresh.current < 60_000) { setFaceId(false); setMsg("Signed in, but this page didn't keep it. Use Text me a sign-in link."); return; }
    const device = await readKey();
    if (!device) { setFaceId(false); setMsg("Face ID didn't unlock. Tap Text me a sign-in link to get a link instead."); return; }
    const r = await fresh(fetch as never, hub, device);
    if (r === "fresh") { lastFresh.current = Date.now(); setMsg(""); web.current?.reload(); }
    else if (r === "unpaired") { await SecureStore.deleteItemAsync(HUB); setHub(null); setMsg("This phone isn't paired any more. Open a new sign-in link to pair it again."); }
    else setMsg(r === "wait" ? "Too many tries this hour. Try again later." : "Couldn't reach your hub. Is Tailscale on?");
  }, [hub]);

  const opening = <View style={s.opening}><StatusBar barStyle="light-content" /><Mark size={160} /></View>;
  if (hub === undefined) return opening;
  if (hub) return (
    <SafeAreaView style={[s.page, { backgroundColor: shell(phase).background }]}>
      <StatusBar barStyle={shell(phase).bar} />
      <WebView ref={web} source={{ uri: `${hub}/` }} key={`${faceId ? "faceid" : "plain"}-${load}`} injectedJavaScript={inject(faceId)}
        onMessage={(e) => { const m = e.nativeEvent.data; if (m === "fresh") onFresh(); else if (m === "ready" || m === "blank") step({ kind: "loaded", blank: m === "blank" }); }}
        onError={() => step({ kind: "error" })} onHttpError={(e) => step({ kind: "http", status: e.nativeEvent.statusCode })}
        onContentProcessDidTerminate={() => step({ kind: "gone" })} onRenderProcessGone={() => step({ kind: "gone" })}
        sharedCookiesEnabled thirdPartyCookiesEnabled={false} allowsBackForwardNavigationGestures pullToRefreshEnabled
        originWhitelist={[hub]} setSupportMultipleWindows={false} startInLoadingState renderLoading={() => opening} style={s.page} />
      {phase === "failed" ? <Trouble onRetry={() => step({ kind: "retry" })} /> : null}
      {msg ? <Text style={s.note}>{msg}</Text> : null}
    </SafeAreaView>
  );
  const first = firstScreen(hub, choice);
  if (first === "welcome") return <Welcome onHave={() => choose("have")} onNotYet={() => choose("not-yet")} />;
  if (first === "steps") return <SetUpSteps onDone={() => choose("have")} onBack={() => choose(undefined)} />;
  return <PairScreen busy={busy} msg={msg} onPair={doPair} onBack={() => choose("not-yet")} />;
}

const s = StyleSheet.create({
  opening: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: MARK.night },
  page: { flex: 1, backgroundColor: INK.paper },
  note: { padding: 12, color: INK.ink, backgroundColor: INK.pink },
});
