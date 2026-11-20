# SIPA — Système Intégré de Prévention et d’Accès

**Prototype viable (MVP) complet** d’une plateforme de prévention et d’accès aux soins
pensée pour le Sénégal : un coffre-fort sanitaire pseudonymisé, un Bilan Intégré 4-en-1,
un double circuit officinal (autotests et dotations ARV scellées), un assistant
conversationnel PWA/WhatsApp et un portail professionnel à quatre profils.

> Principe directeur : **I = I** (indétectable = intransmissible), **zéro USSD**,
> **protocole Zéro Parole** au comptoir, et **aucune identité civile** demandée à l’usager.

Tout le prototype s’exécute **sans aucune dépendance à installer** : Node.js ≥ 22.5
(SQLite intégré via `node:sqlite`), PWA en JavaScript natif, Leaflet et le générateur de
QR vendorisés localement, typographies auto-hébergées. Aucun build, aucun `npm install`.

---

## 1. Démarrage

```bash
npm start          # http://localhost:8787
npm run dev        # rechargement à chaud du serveur
npm run check      # vérification syntaxique de tous les fichiers JS
npm run smoke      # 44 vérifications de bout en bout contre l’API locale
npm run reset      # efface la base de démonstration (reseed au démarrage)
```

Variables d’environnement reconnues :

| Variable | Effet |
|---|---|
| `PORT` / `HOST` | écoute du serveur (défaut `8787` / `127.0.0.1`) |
| `SIPA_DB` | chemin du fichier SQLite (défaut `data/sipa.db`) |
| `SIPA_DEMO=0` | désactive les comptes et données de démonstration |
| `SIPA_HIDE_OTP=1` | masque le code OTP affiché en mode prototype |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN` | envoi réel via WhatsApp Cloud API (simulé sinon) |
| `SIPA_URL`, `APP_ORIGIN` | origine publique utilisée dans les liens sortants |

## 2. Accès de démonstration

| Profil | Identifiants |
|---|---|
| **Usagère pilote** | `+221 77 123 45 67` · PIN `123456` — `SIPA-4K7Q-SN` |
| **Partenaire (couple)** | `+221 77 654 32 10` · PIN `123456` — `SIPA-9M2T-SN` |
| **Pharmacien** | `pharmacie@sipa.sn` / `SipaDemo2026` (Pharmacie de la Corniche) |
| **Infirmier / biologiste** | `labo@sipa.sn` / `SipaDemo2026` (Poste de santé de la Médina) |
| **Coordinateur ARV** | `coordination@sipa.sn` / `SipaDemo2026` |
| **Conseillère psychosociale** | `conseiller@sipa.sn` / `SipaDemo2026` |

Portail professionnel : `http://localhost:8787/#/pro`.

## 3. Parcours de démonstration (5 minutes)

1. **Connexion usager** — accueil, « J’ai déjà un compte », numéro démo prérempli, PIN.
   Le coffre-fort se déverrouille et un instantané chiffré est déposé hors-ligne.
2. **Coffre-fort** — deux bilans, dont un avec alerte hépatite B ; interprétations
   pédagogiques, fiche audio, attestation de passage sans résultat (imprimable).
3. **Bilan 4-en-1** — motif, centre, créneau, pass `PASS-XXXX` (QR + code court).
4. **Autotest** — carte → pharmacie en stock → réservation (verrou 24 h) → pass TOTP 60 s.
   Côté pharmacien : « Retraits & stock », scanner ou saisir `SIPA-XXXXXXXX-123456`.
5. **Colis ARV** — coordinateur : créer une dotation, expédier ; officine : accuser
   réception ; usager : retrait avec **double validation** (pass + code logistique du pli).
6. **Assistant** — « pharmacies proches », « je suis enceinte » (activation PTME),
   « mon test est positif » (I=I, gratuité, aucune notification au partenaire),
   escalade vers la conseillère puis réponse en direct (SSE).
7. **Couple** — code `RDV-CPL-482` : deux comptes, un créneau, zéro partage de résultats.
8. **Installation PWA** — Réglages → « Installer l’application » sur mobile.

---

## 4. Ce qui a été construit

### 4.1 Identité de marque

Le logo fourni (cœur-feuille bleu profond, point orange, wordmark SIPA) a été
**redessiné en vectoriel** pour être net à toutes les tailles et tenir dans un bundle léger :

