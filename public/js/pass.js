// Pass numériques : QR tournant (TOTP 60 s) et pass de rendez-vous.
import { modal, renderQR, icon, esc, toast } from './ui.js';
import { totp, secondsLeft } from './totp.js';

export async function showVoucherPass(voucher) {
  const dialog = modal({
    title: voucher.kind === 'ARV_PARCEL' ? 'Retrait de votre pli' : 'Retrait de votre autotest',
    subtitle: voucher.facility?.name ?? 'Officine agréée',
    body: `
      <div class="pass">
        <p class="eyebrow">Pass confidentiel</p>
        <div class="qr-slot" id="pass-qr"></div>
        <p class="pass__code" id="pass-code">SIPA-••••-••••••</p>
        <button class="copy-btn" id="pass-copy">${icon('copy', 13)} Copier le code</button>
        <div class="pass__timer">
          ${icon('shield', 13)}
          <span id="pass-timer">Renouvellement dans 60 s</span>
          <span class="timer-bar"><i id="pass-bar" style="width:100%"></i></span>
        </div>
      </div>
      <p class="small muted" style="margin-top:14px">
        ${
          voucher.kind === 'ARV_PARCEL'
            ? 'Présentez ce pass au comptoir. Le pharmacien vérifie aussi le code logistique apposé sur le pli scellé (double validation).'
            : 'Protocole Zéro Parole : présentez ce pass sans rien dire. Le pharmacien scanne, remet le kit, et c’est terminé.'
        }
      </p>
      ${
        voucher.kind === 'AUTOTEST'
          ? `<div class="banner" style="margin-top:12px">${icon('bell', 16)}<span>Un rappel discret vous sera proposé dans 2 jours pour enregistrer votre résultat, si vous le souhaitez.</span></div>`
          : ''
      }
      <p class="tiny muted" style="margin-top:12px">Valable jusqu’au ${new Date(voucher.expiresAt).toLocaleString('fr-FR')}.</p>`,
    actions: [{ label: 'Fermer', variant: 'ghost' }],
  });

  const qrSlot = dialog.overlay.querySelector('#pass-qr');
  const codeNode = dialog.overlay.querySelector('#pass-code');
  const timerNode = dialog.overlay.querySelector('#pass-timer');
  const barNode = dialog.overlay.querySelector('#pass-bar');
  dialog.overlay.querySelector('#pass-copy')?.addEventListener('click', () => copyPass(codeNode.textContent));

  let lastCode = '';
  const paint = async () => {
    const left = secondsLeft();
    let code = '------';
    try {
      code = voucher.totpSecret ? await totp(voucher.totpSecret) : '------';
    } catch {
      code = '------';
    }
    timerNode.textContent = `Renouvellement dans ${left} s`;
    barNode.style.width = `${(left / 60) * 100}%`;
    // Le QR n'est régénéré qu'au changement de code (toutes les 60 s) :
    // inutile de reconstruire son SVG à chaque battement de la barre.
    const text = `${voucher.codePrefix}-${code}`;
    if (text === lastCode) return;
    lastCode = text;
    codeNode.textContent = text;
    await renderQR(qrSlot, text);
  };

  await paint();
  const interval = setInterval(() => {
    if (!document.body.contains(dialog.overlay)) {
      clearInterval(interval);
      return;
    }
    paint();
  }, 1000);

  const observer = new MutationObserver(() => {
    if (!document.body.contains(dialog.overlay)) {
      clearInterval(interval);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('modal-root'), { childList: true });
}

export async function showAppointmentPass(appointment) {
  const dialog = modal({
    title: 'Votre pass de consultation',
    subtitle: appointment.facility?.name ?? 'Centre Bilan 4-en-1',
    body: `
      <div class="pass">
        <p class="eyebrow">Bilan intégré 4-en-1</p>
        <div class="qr-slot" id="appt-qr"></div>
        <p class="pass__code">${esc(appointment.passCode)}</p>
        <button class="copy-btn" data-copy="${esc(appointment.passCode)}">${icon('copy', 13)} Copier le code</button>
      </div>
      <div class="stack" style="margin-top:14px">
        <div class="row row--between"><span class="muted small">Créneau</span><strong class="small">${new Date(
          appointment.slotAt
        ).toLocaleString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}</strong></div>
        <div class="row row--between"><span class="muted small">Adresse</span><strong class="small">${esc(
          appointment.facility?.address ?? ''
        )}</strong></div>
        <div class="row row--between"><span class="muted small">Motif</span><strong class="small">${
          appointment.category === 'PRENUPTIAL' ? 'Bilan prénuptial' : appointment.category === 'CPN_MATERNITE' ? 'Consultation prénatale' : 'Bilan individuel'
        }</strong></div>
      </div>
      <p class="small muted" style="margin-top:14px">Présentez ce pass à l’accueil : le soignant le scanne et saisit vos 4 paramètres en une seule consultation de 20 minutes. Aucune mention médicale n’apparaît sur le pass.</p>`,
    actions: [{ label: 'Fermer', variant: 'ghost' }],
  });
  dialog.overlay.querySelector('[data-copy]')?.addEventListener('click', (event) =>
    copyPass(event.currentTarget.dataset.copy)
  );
  await renderQR(dialog.overlay.querySelector('#appt-qr'), appointment.passCode, { size: 180 });
}

export function copyPass(code) {
  if (!navigator.clipboard) return toast('Copie indisponible sur cet appareil.');
  navigator.clipboard.writeText(code).then(
    () => toast('Code copié', 'ok'),
    () => toast('Copie impossible')
  );
}
