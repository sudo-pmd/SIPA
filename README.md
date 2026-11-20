# SIPA — Prototype viable

**Système Intégré de Prévention et d’Accès** — coffre-fort sanitaire pseudonymisé,
Bilan Intégré 4-en-1, double circuit officinal (autotests & dotations ARV scellées),
assistant conversationnel PWA/WhatsApp et portail professionnel à 4 profils.

Prototype fonctionnel de bout en bout, exécutable **sans aucune dépendance à installer** :
Node.js ≥ 22.5 (SQLite intégré via `node:sqlite`), PWA vanille, Leaflet et générateur
de QR vendorisés localement.

```bash
npm start          # http://localhost:8787
npm run dev        # rechargement à chaud du serveur
npm run check      # vérification syntaxique de tous les fichiers
npm run smoke      # 44 vérifications de bout en bout contre l'API locale
npm run reset      # efface la base de démonstration (reseed au démarrage)
```

## Accès de démonstration

| Profil | Identifiants |
|---|---|
| **Usagère pilote** | `+221 77 123 45 67` · PIN `123456` — identifiant `SIPA-4K7Q-SN` |
| **Partenaire (couple)** | `+221 77 654 32 10` · PIN `123456` — `SIPA-9M2T-SN` |
| **Pharmacien** | `pharmacie@sipa.sn` / `SipaDemo2026` (Pharmacie de la Corniche) |
| **Infirmier / biologiste** | `labo@sipa.sn` / `SipaDemo2026` (Poste de santé de la Médina) |
| **Coordinateur ARV** | `coordination@sipa.sn` / `SipaDemo2026` |
| **Conseillère psychosociale** | `conseiller@sipa.sn` / `SipaDemo2026` |

Portail professionnel : `http://localhost:8787/#/pro`.

## Parcours de démonstration (5 minutes)

1. **Coffre-fort** — connexion PIN, déverrouillage, deux bilans dont un avec alerte
   hépatite B, fiche audio, attestation de passage sans résultat, instantané hors-ligne chiffré.
2. **Bilan 4-en-1** — motif, centre, créneau, pass `PASS-XXXX` (QR + code court).
3. **Autotest** — carte → pharmacie en stock → réservation (verrou 24 h) → pass TOTP 60 s.
   Côté pharmacien : « Retraits & stock » → scanner ou saisir `SIPA-XXXXXXXX-123456`.
4. **Colis ARV** — coordinateur : créer une dotation (`COLIS-XXXX-SN`), expédier ;
   officine : accuser réception ; patient : retrait avec **double validation**
   (pass + code logistique du pli).
5. **Assistant** — « pharmacies proches », « je suis enceinte » (activation PTME),
   « mon test est positif » (I=I, gratuité ARV, aucune notification au partenaire),
   escalade vers la conseillère puis réponse en direct (SSE).
6. **Couple** — code `RDV-CPL-482` : deux comptes, un créneau, zéro partage de résultats.

## Architecture

```text
PWA (vanille + Service Worker + IndexedDB)  ─┐
WhatsApp Cloud webhook (simulé sans clés)   ─┼─► API REST /api/v1 (Node.js, zéro dépendance)
Portail Pro (RBAC 4 profils, scan caméra)   ─┘        │
                                                      ├─ SQLite (node:sqlite) — données pseudonymisées
                                                      ├─ Coffre-fort AES-256-GCM (clé / PIN PBKDF2)
                                                      ├─ TOTP 60 s (RFC 6238) pour les pass
                                                      └─ SSE (temps réel conseiller + notifications)
```

- `server/crypto.js` — JWT HS256, PBKDF2, AES-256-GCM, base32/TOTP, téléphone.
- `server/db.js` — schéma SQL (users, facilities, stocks, appointments, health_results,
  vouchers_qr, arv_parcels, escalations, notifications, staff, audit_log).
