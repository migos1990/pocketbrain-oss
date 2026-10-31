// SPDX-License-Identifier: AGPL-3.0-only
// The demo brain's people, places, projects and choices (outside review 2026-10-29, item 2: design
// every screen against a brain shaped like a life, not a 7-note sample). Everyone here is made up:
// no real name, address, number or employer. scripts/demo-brain.ts turns these tables into
// examples/demo-brain/ and replays a week on top of it.

export const OWNER = { name: "Robin Lefebvre", slug: "robin-lefebvre", address: "robin@example.org" };

// [slug, title, kind, city, area, prose]
export const ORGS: [string, string, string, string, string, string][] = [
  ["harbourline", "Harbourline Software", "software company", "Montréal", "work", "Where Robin leads product for the Atlas line. About 120 people, most of them on two floors in the Mile End."],
  ["lakeshore-college", "Lakeshore College", "college, continuing studies", "Montréal", "teaching", "Robin teaches the evening Product Discovery course here, Tuesdays in room B-214."],
  ["northgate-design", "Northgate Design Studio", "design agency", "Montréal", "work", "The agency picked in September for the pricing page refresh."],
  ["pinecrest-labs", "Pinecrest Labs", "analytics start-up", "Toronto", "work", "A partner company piloting the Atlas data export. Small team, moves fast."],
  ["fernwood-climbing", "Fernwood Climbing Gym", "climbing gym", "Montréal", "personal", "The Thursday night bouldering spot."],
  ["rosemont-choir", "Rosemont Children's Choir", "children's choir", "Montréal", "personal", "Léa sings here on Saturday mornings."],
  ["atelier-boreal", "Atelier Boréal", "renovation contractor", "Montréal", "personal", "The contractor doing the kitchen."],
  ["tilehouse-supply", "Tilehouse Supply", "tile supplier", "Laval", "personal", "Where the kitchen tile comes from."],
  ["maison-des-pins", "Maison des Pins", "residence for seniors", "Montréal", "personal", "Hélène's new building, a ten-minute walk from Robin's place."],
  ["parc-avenue-books", "Parc Avenue Books", "bookshop", "Montréal", "personal", "The book club meets in the back room on the last Wednesday of the month."],
  ["fieldnote", "Fieldnote", "product studio", "Toronto", "teaching", "Zoe Harper's studio; two Lakeshore alumni work there now."],
  ["gaspe-cottages", "Gaspé Cottages", "cottage rental", "Percé", "personal", "The cottage on the bay for next summer."],
];

