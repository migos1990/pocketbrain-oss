# SPDX-License-Identifier: AGPL-3.0-only
# A third implementation of the Memory Passport HTTP door (docs/spec/memory-passport.md), in Python
# with only the standard library, in memory, from conformance/fixture.json. It shares no code and no
# language with pocketBrain or conformance/reference-server.ts: the conformance suite passing against
# it says the spec, not one codebase, defines the behaviour. Not for real use: no persistence, no
# OAuth, no owner inbox.
#   python3 conformance/reference_server.py [port] [fixture.json]
# prints one JSON line with its url and one token per credential, then serves until killed.
import hashlib, hmac, json, re, secrets, sys, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote

SOURCE = re.compile(r"^[a-z][a-z0-9-]*:\S+$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ATTR = re.compile(r"^[a-z][a-z0-9_]*$")
LINK = re.compile(r"\[\[([^\]]+)\]\]")
BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class Passport:
    """The door's logic, apart from HTTP: each method returns (status, headers, body)."""

    def __init__(self, data, per_minute=300):
        self.data = data
        self.notes = {n["id"]: json.loads(json.dumps(n)) for n in data["notes"]}
        self.creds = []  # {hash, agent, role, at}
        self.inbox = []
        self.handoffs = []
        self.per_minute = per_minute
        self.lock = threading.Lock()

    # Credentials: an approved agent's (all routes, or none of these for a resolver), or a sign-in
    # the owner hasn't approved yet, which answers like an unknown one.
    def mint(self, agent=None, role=None):
        t = "mp_" + secrets.token_hex(24)
        self.creds.append({"hash": hashlib.sha256(t.encode()).digest(), "agent": agent, "role": role, "at": []})
        return t

    def issue(self, which, role=None):
        return self.mint(self.data["agents"][which], role)

    def cred(self, header):
        m = re.match(r"^Bearer (\S+)$", header or "")
        if not m:
            return None
        h = hashlib.sha256(m.group(1).encode()).digest()
        found = None
        for c in self.creds:
            if hmac.compare_digest(c["hash"], h):
                found = c
        return found

    # What an agent may see.
    def sees(self, a, note_id):
        return a["sees"] == "all" or note_id in a["sees"]

    def hidden_attr(self, a, note_id, attr):
        return attr in (a.get("hidden_attributes") or {}).get(note_id, [])

    def visible_values(self, a):
        return {f["value"] for n in self.notes.values() if self.sees(a, n["id"])
                for k, f in n["facts"].items() if not self.hidden_attr(a, n["id"], k)}

    # Every value the agent may not see, longest first, so text that quotes one is withheld too.
    def hidden_values(self, a):
        shown = self.visible_values(a)
        vals = [f["value"] for n in self.notes.values() for k, f in n["facts"].items()
                if not self.sees(a, n["id"]) or self.hidden_attr(a, n["id"], k)]
        return sorted({v for v in vals if v not in shown}, key=len, reverse=True)

    # In any case: "MAPLE trust bank" names the same hidden value (G530).
    def scrub(self, a, text):
        for v in self.hidden_values(a):
            text = re.sub(re.escape(v), "[withheld]", text, flags=re.IGNORECASE)
        return LINK.sub(lambda m: m.group(0) if self.sees(a, m.group(1)) else "[withheld]", text)

    def view(self, a, n):
        return {
            # A visible note's title and aliases are text too: a hidden value in them is withheld (G530).
            "id": n["id"], "title": self.scrub(a, n["title"]), "type": n["type"], "area": n["area"],
            "aliases": [self.scrub(a, x) for x in n.get("aliases") or []],
            "facts": {k: f for k, f in n["facts"].items() if not self.hidden_attr(a, n["id"], k)},
            "body": self.scrub(a, n["body"]),
        }

    def agent_named(self, name):
        return next((a for a in self.data["agents"].values() if a["name"] == name), None)

    # Routes.
    def orientation(self, a):
        mine = [n for n in self.notes.values() if self.sees(a, n["id"])]
        areas = sorted({n["area"] for n in mine})
        owner = self.data["owner"]
        writes = "Your writes are committed." if a["writes"] == "direct" else f"Your writes wait for {owner}'s approval."
        return "\n".join([
            f"# You are {a['name']}, connected to {owner}'s memory",
            "",
            f"You see {len(mine)} notes, in these areas: {', '.join(areas)}. Anything else is withheld, and a withheld note answers exactly like one that doesn't exist.",
            "`[withheld]` in a text marks something you may not see. It is final: don't guess it or look for it elsewhere.",
            f"Every write needs a source (scheme:id, e.g. gmail:<id>) and an as_of date. {writes}",
            "",
        ])

    def search(self, a, q):
        words = [w for w in q.lower().split() if w]
        out = []
        for n in self.notes.values():
            if not self.sees(a, n["id"]):
                continue
            v = self.view(a, n)
            hay = " ".join([v["title"], *v["aliases"], *[f["value"] for f in v["facts"].values()], v["body"]]).lower()
            if words and all(w in hay for w in words):
                out.append({"id": v["id"], "title": v["title"], "type": v["type"], "area": v["area"]})
        return out

    def remember(self, a, b):
        def refuse(message):
            return 422, {"outcome": "refused", "message": message}
        note_id, attribute = str(b.get("id") or ""), str(b.get("attribute") or "")
        sources = [str(s) for s in b["sources"]] if isinstance(b.get("sources"), list) else []
        if not sources or not all(SOURCE.match(s) for s in sources):
            return refuse('every write needs sources: ["scheme:id"]')
        as_of = b.get("as_of")
        if not isinstance(as_of, str) or not DATE.match(as_of) or as_of > self.data["today"]:
            return refuse("as_of must be a date, today at the latest")
        value = b.get("value")
        if not ATTR.match(attribute) or not isinstance(value, str) or not value:
            return refuse("attribute and value are required")
        n = self.notes.get(note_id)
        if not n or not self.sees(a, note_id):
            return refuse(f"no note {note_id}")
        # A hidden attribute takes the same path as a new one: nothing in the answer tells them apart,
        # and it never replaces the hidden fact: a direct writer's write goes to the owner (G530).
        if a["writes"] == "propose" or self.hidden_attr(a, note_id, attribute):
            self.inbox.append({"by": a["name"], "id": note_id, "attribute": attribute, "value": value, "as_of": as_of, "sources": sources})
            if a["writes"] != "propose":
                return 200, {"outcome": "committed", "message": f"{note_id}#{attribute} recorded"}
            return 200, {"outcome": "inbox", "message": f"held for {self.data['owner']}'s approval"}
        n["facts"][attribute] = {"value": value, "as_of": as_of, "sources": sources}
        return 200, {"outcome": "committed", "message": f"{note_id}#{attribute} recorded"}

    # The sender's answer is the same whether the handoff is delivered or held: a held one carries a
    # value its recipient may not see, and only the owner may release it.
    def hand_off(self, a, b):
        to = self.agent_named(str(b.get("to") or ""))
        if not to or to is a:
            return 400, {"error": "to must name another agent"}
        task, step = b.get("task"), b.get("next_step")
        if not isinstance(task, str) or not task.strip() or not isinstance(step, str) or not step.strip():
            return 400, {"error": "task and next_step are required"}
        text = f"{task}\n{step}"
        hid = "ho-" + secrets.token_hex(6)
        at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.handoffs.append({"id": hid, "from": a["name"], "to": to["name"], "at": at, "task": task, "next_step": step,
                              "delivered": not any(v in text for v in self.hidden_values(to)), "done": False})
        return 200, {"id": hid, "reply": f"Handed off (id {hid}). The recipient sees it when it next checks what's new; {self.data['owner']} may look at it first."}

    def changes(self, a):
        return {"handoffs": [{"id": h["id"], "from": "an assistant", "at": h["at"], "task": h["task"], "next_step": h["next_step"]}
                             for h in self.handoffs if h["to"] == a["name"] and h["delivered"] and not h["done"]]}

    def handle(self, method, raw_path, headers, body, origin):
        with self.lock:
            return self._handle(method, raw_path, headers, body, origin)

    def _handle(self, method, raw_path, headers, body, origin):
        parts = urlsplit(raw_path)
        path = parts.path
        if path == "/.well-known/memory-passport" and method == "GET":
            return 200, {}, {"memory_passport": "0.2", "doors": {"api": {"url": f"{origin}/v1", "auth": "bearer"}}, "orientation": f"{origin}/v1/orientation"}
        if not path.startswith("/v1/"):
            return 404, {}, {"error": "not found"}
        c = self.cred(headers.get("authorization"))
        # A waiting sign-in answers exactly like an unknown credential.
        if not c or not c["agent"]:
            return 401, {}, {"error": "missing or unknown credential"}
        now = time.time() * 1000
        c["at"] = [t for t in c["at"] if t > now - 60_000]
        if len(c["at"]) >= self.per_minute:
            wait = max(1, -(-int(c["at"][0] + 60_000 - now) // 1000))
            return 429, {"retry-after": str(wait)}, {"error": f"over the request budget; retry in {wait} seconds"}
        c["at"].append(now)
        # Disputes and the owner's routes are out of this spec, so a resolver credential gets none of it.
        if c["role"] == "resolver":
            return 403, {}, {"error": "this credential works only on the owner's routes"}
        a = c["agent"]
        if method == "GET" and path == "/v1/orientation":
            return 200, {"content-type": "text/markdown; charset=utf-8"}, self.orientation(a)
        if method == "GET" and path == "/v1/search":
            q = parse_qs(parts.query, keep_blank_values=True).get("q", [""])[0]
            return 200, {}, self.search(a, q)
        if method == "GET" and path.startswith("/v1/notes/"):
            enc = path[len("/v1/notes/"):]
            try:
                if BAD_ESCAPE.search(enc):
                    raise ValueError
                note_id = unquote(enc, errors="strict")
            except (ValueError, UnicodeDecodeError):
                return 400, {}, {"error": "bad id"}
            n = self.notes.get(note_id)
            if n and self.sees(a, note_id):
                return 200, {}, self.view(a, n)
            return 404, {}, {"error": f"no note {note_id} in your view"}
        if method == "GET" and path == "/v1/changes":
            return 200, {}, self.changes(a)
        if method == "POST" and path in ("/v1/remember", "/v1/handoffs", "/v1/handoffs/done"):
            if len(body) > 64_000:
                return 413, {}, {"outcome": "refused", "message": "body too large"}
            try:
                b = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return 400, {}, {"outcome": "refused", "message": "body must be JSON"}
            if not isinstance(b, dict):
                return 400, {}, {"outcome": "refused", "message": "body must be an object"}
            if path == "/v1/handoffs":
                s, out = self.hand_off(a, b)
                return s, {}, out
            if path == "/v1/handoffs/done":
                h = next((x for x in self.handoffs if x["id"] == b.get("id") and x["to"] == a["name"] and x["delivered"]), None)
                if not h:
                    return 404, {}, {"error": "no open handoff with that id"}
                h["done"] = True
                return 200, {}, {"result": "done"}
            s, out = self.remember(a, b)
            return s, {}, out
        return 404, {}, {"error": "not found"}


def serve(port, fixture):
    door = Passport(json.loads(Path(fixture).read_text(encoding="utf-8")))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def answer(self):
            n = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(n) if n else b""
            origin = f"http://{self.headers.get('host') or f'127.0.0.1:{port}'}"
            status, headers, out = door.handle(self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body, origin)
            data = (out if isinstance(out, str) else json.dumps(out, indent=2, ensure_ascii=False)).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", headers.pop("content-type", "application/json"))
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = answer

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({
        "url": f"http://127.0.0.1:{httpd.server_address[1]}",
        "full": door.issue("full"), "limited": door.issue("limited"),
        "resolver": door.issue("full", "resolver"), "waiting": door.mint(),
    }), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 0, sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).with_name("fixture.json")))