- `server/service.js` — comptes, PIN/DEK, rendez-vous, vouchers, colis, notifications.
- `server/chat.js` — machine à états déterministe (aucun LLM sur les protocoles critiques).
- `server/api.js` — 49 routes REST + webhook WhatsApp + export CSV.
- `public/` — PWA : `js/views/*` (auth, home, map, booking, vault, chat, parcels, account, pro),
  `sw.js`, `offline.js` (coffre hors-ligne chiffré par le PIN).

### Modèle de sécurité

- **Pseudonymisation dès l’inscription** : identifiant `SIPA-XXXX-SN`, pseudonyme libre,
  numéro chiffré (`phone_enc`) et haché (`phone_hash`), aucun nom civil.
- **Coffre-fort** : chaque résultat est chiffré en AES-256-GCM avec une clé de données (DEK)
  aléatoire, elle-même enveloppée par une clé dérivée du PIN (PBKDF2-SHA256, 200 000 itérations).
  Le PIN n’est jamais stocké ; 5 échecs déclenchent un blocage progressif (30 s → 15 min).
- **Pass** : TOTP 60 s, HMAC-SHA1, tolérance ±1 pas ; usage unique ; expiration 24 h (autotest)
  ou 30 j (colis) ; le pharmacien ne voit ni nom, ni téléphone, ni statut médical.
- **Cloisonnement couple** : le code `RDV-CPL-XXX` ne sert qu’à aligner un créneau ; aucune
  requête ne permet de lire les résultats d’un autre usager (vérifié par test).
- **Notifications neutres** : aucun libellé ne mentionne VIH, hépatite, résultat ou traitement.
- **Hors-ligne** : instantané chiffré en IndexedDB (clé PBKDF2 du PIN), pass TOTP recalculés
  dans le navigateur, carte et structures mises en cache ; aucune donnée de santé en cache HTTP.
- En-têtes CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, permissions
  géolocalisation/caméra restreintes à l’origine.

## Écarts assumés par rapport au cahier des charges

| CCTF | Prototype | Raison |
|---|---|---|
| PostgreSQL 16 + PostGIS, Redis | SQLite (`node:sqlite`) + logique de distance/verrous en service | Prototype exécutable sans installation ; requêtes spatiales `ST_DWithin` remplacées par haversine, verrou 24 h par ligne de stock |
| NestJS/FastAPI + Socket.io | Node natif + SSE | Zéro dépendance, même sémantique temps réel (serveur → client) |
| WhatsApp Cloud API | Webhook complet + envoi simulé, activé par `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` | Aucune clé Meta dans l’environnement de démonstration |
| OTP SMS/WhatsApp | Code affiché en mode prototype (`SIPA_HIDE_OTP=1` pour le masquer) | Pas de passerelle SMS contractée |
| Pastilles audio wolof | Synthèse vocale française + fiches wolof prévues au pilote | Pas de voix wolof TTS hors-ligne fiable |
| WebAuthn | Cérémonie réelle `create/get`, assertion non vérifiée cryptographiquement côté serveur ; DEK biométrique scellée par la plateforme | La vérification d’assertion et l’enclave matérielle relèvent du durcissement Sprint 4 |
| Attestation PDF | Génération imprimable (PDF via impression navigateur), sans aucun résultat | Évite une dépendance PDF ; contenu conforme |

## Vérifications

`npm run smoke` couvre 44 points : verrouillage du coffre, refus de PIN erroné, chiffrement
et restitution, filtres cartographiques, réservation, rejeu de pass refusé, code TOTP invalide
refusé, double validation des colis, saisie soignant, isolation des coffres entre partenaires,
protocole post-test (I=I), passerelle PTME, escalade + réponse conseiller, notifications neutres,
export CSV anonymisé, en-têtes de sécurité et webhook WhatsApp.

Les écrans ont été contrôlés dans un navigateur (rendu, carte Leaflet + tuiles OSM, QR,
portail pro) ; aucun test d’accessibilité automatisé ni test sur appareil physique n’a été mené.
