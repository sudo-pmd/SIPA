// Assistant conversationnel SIPA — machine à états déterministe.
// Aucun modèle génératif : les protocoles médicaux critiques restent prévisibles,
// testables et traçables (cf. cahier des charges, §2.2).
import { nearbyFacilities, listAppointments, listUserParcels, listVouchers } from './service.js';

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const OPTION = (label, to) => ({ label, to });

function distance(facility) {
  return facility.distanceKm != null ? `${facility.distanceKm} km` : facility.commune;
}

function pharmacyCards(lat, lng) {
  return nearbyFacilities({ lat, lng, type: 'PHARMACIE', radius: 80 })
    .filter((f) => f.stockStatus !== 'INDISPONIBLE')
    .slice(0, 3)
    .map((f) => ({
      id: f.id,
      kind: 'PHARMACIE',
      name: f.name,
      meta: `${distance(f)} · ${f.commune}`,
      badge: f.stockStatus === 'DISPONIBLE' ? 'Autotests en stock' : 'Stock limité',
      href: `#/map?focus=${f.id}`,
    }));
}

function centerCards(lat, lng) {
  return nearbyFacilities({ lat, lng, type: 'CENTRE_4EN1', radius: 80 })
    .slice(0, 3)
    .map((f) => ({
      id: f.id,
      kind: 'CENTRE',
      name: f.name,
      meta: `${distance(f)} · ${f.commune}`,
      badge: 'Bilan 4-en-1',
      href: `#/book?facility=${f.id}`,
    }));
}

function nextAppointment(user) {
  return listAppointments(user).find((a) => a.status === 'BOOKED') ?? null;
}

