// Assistant conversationnel : machine à états déterministe côté serveur,
// escalade humaine en direct, passerelle maternité.
import { api, state } from '../api.js';
import { icon, esc, toast, modal, fmtDateTime } from '../ui.js';

const CHANNEL_NOTE = 'Ce même fil existe sur WhatsApp au numéro officiel SIPA, avec notes vocales.';

export async function render(root, { params }) {
  const history = await api('/api/v1/chat/history').catch(() => ({ messages: [], escalation: null }));
  const messages = history.messages.map((m) => ({ ...m }));
  let escalation = history.escalation;
  let lastReply = null;

  root.innerHTML = `
    <div class="screen__head">
      <p class="eyebrow">Assistant SIPA · 24 h/24</p>
      <h1>Une question,<br />sans avoir à se justifier.</h1>
      <p class="lede">Recherche de pharmacies, rendez-vous, grossesse, résultat positif, ou simplement parler. En français, avec fiches audio en wolof.</p>
    </div>
    <div class="chips" id="quick-actions">
      <button class="chip" data-send="Quelles pharmacies proches ont des autotests ?">Pharmacie proche</button>
      <button class="chip" data-send="Je veux faire un bilan 4-en-1">Bilan 4-en-1</button>
      <button class="chip" data-send="Mes rendez-vous">Mes rendez-vous</button>
      <button class="chip" data-send="Je suis enceinte">Grossesse</button>
      <button class="chip" data-send="J'ai besoin de parler à un conseiller">Conseiller</button>
    </div>
    <div class="chat" id="chat" aria-live="polite"></div>
    <div id="thread"></div>
    <form class="chat-form" id="chat-form">
      <input class="input" id="chat-input" placeholder="Écrivez votre message…" autocomplete="off" maxlength="900" />
      <button type="submit" aria-label="Envoyer">${icon('chat', 19)}</button>
    </form>
    <p class="tiny muted" style="text-align:center;margin-top:4px">${CHANNEL_NOTE}</p>`;

  const chatNode = root.querySelector('#chat');
  const threadNode = root.querySelector('#thread');
  const form = root.querySelector('#chat-form');
  const input = root.querySelector('#chat-input');

  function bubble(message) {
    const div = document.createElement('div');
    div.className = `bubble bubble--${
      message.author === 'USER' ? 'user' : message.author === 'BOT' ? 'bot' : message.author === 'COUNSELOR' ? 'counselor' : 'system'
    }`;
    div.innerHTML = `${
      message.author === 'COUNSELOR'
        ? `<div class="bubble__meta">Conseillère · ${esc(
            new Date(message.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
          )}</div>`
        : ''
    }${esc(message.body)}`;
    chatNode.appendChild(div);
    chatNode.scrollIntoView({ block: 'end' });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function paintThread() {
    if (!escalation) {
      threadNode.innerHTML = '';
      return;
    }
    threadNode.innerHTML = `
      <section class="section">
        <div class="section__head">
          <h2>Accompagnement humain</h2>
          <span class="pill ${escalation.status === 'OPEN' ? 'pill--warn' : 'pill--ok'}">${
            escalation.status === 'OPEN' ? 'En attente' : escalation.status === 'IN_PROGRESS' ? 'En cours' : 'Clôturé'
          }</span>
        </div>
        <div class="card">
          <p class="eyebrow">${esc(escalation.reasonLabel)}</p>
          <div class="chat" id="thread-messages">
            ${escalation.messages
              .map(
                (m) => `<div class="bubble bubble--${
                  m.author === 'USER' ? 'user' : m.author === 'COUNSELOR' ? 'counselor' : 'system'
                }">${
                  m.author === 'COUNSELOR'
                    ? `<div class="bubble__meta">Conseillère · ${new Date(m.createdAt).toLocaleTimeString('fr-FR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}</div>`
                    : ''
                }${esc(m.body)}</div>`
              )
              .join('')}
          </div>
          ${
            escalation.status !== 'CLOSED'
              ? `<form id="thread-form" style="margin-top:12px;display:flex;gap:8px">
                  <input class="input" id="thread-input" placeholder="Répondre à votre conseillère…" maxlength="1200" />
                  <button class="btn btn--sm" type="submit">Envoyer</button>
                </form>`
              : ''
          }
        </div>
      </section>`;
    threadNode.querySelector('#thread-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const field = threadNode.querySelector('#thread-input');
      const body = field.value.trim();
      if (!body) return;
      field.value = '';
      try {
        await api('/api/v1/chat/escalation/message', { method: 'POST', body: { body } });
      } catch (error) {
        toast(error.message, 'alert');
      }
    });
  }

  function paintOptions(reply) {
    if (!reply) return;
    const holder = document.createElement('div');
    holder.className = 'chat__options';
    holder.innerHTML = (reply.options ?? [])
      .map(
        (option, index) =>
          `<button class="chip" data-option="${index}">${esc(option.label)}</button>`
      )
      .join('');
    chatNode.appendChild(holder);
    holder.querySelectorAll('[data-option]').forEach((node) => {
      node.onclick = () => {
        const option = reply.options[Number(node.dataset.option)];
        if (option.to) {
          location.hash = option.to.replace(/^#/, '');
          return;
        }
        if (option.cta) handleCta(option.cta);
        else if (option.send) send(option.send);
      };
    });
    if (reply.cards?.length) {
      const cards = document.createElement('div');
      cards.className = 'list';
      cards.style.marginTop = '4px';
      cards.innerHTML = reply.cards
        .map(
          (card) => `<a class="list__item" href="${esc(card.href)}">
            <div class="list__icon">${icon(card.kind === 'PHARMACIE' ? 'pin' : 'calendar', 16)}</div>
            <div class="list__body"><strong>${esc(card.name)}</strong><span>${esc(card.meta)}</span></div>
            <span class="tiny muted">${esc(card.badge)}</span>
          </a>`
        )
        .join('');
      chatNode.appendChild(cards);
    }
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  async function handleCta(cta) {
    if (cta === 'DECLINE_SUPPORT') {
      bubble({ author: 'BOT', body: 'C’est noté. Votre espace reste ouvert, et la porte reste ouverte : vous pouvez revenir à tout moment, sans tout réexpliquer.' });
      return;
    }
    if (cta === 'ACTIVATE_MATERNITY') {
      try {
        const { facilities } = await api('/api/v1/facilities?type=CENTRE_4EN1&lat=14.6928&lng=-17.4467&radius=120');
        const centre = facilities[0];
        if (!centre) throw new Error('Aucune maternité partenaire disponible.');
        const { slots } = await api(`/api/v1/facilities/${centre.id}/slots`);
        const first = slots[0];
        if (!first) throw new Error('Aucun créneau prénatal disponible.');
        const data = await api('/api/v1/appointments', {
          method: 'POST',
          body: { facilityId: centre.id, category: 'CPN_MATERNITE', slotAt: first.at },
        });
        bubble({
          author: 'BOT',
          body:
            'Parcours « Maternité Sereine » activé. Votre première consultation prénatale est réservée.\n\n' +
            `${centre.name} — ${new Date(first.at).toLocaleString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}\n` +
            `Pass : ${data.appointment.passCode}\n\n` +
            'Le protocole PTME sera appliqué pour protéger votre enfant. Votre suivi reste strictement confidentiel.',
        });
        modal({
          title: 'Maternité Sereine',
          subtitle: 'Suivi prénatal planifié',
          body: `<p class="small">Première consultation prénatale réservée à ${esc(centre.name)}.</p>
            <div class="banner" style="margin-top:12px">${icon('shield', 16)}<span>Protocole PTME : prévention de la transmission mère-enfant, avec un enfant en bonne santé à la clé.</span></div>`,
          actions: [{ label: 'Voir mon rendez-vous', variant: 'ghost', onClick: ({ close }) => { close(); location.hash = '#/book?manage=1'; } }],
        });
      } catch (error) {
        toast(error.message, 'alert');
      }
      return;
    }
    if (cta.startsWith('ESCALATE_')) {
      const reason = cta.replace('ESCALATE_', '');
      try {
        const data = await api('/api/v1/chat/escalate', { method: 'POST', body: { reason } });
        escalation = data.escalation;
        bubble({
          author: 'SYSTEM',
          body: 'Mise en relation effectuée. Une conseillère psychosociale ou un médiateur pair prend le relais dans cette conversation. Vous pouvez écrire à tout moment.',
        });
        paintThread();
      } catch (error) {
        toast(error.message, 'alert');
      }
    }
  }

  async function send(text) {
    if (!text) return;
    const message = { author: 'USER', body: text, createdAt: new Date().toISOString() };
    bubble(message);
    input.value = '';
    const typing = document.createElement('div');
    typing.className = 'bubble bubble--bot';
    typing.textContent = '…';
    chatNode.appendChild(typing);
    try {
      const coords = state.lastLocation ?? { lat: 14.6928, lng: -17.4467 };
      const data = await api('/api/v1/chat/message', {
        method: 'POST',
        body: { text, lat: coords.lat, lng: coords.lng },
      });
      typing.remove();
      lastReply = data.reply;
      bubble({ author: 'BOT', body: data.reply.text });
      paintOptions(data.reply);
    } catch (error) {
      typing.remove();
      toast(error.message, 'alert');
    }
  }

  // Historique
  if (!messages.length) {
    bubble({
      author: 'BOT',
      body:
        'Bonjour. Je peux chercher une pharmacie avec des autotests, réserver un Bilan 4-en-1, vous accompagner après un résultat, ou organiser votre suivi de grossesse.\n\nRien de ce que vous écrivez ici n’est partagé avec un tiers.',
    });
  } else {
    for (const message of messages) bubble(message);
  }

  paintThread();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value.trim());
  });

  root.querySelectorAll('[data-send]').forEach((node) => {
    node.onclick = () => send(node.dataset.send);
  });

  if (params.get('q')) {
    const map = {
      pharmacie: 'Quelles pharmacies proches ont des autotests ?',
      bilan: 'Je veux faire un bilan 4-en-1',
      grossesse: 'Je suis enceinte',
    };
    setTimeout(() => send(map[params.get('q')] ?? params.get('q')), 250);
  }
  if (params.get('escalate') === '1') setTimeout(() => handleCta('ESCALATE_OTHER'), 250);

  window.addEventListener('sipa:message', async (event) => {
    if (!document.body.contains(chatNode)) return;
    bubble({ author: event.detail.author, body: event.detail.body, createdAt: event.detail.createdAt });
    const fresh = await api('/api/v1/chat/escalation').catch(() => null);
    if (fresh?.escalation) {
      escalation = fresh.escalation;
      paintThread();
    }
  });

  window.addEventListener('sipa:notification', () => {});
}