// A person: [name, area, role, org slug or "", how Robin knows them, city, has mail, prose]
// prose is Robin's own notes on them: [[links]] to other pages, a footnote added by the generator.
export type Person = [string, string, string, string, string, string, boolean, string];
export const PEOPLE: Person[] = [
  // work
  ["Maya Chen", "work", "design lead", "harbourline", "works with Robin on Atlas", "Montréal", true, "Maya leads design for the [[projects/atlas-launch]] and ran the September usability sessions with [[people/kenji-watanabe]]. She is the one to ask before anything ships with a new screen."],
  ["Omar Haddad", "work", "engineering manager", "harbourline", "works with Robin on Atlas", "Montréal", true, "Omar runs the Atlas engineering team. His team owns the beta build, and he and [[people/daniel-okoro]] decide what gets cut when a date slips."],
  ["Priya Shah", "work", "VP of Product", "harbourline", "Robin's manager", "Montréal", true, "Priya is Robin's manager. Weekly one-on-one on Mondays at 9:30; she wants the [[projects/q1-roadmap]] draft before the leadership offsite."],
  ["Daniel Okoro", "work", "staff engineer", "harbourline", "works with Robin on Atlas", "Montréal", true, "Daniel wrote most of the export service that [[orgs/pinecrest-labs]] is piloting. Prefers a written spec over a meeting."],
  ["Sofia Marquez", "work", "product marketing manager", "harbourline", "works with Robin on Atlas", "Montréal", true, "Sofia owns the launch story for the [[projects/atlas-launch]] and the copy for the [[projects/pricing-page-refresh]]."],
  ["Kenji Watanabe", "work", "data analyst", "harbourline", "works with Robin", "Montréal", true, "Kenji builds the Atlas usage dashboards and pulled the numbers behind the [[decisions/2026-09-08-atlas-beta-scope]]."],
  ["Grace Liu", "work", "customer success lead", "harbourline", "works with Robin", "Montréal", true, "Grace speaks for the ten beta customers. She sends a short summary every Friday."],
  ["Tomás Rivera", "work", "backend engineer", "harbourline", "on the Atlas team", "Montréal", true, "Tomás joined the Atlas team in August from the payments group."],
  ["Hannah Becker", "work", "QA lead", "harbourline", "on the Atlas team", "Montréal", true, "Hannah runs the release checklist for the [[projects/atlas-launch]]."],
  ["Felix Moreau", "work", "recruiter", "harbourline", "works with Robin on hiring", "Montréal", true, "Felix runs the search for the [[projects/designer-hire]]. He books the panels and chases the feedback."],
  ["Aisha Rahman", "work", "CTO", "harbourline", "Priya's peer", "Montréal", true, "Aisha signs off on anything that touches customer data, so the [[projects/pinecrest-partnership]] goes through her."],
  ["Lucas Fontaine", "work", "senior product designer", "northgate-design", "a candidate for the design role", "Montréal", true, "Lucas is a candidate for the [[projects/designer-hire]]; strong portfolio, did the second panel with [[people/maya-chen]]."],
  ["Nina Petrova", "work", "freelance product designer", "", "a candidate for the design role", "Québec City", true, "Nina is the other finalist for the [[projects/designer-hire]]. Would move from Québec City."],
  ["Ben Carter", "work", "head of partnerships", "pinecrest-labs", "the Pinecrest contact", "Toronto", true, "Ben is the day-to-day contact for the [[projects/pinecrest-partnership]]."],
  ["Chloé Gagnon", "work", "account executive", "pinecrest-labs", "on the Pinecrest pilot", "Toronto", true, "Chloé handles the paperwork side of the Pinecrest pilot with [[people/ben-carter]]."],
  ["Ravi Menon", "work", "founder", "pinecrest-labs", "met at a conference", "Toronto", true, "Ravi founded [[orgs/pinecrest-labs]]. Robin met him at a Toronto product meetup in the spring."],
  ["Elena Rossi", "work", "creative director", "northgate-design", "the agency lead", "Montréal", true, "Elena leads the [[orgs/northgate-design]] team on the [[projects/pricing-page-refresh]]."],
  ["Marcus Webb", "work", "copywriter", "northgate-design", "on the pricing page", "Montréal", true, "Marcus writes the pricing page copy with [[people/sofia-marquez]]."],
  ["Julie Tran", "work", "business operations lead", "harbourline", "works with Robin on planning", "Montréal", true, "Julie keeps the planning calendar and the headcount plan behind the [[projects/q1-roadmap]]."],
  ["Sam Patel", "work", "advisor", "", "Robin's former manager and mentor", "Ottawa", true, "Sam was Robin's first manager and is still the person Robin calls before a hard decision. Lunch every couple of months."],
  // teaching
  ["Claire Dubois", "teaching", "program director", "lakeshore-college", "runs the program Robin teaches in", "Montréal", true, "Claire hired Robin to teach Product Discovery and approves changes to the [[projects/product-discovery-course]]."],
  ["Antoine Lavoie", "teaching", "teaching assistant", "lakeshore-college", "Robin's TA", "Montréal", true, "Antoine is the TA for the [[projects/product-discovery-course]]; he grades the weekly reflections."],
  ["Mei Lin", "teaching", "student, team lead for group A", "lakeshore-college", "a student", "Montréal", true, "Mei leads group A in the [[projects/final-projects]]; their project is a grocery pickup app."],
  ["Jacob Stein", "teaching", "student", "lakeshore-college", "a student", "Montréal", true, "Jacob is in group A with [[people/mei-lin]]."],
  ["Fatima Diallo", "teaching", "student, team lead for group B", "lakeshore-college", "a student", "Montréal", true, "Fatima leads group B in the [[projects/final-projects]], a tool for community gardens."],
  ["Lucas Bergeron", "teaching", "student", "lakeshore-college", "a student", "Longueuil", true, "Lucas is in group B with [[people/fatima-diallo]]."],
  ["Isabelle Roy", "teaching", "course coordinator", "lakeshore-college", "handles rooms and grades", "Montréal", true, "Isabelle books the rooms and takes the final grades for the [[projects/product-discovery-course]]."],
  ["Peter Novak", "teaching", "guest lecturer", "pinecrest-labs", "a guest speaker", "Toronto", true, "Peter gives the analytics talk in the [[projects/guest-lecture-series]]."],
  ["Zoe Harper", "teaching", "guest lecturer", "fieldnote", "a guest speaker", "Toronto", true, "Zoe runs [[orgs/fieldnote]] and gives the research talk in the [[projects/guest-lecture-series]]."],
  ["Marc-André Côté", "teaching", "dean of continuing studies", "lakeshore-college", "Claire's boss", "Montréal", true, "Marc-André signs the teaching contracts at [[orgs/lakeshore-college]]."],
  ["Sarah Kim", "teaching", "student", "lakeshore-college", "a student", "Montréal", true, "Sarah is in group C; she asked about a reference letter for a product internship."],
  ["Olivier Pelletier", "teaching", "AV technician", "lakeshore-college", "fixes the projector", "Montréal", false, "Olivier is the one to call when the room B-214 projector won't connect."],
  ["Laila Haddad", "teaching", "associate product manager", "harbourline", "a former student", "Montréal", true, "Laila took the course two years ago and now works at [[orgs/harbourline]]; she will speak to the class about her first year as a PM."],
  ["Ethan Brooks", "teaching", "student", "lakeshore-college", "a student", "Montréal", true, "Ethan is in group C with [[people/sarah-kim]]."],
  // family
  ["Jordan Ellis", "personal", "architect", "", "Robin's partner", "Montréal", true, "Jordan is Robin's partner. Handles the [[projects/kitchen-renovation]] with [[people/luc-gauthier]] while Robin handles the [[projects/moms-move]]."],
  ["Léa Lefebvre", "personal", "", "rosemont-choir", "Robin's daughter, 9", "Montréal", false, "Léa is nine and sings in the [[orgs/rosemont-choir]]; the [[projects/choir-winter-concert]] is her first solo."],
  ["Theo Lefebvre", "personal", "", "", "Robin's son, 6", "Montréal", false, "Theo is six. Piano with [[people/karen-liu]] on Wednesdays."],
  ["Hélène Lefebvre", "personal", "retired teacher", "", "Robin's mother", "Montréal", true, "Hélène is Robin's mother. She is moving to [[orgs/maison-des-pins]] in December ([[projects/moms-move]])."],
  ["Marc Lefebvre", "personal", "paramedic", "", "Robin's brother", "Québec City", true, "Marc is Robin's younger brother, in Québec City with [[people/nadia-lefebvre]] and [[people/camille-lefebvre]]. He is helping with the move in December."],
  ["Nadia Lefebvre", "personal", "pharmacist", "", "Marc's wife", "Québec City", false, "Nadia is married to [[people/marc-lefebvre]]."],
  ["Camille Lefebvre", "personal", "", "", "Robin's niece, 12", "Québec City", false, "Camille is Marc and Nadia's daughter; she and [[people/lea-lefebvre]] video-call on Sundays."],
  ["Robert Ellis", "personal", "retired engineer", "", "Jordan's father", "Sherbrooke", false, "Robert is Jordan's father; the family goes to Sherbrooke for Thanksgiving."],
  ["Anne Ellis", "personal", "potter", "", "Jordan's mother", "Sherbrooke", true, "Anne is Jordan's mother; she makes the bowls everyone in the family eats from."],
  ["Sophie Girard", "personal", "nurse", "", "Robin's cousin", "Montréal", true, "Sophie is Robin's cousin and Léa's godmother."],
  // friends
  ["Inès Bouchard", "personal", "", "fernwood-climbing", "climbing partner", "Montréal", true, "Inès is Robin's Thursday climbing partner at [[orgs/fernwood-climbing]]."],
  ["Kai Nakamura", "personal", "", "fernwood-climbing", "climbing friend", "Montréal", true, "Kai is organizing the [[projects/red-river-trip]]."],
  ["Rachel Adler", "personal", "bookseller", "parc-avenue-books", "hosts the book club", "Montréal", true, "Rachel hosts the [[projects/book-club-november]] at [[orgs/parc-avenue-books]]."],
  ["Diego Alvarez", "personal", "", "", "book club friend", "Montréal", true, "Diego picks the books nobody else would. He chose the November one."],
  ["Hugo Martin", "personal", "", "", "next-door neighbour", "Montréal", false, "Hugo lives next door and has the spare key."],
  ["Emma Wilson", "personal", "", "", "friend from university", "Vancouver", true, "Emma and Robin shared an apartment in university; she visits every other summer."],
  ["Yusuf Kaya", "personal", "chef", "", "old friend", "Montréal", true, "Yusuf cooks for every birthday and owes Robin a rematch at chess."],
  ["Lina Sato", "personal", "choir director", "rosemont-choir", "Léa's choir director", "Montréal", true, "Lina directs the [[orgs/rosemont-choir]] and picked Léa for the solo."],
  ["Martin Leclerc", "personal", "", "", "choir carpool parent", "Montréal", true, "Martin shares the Saturday choir carpool with Robin."],
  ["Bea Thompson", "personal", "café owner", "", "friend", "Montréal", true, "Bea runs the café on the corner where Robin grades on Sunday mornings."],
  // services
  ["Luc Gauthier", "personal", "general contractor", "atelier-boreal", "the kitchen contractor", "Montréal", true, "Luc runs [[orgs/atelier-boreal]] and is doing the [[projects/kitchen-renovation]]."],
  ["Simone Laurent", "personal", "sales rep", "tilehouse-supply", "the tile supplier", "Laval", true, "Simone at [[orgs/tilehouse-supply]] handles the kitchen tile order."],
  ["Patrick O'Neil", "personal", "accountant", "", "files the household taxes", "Montréal", true, "Patrick does the household taxes every spring."],
  ["Valérie Roy", "personal", "residence manager", "maison-des-pins", "manages Hélène's new building", "Montréal", true, "Valérie manages [[orgs/maison-des-pins]] and holds the unit for [[people/helene-lefebvre]]."],
  ["Ahmed Saleh", "personal", "electrician", "", "works with Luc", "Montréal", true, "Ahmed does the electrical for the [[projects/kitchen-renovation]]."],
  ["Karen Liu", "personal", "piano teacher", "", "Theo's piano teacher", "Montréal", true, "Karen teaches Theo piano on Wednesdays after daycare."],
];

