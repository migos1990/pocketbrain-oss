// SPDX-License-Identifier: AGPL-3.0-only
// The decision deck: everything that needs the owner, as cards he can swipe through on a phone.

export type Dir = "right" | "left" | "up" | "tap";

export interface Choice {
  id: string;            // stable within the card, e.g. "keep-1", "reject", "later"
  label: string;         // button text, sentence case: "Keep 12 Rue Clark", "Drop it", "Still true"
  action: string;        // dashboard action posted to /action/<action>
  fields: Record<string, string>; // form fields besides csrf
  dir: Dir;              // swipe right / left / up, or tap-only (extra choices)
  tone: "good" | "bad" | "neutral";
  href?: string;         // instead of posting, open this dashboard page (e.g. "Change it")
}

export interface Line { label: string; value: string; meta?: string } // one evidence row; meta = "Gmail, 3 Oct" etc.

export interface Card {
  key: string;
  kind: "dispute" | "proposal" | "fact" | "mail" | "capture" | "held-answer" | "alert" | "upkeep" | "rules" | "usage";
  tag: string;           // short plain label: "Conflict", "New fact", "Still true?", "Held mail"
  question: string;      // the one question, plain words
  lines: Line[];         // evidence the owner can scroll; empty for private cards
  hidden?: string;       // set when values are withheld on this card: why ("private: open on the Mac")
  choices: Choice[];     // 2 to 4
  auto?: { choice: string; at: string; why: string }; // if unanswered by `at` (ISO), the hub picks `choice` because `why`
  never_auto?: string;   // why the hub never decides this one alone ("held mail goes out only on your word")
  href?: string;         // the full page in the dashboard
}

export interface AutoDone { key: string; question: string; picked: string; why: string; at: string; commit: string; undone?: boolean }

export interface DeckView {
  cards: Card[];         // ordered: urgent first, then soonest auto deadline, then facts
  cleared_today: number; // cards answered today (owner)
  seconds_today: number; // owner time on the deck today, from swipe timings
  streak: number;        // days in a row the deck reached zero
  auto: AutoDone[];      // hub decisions in the last 7 days, newest first, each undoable
}