| Fichier | Usage |
|---|---|
| `public/brand/logo-mark.svg` | marque seule (barre supérieure, écran de verrouillage) |
| `public/brand/logo-mark-light.svg` | variante blanche pour fonds sombres |
| `public/brand/logo.svg` | lockup vertical (marque + SIPA + baseline) |
| `public/brand/logo-horizontal.svg` | lockup horizontal (partages, e-mails, Open Graph) |
| `public/icons/icon.svg` | favicon + icône d’application (marque blanche sur dégradé bleu) |
| `public/icons/icon-maskable.svg` | icône maskable Android (zone de sécurité respectée) |

Le marqueur de marque est injecté par `logoMark()` dans `public/js/ui.js` : le SVG hérite
de `currentColor`, ce qui permet de l’afficher en bleu sur fond clair, en blanc sur la
barre latérale du portail professionnel, sans dupliquer de fichier.

Le favicon est un SVG (`<link rel="icon" type="image/svg+xml">`) : net sur tous les
navigateurs modernes, sans PNG à générer. Les navigateurs qui ignorent les icônes SVG
affichent l’icône par défaut — c’est le seul compromis, assumé pour éviter d’ajouter
une chaîne de build d’images.

### 4.2 Système de design 2026

Nouvelle feuille `public/css/sipa-2026.css`, chargée **après** `app.css` : elle surcharge
les jetons de couleur et de typographie, puis modernise les composants sans toucher au
balisage des vues (aucune régression fonctionnelle).

- **Palette** alignée sur le logo : `#1d4f7a` (bleu SIPA), `#123a5c` (nuit), `#f2a23a`
  (point orange), sable `#f6f5f1`, encre `#0d2135`.
- **Typographies auto-hébergées** (aucun appel à Google Fonts, donc compatible CSP
  `font-src 'self'` et disponible hors-ligne) :
  - **Manrope** (400–800) pour les titres, le wordmark et les chiffres ;
  - **Inter** (300–800) pour le texte courant.
  Quatre fichiers `woff2` (≈176 Ko au total) avec `unicode-range` latin + latin-ext,
  préchargés dans `index.html`.
- **Animations discrètes mais présentes** : survol des cartes (élévation + ombre),
  reflet sur les boutons, pastilles de navigation avec point orange animé, tuiles
  d’icônes qui pivotent légèrement, apparition en cascade des sections, icônes du dock
  qui se soulèvent, feuille modale qui glisse, toasts en dégradé.
- **Transitions entre pages** : `document.startViewTransition()` quand l’API existe
  (fondu/glissé natif entre deux écrans), avec repli propre sur une animation CSS.
  `render()` est enveloppé dans une garde pour éviter les transitions concurrentes.
- **Écran de démarrage** (`#splash`) qui masque le premier chargement, puis s’efface.
- **Accessibilité** : anneau de focus orange visible au clavier, contrastes AA,
  `prefers-reduced-motion` respecté, et un réglage **« Animations / Réduites »** dans
  les paramètres qui force `[data-motion="reduced"]`.
- **Corrections au passage** : boutons `btn--quiet` qui gardaient la bordure native du
  navigateur, navigation du portail pro cassée sous 860 px (grille au lieu de flex),
  feuille de verrouillage qui héritait du filtre de confidentialité (elle est désormais
  attachée à `body`), pulsation d’opacité supprimée sur l’écran de verrouillage pour
  qu’il soit toujours visible.

### 4.3 Nouvelles fonctionnalités

- **Installation PWA** : capture de `beforeinstallprompt`, bouton dans les réglages et
  instructions pas-à-pas (iOS / Android / ordinateur) quand l’invite native n’existe pas.
- **Copie du pass** : bouton « Copier le code » sur les pass tournants et les pass de
  rendez-vous (presse-papiers, repli avec toast si indisponible).
- **Déverrouillage automatique** à la saisie du 6ᵉ chiffre du PIN.
- **Fermeture des feuilles au clavier** (Échap) en plus du clic sur le voile.
- **Retour en haut de page** à chaque changement d’écran.
- **Réglage de mouvement** (animations réduites) mémorisé localement.
- **Métadonnées sociales** (`og:title`, `og:description`, `og:image`) et `theme-color`
  à jour.

### 4.4 Parcours usager (PWA)

- **Inscription sans identité civile** : téléphone → OTP 6 chiffres → pseudonyme →
  PIN 6 chiffres → biométrie facultative. Identifiant `SIPA-XXXX-SN` généré.
- **Connexion** par téléphone + PIN, blocage progressif (30 s → 15 min) après 5 échecs.
- **Verrouillage automatique** après 60 s d’inactivité ou au passage en arrière-plan,
  voile de confidentialité (flou + message neutre), déverrouillage biométrique WebAuthn.