// [slug, title, area, status, lead person slug, due, next step, people slugs, prose]
export const PROJECTS: [string, string, string, string, string, string, string, string[], string][] = [
  ["atlas-launch", "Atlas launch", "work", "in beta", "robin-lefebvre", "2026-11-03", "freeze the beta build", ["maya-chen", "omar-haddad", "daniel-okoro", "sofia-marquez", "hannah-becker"], "The Atlas launch is the big one this fall: ten beta customers, a public launch on 3 November. [[people/grace-liu]] collects what the beta customers say every Friday."],
  ["q1-roadmap", "Q1 roadmap", "work", "drafting", "robin-lefebvre", "2026-11-20", "share the first draft with Priya", ["priya-shah", "julie-tran", "kenji-watanabe"], "The plan for January to March. [[people/priya-shah]] takes it to the leadership offsite on 20 November."],
  ["designer-hire", "Senior designer hire", "work", "final round", "felix-moreau", "2026-10-30", "send the offer decision to Felix", ["lucas-fontaine", "nina-petrova", "maya-chen"], "One senior product designer to join [[people/maya-chen]]'s team. Two finalists after the second panel."],
  ["pricing-page-refresh", "Pricing page refresh", "work", "in design", "sofia-marquez", "2026-11-10", "review the second round of mockups", ["elena-rossi", "marcus-webb"], "A new pricing page for the launch, designed by [[orgs/northgate-design]]."],
  ["pinecrest-partnership", "Pinecrest pilot", "work", "pilot running", "robin-lefebvre", "2026-12-15", "agree on the pilot success numbers", ["ben-carter", "chloe-gagnon", "ravi-menon", "aisha-rahman"], "A three-month pilot of the Atlas data export with [[orgs/pinecrest-labs]]."],
  ["product-discovery-course", "Product Discovery course", "teaching", "week 6 of 13", "robin-lefebvre", "2026-12-08", "grade the midterm reflections", ["antoine-lavoie", "claire-dubois", "isabelle-roy"], "The Tuesday evening course at [[orgs/lakeshore-college]], 28 students, thirteen weeks."],
  ["guest-lecture-series", "Guest lectures", "teaching", "booking", "robin-lefebvre", "2026-11-24", "confirm Zoe's date", ["peter-novak", "zoe-harper", "laila-haddad"], "Three outside speakers for the course: analytics, research, and a first-year PM."],
  ["final-projects", "Final projects", "teaching", "teams formed", "robin-lefebvre", "2026-12-08", "meet each team for a check-in", ["mei-lin", "fatima-diallo", "sarah-kim"], "Groups of four build and test a product idea; demo night is 8 December."],
  ["kitchen-renovation", "Kitchen renovation", "personal", "demolition done", "jordan-ellis", "2026-12-01", "confirm the tile delivery date", ["luc-gauthier", "simone-laurent", "ahmed-saleh"], "New counters, new floor, the wall to the dining room comes down. [[people/jordan-ellis]] drew the plans."],
  ["moms-move", "Mom's move", "personal", "planning", "robin-lefebvre", "2026-12-12", "book the movers", ["helene-lefebvre", "marc-lefebvre", "valerie-roy"], "Hélène moves from the house on rue Fabre to [[orgs/maison-des-pins]] in December."],
  ["gaspesie-trip", "Gaspésie trip", "personal", "idea", "jordan-ellis", "2027-07-15", "pick the week", ["jordan-ellis"], "Two weeks on the Gaspé coast next July, a cottage from [[orgs/gaspe-cottages]]."],
  ["choir-winter-concert", "Choir winter concert", "personal", "rehearsing", "lina-sato", "2026-12-13", "buy the concert tickets for the grandparents", ["lea-lefebvre", "martin-leclerc"], "Léa's first solo, 13 December at the church on rue Saint-Hubert."],
  ["red-river-trip", "Red River climbing trip", "personal", "dates set", "kai-nakamura", "2027-04-10", "book the cabin", ["ines-bouchard"], "A week of sandstone climbing in Kentucky in April with [[people/ines-bouchard]] and Kai."],
  ["book-club-november", "Book club, November", "personal", "reading", "rachel-adler", "2026-11-25", "finish the book", ["diego-alvarez"], "November's book is a 600-page novel Diego picked; meeting on the 25th."],
];

