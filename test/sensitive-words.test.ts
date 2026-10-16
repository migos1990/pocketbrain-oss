// SPDX-License-Identifier: AGPL-3.0-only
// Other people's health, school, legal and money words in French and English, accented or not
// (eval gap G129): JavaScript's \b only knows ASCII letters, so /\bsanté\b/ never matched "santé".
import { test, expect } from "bun:test";
import { thirdPartySensitive, moneyAsk } from "../src/checks";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";

const person = (value: string) => thirdPartySensitive({ agent: "planner", id: "people/jane-roy", attribute: "note", value });

// One sentence per word, the word where an accent sits next to the boundary when it has one.
const SENSITIVE: [string, string][] = [
  // health
  ["Problèmes de santé depuis l'été", "santé"],
  ["Santé fragile", "Santé"],
  ["Elle est malade", "malade"],
  ["Congé de maladie jusqu'en mars", "maladie"],
  ["Suivi médical chaque mois", "médical"],
  ["Prend un médicament le soir", "médicament"],
  ["En thérapie", "thérapie"],
  ["Voit une thérapeute", "thérapeute"],
  ["Elle est enceinte", "enceinte"],
  ["Grossesse difficile", "Grossesse"],
  ["Opération: chirurgie du genou", "chirurgie"],
  ["Admis à l'hôpital", "hôpital"],
  ["Hospitalisée en août", "Hospitalisée"],
  ["Traite une dépression", "dépression"],
  ["Crises d'anxiété", "anxiété"],
  ["Diagnostic de TDAH", "Diagnostic"],
  ["Son fils a un TDAH", "TDAH"],
  ["Vit avec un handicap", "handicap"],
  ["Starting chemo next week", "chemo"],
  ["Diagnosed with cancer", "Diagnosed"],
  ["Had surgery in May", "surgery"],
  ["In hospital since Friday", "hospital"],
  ["Struggles with depression", "depression"],
  ["Her son is autistic", "autistic"],
  ["Has ADHD", "ADHD"],
  ["On a disability leave", "disability"],
  ["On medication for anxiety", "medication"],
  // school
  ["Son fils change d'école", "école"],
  ["École primaire Saint-Jean", "École"],
  ["En adaptation scolaire", "scolaire"],
  ["Mauvais bulletin ce trimestre", "bulletin"],
  ["Expulsé du collège", "Expulsé"],
  ["Sa fille est dyslexique", "dyslexique"],
  ["Got a bad report card", "report card"],
  ["Has an IEP at school", "IEP"],
  ["Expelled last year", "Expelled"],
  // legal
  ["En procédure de divorce", "divorce"],
  ["Divorcée depuis 2024", "Divorcée"],
  ["Garde partagée des enfants", "Garde partagée"],
  ["A un casier judiciaire", "casier judiciaire"],
  ["Poursuite judiciaire contre son employeur", "Poursuite judiciaire"],
  ["A fait de la prison", "prison"],
  ["Arrestation en 2019", "Arrestation"],
  ["Has a criminal record", "criminal"],
  ["Fighting for custody", "custody"],
  ["Was sued by a client", "sued"],
  ["On probation until June", "probation"],
  // money
  ["Beaucoup de dettes", "dettes"],
  ["Très endettée", "endettée"],
  ["A fait faillite en 2022", "faillite"],
  ["Son salaire a baissé", "salaire"],
  ["Une grosse hypothèque", "hypothèque"],
  ["Went bankrupt", "bankrupt"],
  ["Owes money to his brother", "Owes"],
  ["Lives on a small income", "income"],
  ["Paying off a student loan", "loan"],
];

for (const [value, word] of SENSITIVE) test(`"${word}" in a person's fact makes it private: ${value}`, () => {
  expect(person(value)).toBe(word);
});

test("a decomposed accent (e + combining acute) still matches", () => {
  expect(person("Problèmes de santé")).toBeDefined();
});