- **Coffre-fort** : résultats chiffrés AES-256-GCM, interprétations en langage clair,
  valeurs de référence, alerte hépatite B, fiche audio (synthèse vocale `fr-FR`),
  attestation de passage sans aucun résultat.
- **Mode hors-ligne** : instantané du coffre chiffré en IndexedDB avec la clé dérivée du
  PIN, pass TOTP recalculés localement, structures et tuiles mises en cache. Aucune
  donnée de santé dans le cache HTTP ni dans le service worker.
- **Carte** Leaflet/OpenStreetMap, 20 structures (centres 4-en-1, pharmacies, espaces
  d’écoute) autour de Dakar et Thiès, filtres par type, recherche, géolocalisation
  facultative, distance haversine, stocks d’autotests.
- **Bilan 4-en-1** : choix du motif (individuel, prénuptial, CPN), du centre et d’un
  créneau, pass de consultation, gestion et annulation.
- **Autotests** : réservation en officine avec verrou de 24 h, pass tournant TOTP 60 s
  (`SIPA-XXXXXXXX-123456`), rappel neutre à J+2.
- **Colis ARV** : suivi d’étiquette `COLIS-XXXX-SN`, retrait à double validation.
- **Couple** : alignement d’un créneau prénuptial à deux avec code `RDV-CPL-482`,
  cloisonnement total des résultats.
- **Notifications** strictement neutres, assistant conversationnel avec escalade humaine
  et réponses en temps réel, paramètres de sécurité et de données locales.

### 4.5 Canal WhatsApp

Webhook complet (`GET` de vérification + `POST` signé) branché sur la même machine à
états que l’assistant PWA : messages entrants, réponses, escalade, notifications.
L’envoi réel s’active en renseignant `WHATSAPP_TOKEN` et `WHATSAPP_PHONE_ID` ; sans ces
clés, les envois sont journalisés et simulés.

### 4.6 Portail professionnel (RBAC 4 profils)

- **Pharmacien** : scanner (caméra `getUserMedia` + saisie manuelle du code), remise
  d’autotest, retraits ARV à double validation, mise à jour du stock.
- **Infirmier / biologiste** : saisie des 4 paramètres d’un bilan à partir du pass,
  chiffrement côté serveur avec la clé scellée du compte.
- **Coordinateur ARV** : création et expédition de dotations, étiquettes neutres.
- **Conseillère psychosociale** : file d’escalades, réponse en direct, clôture.
- Export CSV des activités, journal d’audit, aucune donnée civile affichée.

---

## 5. Architecture

```text
PWA (vanille + Service Worker + IndexedDB)  ─┐
WhatsApp Cloud webhook (simulé sans clés)   ─┼─► API REST /api/v1 (Node.js, zéro dépendance)
Portail Pro (RBAC 4 profils, scan caméra)   ─┘        │
                                                      ├─ SQLite (node:sqlite) — données pseudonymisées
                                                      ├─ Coffre-fort AES-256-GCM (clé / PIN PBKDF2)
                                                      ├─ TOTP 60 s (RFC 6238) pour les pass
                                                      └─ SSE (temps réel conseiller + notifications)
```

```text
server/
  crypto.js     JWT HS256, PBKDF2-SHA256 (200 000 itérations), AES-256-GCM,
                base32/TOTP RFC 6238, normalisation et hachage du téléphone
  db.js         schéma SQLite (users, facilities, stocks, appointments,
                health_results, vouchers_qr, arv_parcels, escalations,
                notifications, staff, audit_log, settings) + seed
  seed-data.js  18 structures à Dakar et Thiès, 5 comptes professionnels
  service.js    comptes, PIN/DEK, créneaux, vouchers, colis, notifications, rappels
  chat.js       machine à états déterministe (aucun LLM sur les protocoles critiques)
  api.js        49 routes REST + webhook WhatsApp + export CSV
  index.js      serveur HTTP, statique, SSE, en-têtes de sécurité CSP
  demo.js       comptes de démonstration, résultats, rendez-vous couple, pass, colis
public/
  index.html, manifest.webmanifest, sw.js, css/{app,sipa-2026}.css
  js/{app,api,ui,totp,offline,pass}.js, js/views/* (9 vues)
  brand/*.svg, icons/*.svg, fonts/*.woff2, vendor/{leaflet,qrcode}
scripts/
  check.js      contrôle syntaxique de tous les fichiers
  smoke.js      44 assertions de bout en bout sur une base neuve
```

