// SPDX-License-Identifier: AGPL-3.0-only
// The pocketBrain phone app (docs/phone-app.md): the hub's own owner pages, full screen, plus
// pairing and Face ID. One web UI for browser and app; the app adds only what a browser can't.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import * as Device from "expo-device";
import { parsePairLink } from "./src/pair";
import { pair, fresh } from "./src/hub";
import { inject } from "./src/inject";
import { Mark } from "./src/Mark";
import { MARK } from "./src/logo";

const HUB = "pb.hub";       // the hub's https address, not secret
const KEY = "pb.device";    // the device key, readable only after Face ID
const INK = { paper: "#EEEDE8", ink: "#121212", blue: "#0078BF", pink: "#FF48B0" };

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
  const [link, setLink] = useState("");
  const web = useRef<WebView>(null);
  // Face ID off for this run of the page script: cancelled, or a fresh sign-in that didn't stick
  // (the page asked again within a minute), so the app never loops on Face ID.
  const [faceId, setFaceId] = useState(true);
  const lastFresh = useRef(0);

  useEffect(() => { SecureStore.getItemAsync(HUB).then(setHub); }, []);

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
  useEffect(() => { if (url?.startsWith("pocketbrain://pair")) doPair(url); }, [url, doPair]);

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
    <SafeAreaView style={s.page}>
      <StatusBar barStyle="dark-content" />
      <WebView ref={web} source={{ uri: `${hub}/` }} key={faceId ? "faceid" : "plain"} injectedJavaScript={inject(faceId)} onMessage={(e) => { if (e.nativeEvent.data === "fresh") onFresh(); }}
        sharedCookiesEnabled thirdPartyCookiesEnabled={false} allowsBackForwardNavigationGestures pullToRefreshEnabled
        originWhitelist={[hub]} setSupportMultipleWindows={false} startInLoadingState renderLoading={() => opening} style={s.page} />
      {msg ? <Text style={s.note}>{msg}</Text> : null}
    </SafeAreaView>
  );
  return (
    <SafeAreaView style={[s.page, s.pad]}>
      <Text style={s.h1}>Pair this phone</Text>
      <Text style={s.p}>On your hub, run pocketbrain dashboard phone-link, or tap Text me a sign-in link on its page. Open the link and tap Open in the pocketBrain app. Or paste the link here.</Text>
      <TextInput style={s.input} value={link} onChangeText={setLink} placeholder="https://…/login?key=…" autoCapitalize="none" autoCorrect={false} />
      <Pressable style={s.go} disabled={busy} onPress={() => doPair(link)}><Text style={s.goText}>{busy ? "Pairing…" : "Pair"}</Text></Pressable>
      {msg ? <Text style={s.p}>{msg}</Text> : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  opening: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: MARK.night },
  page: { flex: 1, backgroundColor: INK.paper },
  pad: { padding: 24, gap: 16 },
  h1: { fontSize: 28, fontWeight: "700", color: INK.ink },
  p: { fontSize: 16, lineHeight: 22, color: INK.ink },
  input: { borderWidth: 1, borderColor: INK.ink, padding: 12, fontSize: 16, color: INK.ink },
  go: { backgroundColor: INK.blue, padding: 14, alignItems: "center" },
  goText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  note: { padding: 12, color: INK.ink, backgroundColor: INK.pink },
});