// Words that look like one of the above but aren't about health, school, law or money.
for (const value of ["Est prêt pour la rentrée", "Revenu de voyage", "Il est très sain", "Militante écologiste", "Healthy eating blog", "Schoolhouse Rock fan", "Bulletins de vote", "Pays the bills on time"])
  test(`no match: ${value}`, () => {
    expect(person(value)).toBeUndefined();
  });

test("an accented word inside a longer word doesn't match", () => {
  expect(person("Les santéistes")).toBeUndefined();
  expect(person("préécole")).toBeUndefined();
});

test("a money ask in French with accents at the word's edge is caught", () => {
  expect(moneyAsk("Combien Marie a-t-elle gagné", ["Louis"])).toBe("gagné");
  expect(moneyAsk("Marie, où est son argent.", ["Louis"])).toBe("argent");
  expect(moneyAsk("Où Hélène met-elle son argent", ["Hélène"])).toBe("argent");
});

test("an École fact about a person is stored private, for the resolver only", () => {
  const root = makeBrain();
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "relationship", value: "Son fils change d'école en janvier", as_of: "2026-10-01", sources: ["gmail:f000000000000001"], share_with: ["planner", "steward"] });
  expect(r.outcome).toBe("committed");
  const f = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.relationship as FactRecord;
  expect(f.sensitivity).toBe("private");
  expect(f.share_with).toEqual(["steward"]);
});

// Slice audit round 1: plurals, French without accents, snake_case attributes, a curly apostrophe.
const ROUND1: string[] = ["Deux séjours dans des hôpitaux", "Plusieurs thérapies", "Deux chirurgies", "Anxiétés répétées", "Deux faillites", "Changé d'écoles", "Deux bulletins scolaires", "Deux fausses couches", "Problemes de sante", "Change d'ecole", "Admis a l'hopital", "En therapie", "Garde partagee", "Plan d’intervention à l'école primaire", "Changed schools twice", "Two surgeries", "Several therapies", "Long illnesses", "Two lawsuits", "Two mortgages", "Was jailed in 2019", "Sees two therapists"];
for (const value of ROUND1) test(`caught: ${value}`, () => {
  expect(person(value)).toBeDefined();
});

test("a snake_case attribute names the matter", () => {
  for (const attribute of ["diagnosis_date", "pregnancy_due_date", "arrest_record", "medical_history", "health_notes", "school_name"])
    expect(thirdPartySensitive({ agent: "planner", id: "people/jane-roy", attribute, value: "2026-03-01" })).toBeDefined();
});

// Slice audit residual (G197): words the round-1 list missed, and camelCase attributes.
const ROUND2: string[] = ["MRI booked Friday", "Her attorney called", "Talked to two lawyers", "Off sick since Monday", "New prescription", "Healthcare plan", "Insurance claim pending", "Avocat: Me Tremblay", "Dossier au tribunal", "Procès en mai", "Ordonnance renouvelée", "Arrêt maladie jusqu'au 3", "Assurance invalidité", "Prêt étudiant de 9000", "Two MRIs last spring"];
for (const value of ROUND2) test(`caught (G197): ${value}`, () => {
  expect(person(value)).toBeDefined();
});
test("a camelCase attribute names the matter (G197)", () => {
  for (const attribute of ["medicalLeave", "diagnosisDate", "schoolName", "lawyerName"])
    expect(thirdPartySensitive({ agent: "planner", id: "people/jane-roy", attribute, value: "2026-03-01" }), attribute).toBeDefined();
});
for (const value of ["Il est prêt pour samedi", "Elles sont prêtes", "Healthy recipes blog"]) test(`no match (G197): ${value}`, () => {
  expect(person(value)).toBeUndefined();
});

// Stems that caught ordinary words.
for (const value of ["Works in hospitality", "Il est un peu maladroit", "Jane a emprunté mon livre"]) test(`no match: ${value}`, () => {
  expect(person(value)).toBeUndefined();
});

// Slice audit round 2.
for (const value of ["Suivi médicalement", "Situation médicalisée", "Diagnosis_pending", "Arrest_2019", "Homeschooling since May"]) test(`caught: ${value}`, () => {
  expect(person(value)).toBeDefined();
});
