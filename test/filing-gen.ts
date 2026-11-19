// SPDX-License-Identifier: AGPL-3.0-only
// A made-up week of messy mail for the filing property (test/filing-property.test.ts, G986): one
// seed always makes the same owner, the same mails and the same careless reading of each, so a
// failing seed can be replayed. Every name, shop and sentence here is invented.
// Each mail comes with `facts`: what a careless extractor would hand back for it, including what it
// never should (a promo code as a next step, the owner as a new person, a receipt's total). The
// property is that the code after the model holds whatever the model says.
import { prng } from "./carve-gen";

export type Shape = "person" | "promo" | "receipt" | "owner-signature" | "owner-flipped" | "forwarded" | "repeat";
export interface Fact { entity: string; type: string; attribute: string; value: string; quote: string }
export interface Mail { id: string; shape: Shape; from: string; subject: string; text: string; key: string; facts: Fact[] }
export interface Week { seed: number; owner: { name: string; aliases: string[]; address: string }; mails: Mail[]; codes: string[] }

const FIRST = ["Maren", "Tobias", "Ilse", "Corwin", "Anouk", "Desmond", "Liv", "Emeric", "Sunniva", "Blaise"];
const LAST = ["Solberg", "Achterberg", "Quennell", "Varga", "Lindqvist", "Okonjo", "Brandvold", "Castellane", "Mwangi", "Thorsby"];
const SHOPS = ["Pinecrest Outfitters", "Marlow & Finch", "Tidewater Books", "Copperline Kitchen", "Novabright Audio"];
const ROLES = ["registrar", "site foreman", "choir director", "lab coordinator", "league treasurer", "studio manager"];
const TOPICS = ["greenhouse", "regatta", "allotment", "bandstand", "ferry", "orchard", "skylight", "towpath", "lantern", "causeway", "belfry", "paddock"];
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function week(seed: number): Week {
  const r = prng(seed ^ 0xf111).next;
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const first = pick(FIRST), last = pick(LAST);
  const owner = { name: `${first} ${last}`, aliases: [`${first[0]}. ${last}`], address: `${first.toLowerCase()}@${last.toLowerCase()}.example` };
  const topics = [...TOPICS].sort(() => r() - 0.5);
  const person = () => { for (;;) { const n = `${pick(FIRST)} ${pick(LAST)}`; if (!n.includes(first) && !n.includes(last)) return n; } };
  // A code a shop mails out: three or four groups of capitals and digits, a letter and a digit in it.
  const code = () => { for (;;) { const c = Array.from({ length: 3 + Math.floor(r() * 2) }, () => Array.from({ length: 4 + Math.floor(r() * 2) }, () => pick([...ALNUM])).join("")).join("-"); if (/[A-Z]/.test(c) && /\d/.test(c)) return c; } };
  const codes: string[] = [];
  const mails: Mail[] = [];
  let n = 0;
  const id = () => (seed * 1000 + ++n).toString(16).padStart(16, "0");
  const add = (shape: Shape, from: string, body: (topic: string) => { subject: string; rest: string; facts: Fact[] }) => {
    const topic = topics[mails.length % topics.length]!;
    const key = `About the ${topic} matter, number ${mails.length + 1}.`;
    const b = body(topic);
    mails.push({ id: id(), shape, from, subject: b.subject, text: `${key}\n${b.rest}`, key, facts: b.facts });
  };
  const shapes: Shape[] = ["person", "promo", "receipt", "owner-signature", "owner-flipped", "forwarded"];
  const count = 5 + Math.floor(r() * 4);
  for (let i = 0; i < count; i++) {
    const shape = i < shapes.length ? shapes[i]! : pick(shapes);
    if (shape === "person") {
      const who = person(), role = pick(ROLES);
      add(shape, `${who} <${who.split(" ")[0]!.toLowerCase()}@mail.example>`, (t) => ({ subject: `The ${t} rota`, rest: `${who} is the ${role} for the ${t} now. Thanks, ${who}`,
        facts: [{ entity: who, type: "person", attribute: "role", value: role, quote: `${who} is the ${role}` }] }));
    } else if (shape === "promo") {
      const shop = pick(SHOPS), c = code(); codes.push(c);
      add(shape, `${shop} <deals@${shop.toLowerCase().replace(/[^a-z]/g, "")}.example>`, (t) => ({ subject: `Your ${t} offer: ${c}`, rest: `Use code ${c} at checkout for a fifth off before Friday.`,
        facts: [
          { entity: shop, type: "org", attribute: "next_step", value: `Use code ${c} at checkout`, quote: `Use code ${c} at checkout` },
          { entity: owner.name, type: "person", attribute: "next_step", value: `Redeem ${c} before Friday`, quote: `Use code ${c} at checkout for a fifth off before Friday` },
        ] }));
    } else if (shape === "receipt") {
      const shop = pick(SHOPS), total = `${20 + Math.floor(r() * 400)}.${10 + Math.floor(r() * 89)}`;
      add(shape, `${shop} <no-reply@${shop.toLowerCase().replace(/[^a-z]/g, "")}.example>`, (t) => ({ subject: `Receipt for your ${t} order`, rest: `Thank you ${owner.name}. Order total ${total} paid by card.`,
        facts: [
          { entity: shop, type: "org", attribute: "last_order_total", value: total, quote: `Order total ${total}` },
          { entity: owner.name, type: "person", attribute: "customer_of", value: shop, quote: `Thank you ${owner.name}` },
        ] }));
    } else if (shape === "owner-signature" || shape === "owner-flipped") {
      // The owner's own mail, read back from the Sent copy: the signature names them.
      const role = pick(ROLES), named = shape === "owner-flipped" ? `${last}, ${first}` : pick([owner.name, `Mr ${owner.name}`, `${owner.name} (${pick(SHOPS)})`]);
      add(shape, `${owner.name} <${owner.address}>`, (t) => ({ subject: `Re: the ${t} plan`, rest: `I can do Tuesday.\n${named}\n${role}`,
        facts: [{ entity: named, type: "person", attribute: "role", value: role, quote: `${named}\n${role}` }, { entity: named, type: "person", attribute: "role", value: role, quote: named }] }));
    } else {
      const who = person(), role = pick(ROLES), shop = pick(SHOPS), c = code(); codes.push(c);
      add("forwarded", `${who} <${who.split(" ")[1]!.toLowerCase()}@mail.example>`, (t) => ({ subject: `Fwd: Fwd: ${t} voucher`, rest: `Passing this on.\n\n---------- Forwarded message ---------\nFrom: ${shop} <no-reply@shop.example>\nTo: ${owner.name} <${owner.address}>\n\n> Voucher ${c} for ${owner.name}.\n> ${who} is the ${role} there.`,
        facts: [
          { entity: owner.name, type: "person", attribute: "voucher", value: c, quote: `Voucher ${c} for ${owner.name}` },
          { entity: who, type: "person", attribute: "role", value: role, quote: `${who} is the ${role}` },
        ] }));
    }
  }
  // The same mail again: once under a new id (a forward to oneself), once the very same item.
  const again = mails[Math.floor(r() * mails.length)]!;
  mails.push({ ...again, id: id(), shape: "repeat" }, { ...again });
  return { seed, owner, mails, codes };
}

// The mails as a Gmail fixture file (the shape src/pull.ts toItem reads).
export const gmailItems = (w: Week) => w.mails.map((m, i) => ({ id: m.id, labelIds: ["INBOX"], internalDate: String(1790000000000 + i * 60_000),
  payload: { headers: [{ name: "From", value: m.from }, { name: "To", value: m.from.includes(w.owner.address) ? "someone@mail.example" : w.owner.address }, { name: "Subject", value: m.subject }] }, text: m.text }));

// The careless extractor: whatever mail the prompt carries, its planted facts come back.
export const careless = (w: Week) => (prompt: string) => JSON.stringify({ facts: w.mails.filter((m) => prompt.includes(m.key)).flatMap((m) => m.facts) });