### Modèle de sécurité

- **Pseudonymisation dès l’inscription** : identifiant `SIPA-XXXX-SN`, pseudonyme libre,
  numéro chiffré (`phone_enc`) et haché (`phone_hash`), aucun nom civil.
- **Coffre-fort** : chaque résultat est chiffré en AES-256-GCM avec une clé de données
  (DEK) aléatoire, elle-même enveloppée par une clé dérivée du PIN (PBKDF2-SHA256,
  200 000 itérations). Le PIN n’est jamais stocké. Une copie de la DEK scellée par la clé
  maître serveur (`dek_server`) permet la saisie en officine ; une copie `dek_bio` sert
  au déverrouillage biométrique (écart assumé, voir §7).
- **Pass** : TOTP 60 s HMAC-SHA1, tolérance ±1 pas, usage unique, expiration 24 h
  (autotest) ou 30 j (colis). Le pharmacien ne voit ni nom, ni téléphone, ni statut médical.
- **Cloisonnement couple** : le code `RDV-CPL-XXX` ne sert qu’à aligner un créneau ;
  aucune requête ne permet de lire les résultats d’un autre usager (vérifié par test).
- **Notifications neutres** : aucun libellé ne mentionne VIH, hépatite, résultat ou traitement.
- **En-têtes** : CSP stricte, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` limitant géolocalisation et caméra à l’origine, `nosniff`.
- **Journal d’audit** de toutes les actions sensibles.

---

## 6. Vérifications

```text
node scripts/check.js   → 28 fichiers analysés, 0 erreur
node scripts/smoke.js   → 44/44 assertions (inscription, PIN, coffre, TOTP,
                          réservation, double validation ARV, escalade, CSV,
                          webhook WhatsApp, cloisonnement couple)
```

Contrôles manuels effectués dans un navigateur : accueil, carte (marqueurs + tuiles OSM),
coffre et interprétations, pass QR, parité TOTP client/serveur, chat et fil conseillère,
4 portails professionnels, console sans erreur. Le design a été revu écran par écran
(accueil, verrouillage, réglages, carte, coffre, portail pro, pass, onboarding) en
678 px de large et 1280 px.

---

## 7. Écarts assumés par rapport au cahier des charges

| CCTF | Prototype | Raison |
|---|---|---|
| PostgreSQL 16 + PostGIS, Redis | SQLite (`node:sqlite`) + logique de distance et verrous en service | Prototype exécutable sans installation ; `ST_DWithin` remplacé par haversine, verrou 24 h par ligne de stock |
| NestJS/FastAPI + Socket.io | Node natif + SSE | Zéro dépendance, même sémantique temps réel (serveur → client) |
| WhatsApp Cloud API | Webhook complet + envoi simulé, activé par `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` | Aucune clé Meta dans l’environnement de démonstration |
| OTP SMS/WhatsApp | Code affiché en mode prototype (`SIPA_HIDE_OTP=1` pour le masquer) | Pas de passerelle SMS contractée |
| Pastilles audio wolof | Synthèse vocale française + fiches wolof prévues au pilote | Pas de TTS wolof hors-ligne fiable |
| WebAuthn | Cérémonie réelle `create/get`, assertion non vérifiée cryptographiquement côté serveur ; DEK biométrique scellée par la plateforme | Vérification d’assertion et enclave matérielle relèvent du durcissement |
| Attestation PDF | Génération imprimable (PDF via impression navigateur), sans aucun résultat | Évite une dépendance de rendu PDF |
| Icônes iOS | Favicon SVG + icône maskable SVG | Pas de chaîne de rendu PNG dans un projet sans dépendance ; voir `MISE-EN-PRODUCTION.md` |

---

## 8. Rendre le prototype réellement exploitable

Le guide technique complet — technologies cibles, hébergement, base de données,
gestion des clés, OTP réels, WebAuthn, notifications push, observabilité, conformité
et checklist de mise en production — est dans **[`MISE-EN-PRODUCTION.md`](./MISE-EN-PRODUCTION.md)**.

---

## 9. Feuille de route indicative

1. **Pilote** — une officine et un centre à Dakar, 200 usagers, OTP réel, sauvegardes.
2. **Durcissement** — WebAuthn vérifié, KMS, audit externe, tests d’intrusion.
3. **Passage à l’échelle** — PostgreSQL/PostGIS, Redis, réplication, multi-régions.
4. **Extension** — wolof enregistré, USSD de secours pour les zones sans données,
   intégration DHIS2 pour le reporting agrégé anonyme.
