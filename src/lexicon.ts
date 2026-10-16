// SPDX-License-Identifier: AGPL-3.0-only
// A general French-English word map for search (eval gap G172): a question asked in one language
// finds a note written in the other. Each group is one meaning, its words in both languages; the
// query side expands through it, so the per-agent index is untouched and an expanded word can only
// match notes that agent already sees. Generic everyday, family, home, work, school and money
// vocabulary, in no way drawn from anyone's notes. Off unless PB_LEXICON=1 until
// it has proven itself on the blind golden questions (evals/README.md, gap G172).
export const LEXICON: string[][] = [
  // people and family
  ["sister", "soeur"], ["brother", "frere"], ["mother", "mom", "mere", "maman"], ["father", "dad", "pere", "papa"],
  ["parents", "parent"], ["children", "kids", "enfants", "enfant"], ["neighbour", "neighbor", "voisin", "voisine"],
  ["friend", "ami", "amie"], ["family", "famille"], ["birthday", "anniversaire"], ["wedding", "mariage"],
  ["teacher", "enseignant", "enseignante", "professeur", "prof"], ["student", "students", "etudiant", "etudiante", "eleve"],
  ["coach", "entraineur", "entraineuse"], ["doctor", "medecin", "docteur"], ["dentist", "dentiste"], ["vet", "veterinarian", "veterinaire"],
  ["plumber", "plombier"], ["electrician", "electricien"], ["contractor", "entrepreneur"], ["landlord", "proprietaire"], ["tenant", "locataire"],
  ["accountant", "comptable"], ["lawyer", "avocat", "avocate"], ["notary", "notaire"], ["recruiter", "recruteur", "recruteuse"],
  ["colleague", "collegue"], ["boss", "manager", "patron", "gestionnaire"], ["assistant", "auxiliaire", "adjoint", "adjointe"],
  ["director", "directeur", "directrice"], ["chair", "head", "directeur", "directrice"], ["dean", "doyen", "doyenne"],
  // home
  ["home", "house", "maison", "domicile"], ["apartment", "appartement", "logement"], ["kitchen", "cuisine"], ["bathroom", "salle de bain"],
  ["bedroom", "chambre"], ["office", "bureau"], ["desk", "bureau"], ["garden", "jardin", "potager"], ["vegetable", "legume", "legumes", "potager"],
  ["yard", "backyard", "cour"], ["sink", "evier", "lavabo"], ["plumbing", "pipes", "plomberie", "tuyauterie"], ["dishwasher", "lave-vaisselle"],
  ["counter", "countertop", "comptoir"], ["renovation", "renovations", "remodel", "renovation"], ["repair", "fix", "reparer", "reparation"],
  ["key", "keys", "cle", "cles"], ["spare", "backup", "secours", "rechange"], ["door", "porte"], ["lease", "rent", "bail", "loyer"],
  ["moving", "move", "demenagement", "demenager"], ["garbage", "trash", "poubelle", "poubelles", "ordures"], ["plants", "plantes"],
  ["water", "eau", "arroser"], ["electricity", "power", "electricite"], ["bill", "invoice", "facture"], ["heating", "chauffage"],
  ["insurance", "assurance"], ["deductible", "franchise"], ["policy", "police", "contrat"], ["mortgage", "hypotheque", "hypothecaire"],
  ["cottage", "cabin", "maison de campagne"], ["grocery", "groceries", "epicerie"], ["shopping", "achats", "courses", "magasinage"], ["list", "liste"],
  ["garlic", "ail"], ["tomatoes", "tomates"], ["apples", "pommes"], ["cheese", "fromage"], ["bread", "pain"], ["coffee", "cafe"],
  ["cat", "chat"], ["dog", "chien"], ["vaccine", "vaccines", "vaccin", "vaccins"],
  // time
  ["yesterday", "hier"], ["today", "aujourd'hui"], ["tomorrow", "demain"], ["week", "semaine"], ["weekend", "fin de semaine"],
  ["month", "mois"], ["year", "annee", "an"], ["morning", "matin"], ["evening", "soir"], ["night", "nuit"],
  ["monday", "lundi"], ["tuesday", "mardi"], ["wednesday", "mercredi"], ["thursday", "jeudi"], ["friday", "vendredi"], ["saturday", "samedi"], ["sunday", "dimanche"],
  ["january", "janvier"], ["february", "fevrier"], ["march", "mars"], ["april", "avril"], ["may", "mai"], ["june", "juin"],
  ["july", "juillet"], ["august", "aout"], ["september", "septembre"], ["october", "octobre"], ["november", "novembre"], ["december", "decembre"],
  ["winter", "hiver"], ["spring", "printemps"], ["summer", "ete"], ["fall", "autumn", "automne"], ["christmas", "noel"], ["holidays", "vacances", "fetes"],
  ["deadline", "due", "echeance", "date limite"], ["schedule", "timetable", "horaire", "calendrier"], ["appointment", "rendez-vous"],
  // work and school
  ["meeting", "reunion", "rencontre"], ["call", "appel"], ["email", "emails", "mail", "courriel", "courriels"], ["notifications", "notification", "avis"],
  ["job", "position", "opening", "poste", "emploi"], ["hire", "hiring", "embauche", "embaucher", "engager"], ["salary", "salaire"],
  ["work", "travail", "boulot"], ["project", "projet"], ["department", "departement"], ["university", "universite"], ["school", "ecole"],
  ["course", "class", "cours"], ["lesson", "lessons", "lecon", "lecons", "cours"], ["exam", "examen"], ["homework", "devoirs", "devoir"],
  ["math", "maths", "mathematiques"], ["reading", "lecture"], ["required", "mandatory", "obligatoire"], ["textbook", "book", "manuel", "livre"],
  ["thesis", "dissertation", "memoire", "these"], ["master's", "masters", "maitrise"], ["chapter", "chapitre"], ["grade", "grading", "corriger", "notes"],
  ["research", "recherche"], ["grant", "funding", "subvention", "financement"], ["application", "demande"], ["budget", "budget"],
  ["conference", "conference", "colloque"], ["talk", "presentation", "conference", "expose"], ["slides", "diapositives", "diapos"],
  ["security", "securite"], ["vote", "vote", "scrutin"], ["proposal", "proposals", "proposition"], ["teaching", "enseignement"],
  // money
  ["tax", "taxes", "impot", "impots"], ["refund", "remboursement"], ["return", "declaration"], ["income", "revenus", "revenu"],
  ["bank", "banque", "caisse"], ["credit", "credit"], ["loan", "pret"], ["rate", "taux"], ["price", "cost", "prix", "cout"],
  ["deposit", "depot"], ["payment", "paiement"], ["paid", "paye", "payee"],
  // getting around and leisure
  ["car", "voiture", "auto"], ["electric", "electrique"], ["charger", "charging", "borne", "recharge"], ["bike", "bicycle", "velo"],
  ["brakes", "brake", "freins", "frein"], ["trip", "travel", "voyage"], ["plane", "flight", "avion", "vol"], ["tickets", "billets", "billet"],
  ["booking", "reservation", "booked", "reserve"], ["running", "run", "course"], ["soccer", "football", "soccer"], ["piano", "piano"],
  ["practice", "practices", "pratique", "pratiques", "entrainement"], ["phone", "cell", "mobile", "cellulaire", "telephone"],
  ["plan", "forfait"], ["standing", "debout"], ["guest room", "spare room", "chambre d'amis"],
];