export function buildReply({ user, text, lat, lng, channel = 'PWA' }) {
  const t = normalize(text);
  const has = (...words) => words.some((w) => t.includes(w));

  // 1. Grossesse / PTME -----------------------------------------------------
  if (has('grossesse', 'enceinte', 'maternite', 'ptme', 'prenatal', 'cpn')) {
    return {
      intent: 'PTME',
      text:
        'Félicitations pour cette nouvelle. Le parcours « Maternité Sereine » vous accompagne : consultations prénatales dans une maternité partenaire et application complète du protocole PTME (prévention de la transmission mère-enfant). Le suivi est gratuit et strictement confidentiel.\n\nSouhaitez-vous activer ce parcours et planifier votre première consultation prénatale ?',
      options: [
        { label: 'Activer Maternité Sereine', cta: 'ACTIVATE_MATERNITY' },
        OPTION('Voir les centres 4-en-1', '#/map?type=CENTRE_4EN1'),
        OPTION('Parler à une conseillère', '#/chat?escalate=1'),
      ],
      cards: centerCards(lat, lng).slice(0, 2),
    };
  }

  // 2. Résultat positif / hépatite / ARV ------------------------------------
  if (
    has(
      'positif',
      'positive',
      'seropositif',
      'serologie positive',
      'hepatite',
      'i=i',
      'i = i',
      'arv',
      'traitement',
      'indetectable',
      'charge virale'
    )
  ) {
    return {
      intent: 'POST_TEST',
      text:
        'Merci de votre confiance — vous n’êtes pas seul(e). Trois choses importantes, sans aucune urgence :\n\n' +
        '• Le traitement antirétroviral est gratuit au Sénégal, dans les structures habilitées.\n' +
        '• I=I : une personne sous traitement efficace avec une charge virale indétectable ne transmet plus le virus.\n' +
        '• Rien ne sera jamais envoyé à votre partenaire. La décision de lui parler vous appartient, à votre rythme.\n\n' +
        'Un conseiller psychosocial ou un médiateur pair peut vous accompagner pour l’annonce, la médiation de couple ou simplement vous écouter. Voulez-vous qu’on vous mette en relation maintenant ?',
      options: [
        { label: 'Parler à un conseiller', cta: 'ESCALATE_REACTIVE_TEST' },
        OPTION('Trouver un point relais ARV', '#/map?type=PHARMACIE&arv=1'),
        OPTION('Comprendre le bilan 4-en-1', '#/book'),
        { label: 'Continuer seul(e) pour l’instant', cta: 'DECLINE_SUPPORT' },
      ],
      cards: [],
    };
  }

  // 3. Pharmacies / autotests ----------------------------------------------
  if (has('pharmacie', 'autotest', 'officine', 'kit', 'proche', 'pres de moi', 'autodepistage')) {
    const cards = pharmacyCards(lat, lng);
    return {
      intent: 'PHARMACY_SEARCH',
      text: cards.length
        ? 'Voici les officines agréées les plus proches avec des autotests disponibles. Vous réservez en un geste, puis vous retirez le kit au comptoir sans prononcer un mot.'
        : 'Je ne trouve pas d’officine avec des autotests à proximité immédiate. Activez votre position ou choisissez une commune sur la carte, je vous oriente.',
      options: [
        OPTION('Ouvrir la carte', '#/map?type=PHARMACIE'),
        OPTION('Réserver un autotest', '#/map?type=PHARMACIE&reserve=1'),
        OPTION('Voir les centres 4-en-1', '#/book'),
      ],
      cards,
    };
  }

  // 4. Bilan 4-en-1 / centre ------------------------------------------------
  if (has('bilan', '4-en-1', '4 en 1', '4en1', 'depistage', 'tension', 'glycemie', 'diabete', 'centre', 'laboratoire')) {
    return {
      intent: 'BILAN_SEARCH',
      text:
        'Le Bilan Intégré 4-en-1 « Xam Sa Yaram » regroupe en une consultation de 20 minutes : tension artérielle, glycémie, antigène HBs (hépatite B) et sérologie VIH. Aucune file d’attente séparée, aucun étiquetage.\n\nVoici les centres les plus proches :',
      options: [
        OPTION('Prendre rendez-vous', '#/book'),
        OPTION('Réserver pour deux (prénuptial)', '#/couple'),
        OPTION('Voir la carte', '#/map?type=CENTRE_4EN1'),
      ],
      cards: centerCards(lat, lng),
    };
  }

  // 5. Rendez-vous ----------------------------------------------------------
  if (has('rendez-vous', 'rdv', 'reporter', 'annuler', 'reserver', 'creneau', 'booking')) {
    const appointment = nextAppointment(user);
    if (appointment) {
      return {
        intent: 'APPOINTMENT',
        text: `Votre prochain rendez-vous : ${appointment.facility?.name} — ${new Date(appointment.slotAt).toLocaleString('fr-FR', {
          weekday: 'long',
          day: '2-digit',
          month: 'long',
          hour: '2-digit',
          minute: '2-digit',
        })}. Pass ${appointment.passCode}.`,
        options: [
          OPTION('Reporter ou annuler', '#/book?manage=1'),
          { label: 'Parler à un conseiller', cta: 'ESCALATE_OTHER' },
          OPTION('Retour à l’accueil', '#/home'),
        ],
        cards: [],
      };
    }
    return {
      intent: 'APPOINTMENT_EMPTY',
      text: 'Vous n’avez aucun rendez-vous à venir. Je peux vous en réserver un en quelques secondes : choisissez la structure, le motif et le créneau.',
      options: [OPTION('Prendre rendez-vous', '#/book'), OPTION('Réserver une officine', '#/map?type=PHARMACIE')],
      cards: centerCards(lat, lng).slice(0, 2),
    };
  }

  // 6. Colis / retrait ------------------------------------------------------
  if (has('colis', 'pli', 'retrait', 'pass', 'qrcode', 'qr code')) {
    const parcels = listUserParcels(user).filter((p) => p.status !== 'DELIVERED');
    const vouchers = listVouchers(user).filter((v) => v.active);
    return {
      intent: 'PICKUP',
      text: vouchers.length
        ? `Vous avez ${vouchers.length} pass actif(s). Ouvrez votre pass : le code tourne toutes les 60 secondes et fonctionne même hors connexion.`
        : parcels.length
          ? `Votre pli ${parcels[0].trackingCode} est en cours d’acheminement vers ${parcels[0].pharmacy?.name}. Vous recevrez une information neutre dès son arrivée.`
          : 'Vous n’avez aucun retrait en attente. Un autotest ou une dotation ARV peut être réservé depuis la carte.',
      options: [OPTION('Mes pass et colis', '#/parcels'), OPTION('Réserver un autotest', '#/map?type=PHARMACIE&reserve=1')],
      cards: [],
    };
  }

  // 7. Escalade conseiller --------------------------------------------------
  if (has('conseiller', 'humain', 'parler a', 'parler à', 'soutien', 'psychologue', 'mediation', 'ecoute')) {
    return {
      intent: 'ESCALATION',
      text:
        'Bien sûr. Un conseiller psychosocial ou un médiateur pair agréé peut prendre le relais, en direct et en toute confidentialité. Rien de ce que vous écrivez ici n’est partagé avec un tiers.',
      options: [
        { label: 'Mettre en relation maintenant', cta: 'ESCALATE_OTHER' },
        OPTION('Trouver un espace d’écoute', '#/map?type=ESPACE_ECOUTE'),
        OPTION('Revenir au menu', '#/chat'),
      ],
      cards: [],
    };
  }

  // 8. Wolof / langue -------------------------------------------------------
  if (has('wolof', 'langue', 'diola', 'pulaar')) {
    return {
      intent: 'LANGUAGE',
      text:
        'Dalal ak jàmm. Les fiches de résultats et les consignes principales sont disponibles en wolof à l’oral (pastille audio) et en français à l’écrit. Les agents d’accueil des structures partenaires parlent wolof.\n\nVous pouvez changer la langue de l’interface dans Réglages.',
      options: [OPTION('Écouter une fiche en wolof', '#/vault'), OPTION('Réglages', '#/settings')],
      cards: [],
    };
  }

  // 9. Urgence / violences --------------------------------------------------
  if (has('urgence', 'danger', 'viol', 'agression', 'suicide')) {
    return {
      intent: 'EMERGENCY',
      text:
        'Votre sécurité passe avant tout. En cas de danger immédiat, contactez le 17 (police) ou le 15 (SAMU). Un espace d’écoute partenaire peut vous recevoir rapidement, gratuitement et de façon confidentielle.',
      options: [
        OPTION('Espaces d’écoute', '#/map?type=ESPACE_ECOUTE'),
        { label: 'Parler à un conseiller', cta: 'ESCALATE_OTHER' },
      ],
      cards: [],
    };
  }

  // 10. Salutation / menu ---------------------------------------------------
  if (has('bonjour', 'salut', 'salam', 'hello', 'bonsoir', 'menu', 'aide')) {
    return {
      intent: 'GREETING',
      text: `Bonjour ${user.pseudonym}. Je peux vous aider à trouver une officine avec des autotests, réserver un Bilan 4-en-1, gérer vos rendez-vous ou vous mettre en relation avec un conseiller. Que souhaitez-vous faire ?`,
      options: [
        OPTION('Pharmacie proche', '#/chat?q=pharmacie'),
        OPTION('Bilan 4-en-1', '#/chat?q=bilan'),
        OPTION('Mes rendez-vous', '#/book?manage=1'),
        OPTION('Parler à un conseiller', '#/chat?escalate=1'),
      ],
      cards: [],
    };
  }

  // Fallback ----------------------------------------------------------------
  return {
    intent: 'FALLBACK',
    text:
      'Je n’ai pas saisi votre demande. Je peux vous aider sur : la recherche d’une pharmacie ou d’un autotest, la réservation d’un Bilan 4-en-1, la gestion de vos rendez-vous, le suivi maternité (PTME) ou la mise en relation avec un conseiller.',
    options: [
      OPTION('Pharmacie / autotest', '#/chat?q=pharmacie'),
      OPTION('Bilan 4-en-1', '#/chat?q=bilan'),
      OPTION('Grossesse / PTME', '#/chat?q=grossesse'),
      { label: 'Conseiller', cta: 'ESCALATE_OTHER' },
    ],
    cards: [],
  };
}

// Rendu texte pour WhatsApp (pas de boutons riches côté Cloud API prototype).
export function whatsappText(reply) {
  const lines = [reply.text];
  if (reply.cards?.length) {
    lines.push('');
    for (const card of reply.cards) lines.push(`• ${card.name} — ${card.meta} (${card.badge})`);
  }
  if (reply.options?.length) {
    lines.push('');
    lines.push('Répondez avec un mot-clé : ' + reply.options.map((o) => o.label).join(' · '));
  }
  lines.push('');
  lines.push('SIPA — votre santé, en toute discrétion.');
  return lines.join('\n');
}