// [date, slug, title, area, chose, why, project slug, people slugs]
export const DECISIONS: [string, string, string, string, string, string, string, string[]][] = [
  ["2026-09-08", "atlas-beta-scope", "Atlas beta scope", "work", "ship export and sharing, leave offline mode for after launch", "offline mode needs another month and only two beta customers asked for it", "atlas-launch", ["omar-haddad", "kenji-watanabe"]],
  ["2026-09-15", "hire-senior-designer", "Hire a senior designer, not two juniors", "work", "one senior designer", "Maya needs someone who can own a whole area on day one", "designer-hire", ["maya-chen", "priya-shah"]],
  ["2026-09-22", "pick-northgate", "Northgate for the pricing page", "work", "Northgate Design Studio", "they did the best work on the test brief and can start in October", "pricing-page-refresh", ["elena-rossi", "sofia-marquez"]],
  ["2026-09-29", "pinecrest-pilot-length", "Three-month Pinecrest pilot", "work", "a three-month pilot", "long enough to see two month-end exports", "pinecrest-partnership", ["ben-carter", "aisha-rahman"]],
  ["2026-09-10", "final-project-format", "Final projects in teams of four", "teaching", "teams of four with a demo night", "last year's pairs had too little to show", "final-projects", ["claire-dubois", "antoine-lavoie"]],
  ["2026-09-24", "three-guest-speakers", "Three guest speakers this term", "teaching", "three speakers", "students rated the guest weeks highest last year", "guest-lecture-series", ["claire-dubois"]],
  ["2026-08-30", "kitchen-contractor", "Atelier Boréal for the kitchen", "personal", "Atelier Boréal", "Luc could start in September and had done the neighbours' kitchen", "kitchen-renovation", ["luc-gauthier", "jordan-ellis"]],
  ["2026-09-28", "mom-moves-in-december", "Mom moves in December", "personal", "move in December", "the unit at Maison des Pins frees up on 1 December and Marc can come that week", "moms-move", ["helene-lefebvre", "marc-lefebvre"]],
  ["2026-09-25", "red-river-dates", "Red River in April", "personal", "the week of 10 April", "the rock is driest and everyone can take that week", "red-river-trip", ["kai-nakamura", "ines-bouchard"]],
  ["2026-10-01", "weekly-team-review", "Weekly Atlas review on Wednesdays", "work", "a 30-minute review every Wednesday", "the daily stand-up was not catching cross-team issues", "atlas-launch", ["omar-haddad", "maya-chen", "hannah-becker"]],
];

// Private money pages (the owner only): [slug, title, facts {attr: value}, prose]
export const MONEY: [string, string, Record<string, string>, string][] = [
  ["kitchen-budget", "Kitchen budget", { total: "42,000 CAD", deposit_paid: "8,000 CAD on 2026-09-02", next_payment: "12,000 CAD when the counters go in" }, "What the [[projects/kitchen-renovation]] costs, from [[people/luc-gauthier]]'s quote. The other money page is [[money/household-taxes]]."],
  ["household-taxes", "Household taxes", { filed_by: "Patrick O'Neil", next_instalment: "2026-12-15" }, "[[people/patrick-o-neil]] files them; the next instalment is mid-December, the same month as a [[money/kitchen-budget]] payment."],
];

// What Robin's assistants remember about Robin, in their own words (imported memories, G490).
export const PREFERS: [string, string][] = [
  ["prefers short answers with the decision first", "chatgpt-mem"],
  ["likes meeting notes as a bulleted list with owners and dates", "chatgpt-mem"],
  ["does not take work calls before 9 or after 6", "owner"],
  ["writes French with family and English at work", "owner"],
  ["wants drafts in plain words, no jargon", "chatgpt-mem"],
  ["grades on Sunday mornings at the café", "claude-mem"],
];
