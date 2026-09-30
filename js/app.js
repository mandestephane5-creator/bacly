/* Bacly Admin : déposer des sujets de partout.
 * Les fichiers vont dans le casier privé « depot » de Supabase + une ligne dans la table « depots ».
 * Le serveur BacFlow du PC les récupère, les classe (OCR, annales ≥ 10 pages) et les publie dans l'app Bacly.
 */
'use strict';
const CFG = window.BACLY;
const $ = (s, r = document) => r.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, taille = 20, style = '') => `<span class="io" aria-hidden="true" style="font-size:${taille}px;${style}">&#${window.ICONES[n] ?? 63};</span>`;
const lire = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const ecrire = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
const mo = (o) => (o >= 1048576 ? (o / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(o / 1024)) + ' Ko');
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

const MATIERES_DEFAUT = ['Mathématiques', 'Physique-Chimie', 'SVT', 'Français', 'Philosophie', 'Anglais', 'Histoire-Géo'];
const TYPES_DEFAUT = ['Exercices', 'Devoirs', 'Annales', 'Textes', 'Dissertation', 'Commentaire', 'Résumé', 'Schémas', 'Cartes', 'Essay', 'Autres'];

const E = {
  session: lire('ba-session'), onglet: 'deposer', sousVue: null, theme: lire('ba-theme', 'auto'),
  pc: null, depots: [], demandes: null, demandesErreur: null, envois: [], filtre: 'tous',
  choix: { matiere: null, type: null, annee: '' }, photos: [], ameliorer: lire('ba-ameliorer', true),
  recus: [], pourDemande: null, installer: null, erreur: '', chargement: false,
};

// ================= Supabase (sans bibliothèque) =================
class ErreurApi extends Error { constructor(m, statut) { super(m); this.statut = statut; } }
async function appel(chemin, { methode = 'GET', corps, entetes = {}, auth = true } = {}) {
  const h = { apikey: CFG.cle, ...entetes };
  if (auth) h.Authorization = `Bearer ${await jeton()}`;
  if (corps !== undefined && !(corps instanceof Blob)) { h['Content-Type'] = 'application/json'; corps = JSON.stringify(corps); }
  let r;
  try { r = await fetch(CFG.url + chemin, { method: methode, headers: h, body: corps }); }
  catch { throw new ErreurApi('Pas de connexion Internet.', 0); }
  const texte = await r.text();
  let j = null; try { j = texte ? JSON.parse(texte) : null; } catch { /* pas du JSON */ }
  if (!r.ok) {
    const msg = j?.msg || j?.message || j?.error_description || j?.error || texte || `Erreur ${r.status}`;
    if (r.status === 401 && auth) { deconnecter('Session expirée : reconnecte-toi.'); }
    throw new ErreurApi(String(msg).slice(0, 200), r.status);
  }
  return j;
}
async function seConnecter(email, mdp) {
  const j = await appel('/auth/v1/token?grant_type=password', { methode: 'POST', corps: { email, password: mdp }, auth: false })
    .catch((e) => { throw new ErreurApi(e.statut === 400 ? 'E-mail ou mot de passe incorrect.' : e.message, e.statut); });
  garderSession(j);
}
function garderSession(j) {
  E.session = { acces: j.access_token, rafraichir: j.refresh_token, expire: Date.now() + (j.expires_in ?? 3600) * 1000, email: j.user?.email ?? E.session?.email };
  ecrire('ba-session', E.session);
}
let rafraichissement = null;
async function jeton() {
  if (!E.session) throw new ErreurApi('Non connecté', 401);
  if (Date.now() < E.session.expire - 60_000) return E.session.acces;
  rafraichissement ??= appel('/auth/v1/token?grant_type=refresh_token', { methode: 'POST', corps: { refresh_token: E.session.rafraichir }, auth: false })
    .then(garderSession).catch((e) => { if (e.statut) deconnecter('Session expirée : reconnecte-toi.'); throw e; })
    .finally(() => { rafraichissement = null; });
  await rafraichissement;
  return E.session.acces;
}
function deconnecter(message = '') {
  const s = E.session; E.session = null; ecrire('ba-session', null);
  if (s) fetch(CFG.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: CFG.cle, Authorization: `Bearer ${s.acces}` } }).catch(() => {});
  E.erreur = message; E.depots = []; E.demandes = null; afficher();
}
const rest = (chemin, o) => appel('/rest/v1/' + chemin, o);
const cheminObjet = (p) => `/storage/v1/object/${CFG.casier}/${p.split('/').map(encodeURIComponent).join('/')}`;

/** Envoi d'un fichier avec progression (XHR), délai adapté à la taille, 3 essais en cas de coupure */
async function envoyerFichier(chemin, blob, type, surProgres) {
  for (let essai = 1; ; essai++) {
    try {
      const t = await jeton();
      await new Promise((ok, ko) => {
        const x = new XMLHttpRequest();
        x.open('POST', CFG.url + cheminObjet(chemin));
        x.setRequestHeader('apikey', CFG.cle); x.setRequestHeader('Authorization', `Bearer ${t}`);
        x.setRequestHeader('Content-Type', type); x.setRequestHeader('x-upsert', 'false'); x.setRequestHeader('cache-control', 'no-cache');
        x.timeout = Math.min(45 * 60_000, Math.max(120_000, 60_000 + Math.ceil(blob.size / 10_240) * 1000));
        x.upload.onprogress = (e) => e.lengthComputable && surProgres?.(e.loaded / e.total);
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) return ok();
          let m = x.responseText; try { const j = JSON.parse(m); m = j.message || j.error || m; } catch { /* texte */ }
          const e = new ErreurApi(/row-level|unauthori|policy/i.test(m) ? "Ce compte n'a pas le droit de déposer (vérifie la table « admins »)." : /bucket not found/i.test(m) ? 'Le casier « depot » n\'existe pas : lance le script SQL d\'installation.' : String(m).slice(0, 160), x.status);
          e.definitif = x.status >= 400 && x.status < 500; ko(e);
        };
        x.onerror = () => ko(new ErreurApi('Connexion coupée.', 0));
        x.ontimeout = () => ko(new ErreurApi('Connexion trop lente.', 0));
        x.send(blob);
      });
      return;
    } catch (e) {
      if (e.definitif || essai >= 3) throw e;
      surProgres?.(0); await pause(essai * 8000);
    }
  }
}

// ================= Données =================
async function chargerPC() {
  try { const r = await rest('etat_pc?id=eq.1&select=*'); E.pc = r?.[0] ?? { vu: null }; }
  catch (e) { E.pc = { vu: null, erreur: e.statut === 404 || /does not exist|schema cache/i.test(e.message) ? 'installation' : e.message }; }
}
const pcEnLigne = () => !!E.pc?.vu && Date.now() - new Date(E.pc.vu).getTime() < 100_000;
async function chargerDepots() {
  try { E.depots = await rest('depots?select=*&order=cree.desc&limit=150') ?? []; }
  catch (e) { if (e.statut !== 401) toast(e.message); }
}
async function chargerDemandes() {
  try { E.demandes = await rest('demandes?select=*&order=cree.desc&limit=200') ?? []; E.demandesErreur = null; }
  catch (e) { E.demandes = []; E.demandesErreur = /does not exist|schema cache|permission/i.test(e.message) || e.statut === 404 ? 'installation' : e.message; }
}
const matieresPC = () => (Array.isArray(E.pc?.matieres) && E.pc.matieres.length ? E.pc.matieres : MATIERES_DEFAUT);
function typesPour(m) {
  const t = E.pc?.types && m ? Object.entries(E.pc.types).find(([k]) => k.toLowerCase() === m.toLowerCase())?.[1] : null;
  return [...new Set([...(Array.isArray(t) && t.length ? t : TYPES_DEFAUT), 'Annales'])];
}

// ================= Dépôt =================
const sansAccents = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
const nomSur = (n) => sansAccents(n).replace(/[^\w.\- ()]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'sujet.pdf';
const typeDe = (f) => f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg');

async function deposer(fichiers, source = 'fichier') {
  const choix = { ...E.choix };
  for (const f of fichiers) {
    const type = typeDe(f);
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(type)) { toast(`${f.name} : seuls les PDF, JPG et PNG sont acceptés.`); continue; }
    if (f.size > CFG.tailleMax) { toast(`${f.name} : trop gros (${mo(f.size)}, 50 Mo max). Découpe-le ou compresse-le.`); continue; }
    const envoi = { id: crypto.randomUUID(), nom: f.name || 'sujet.pdf', taille: f.size, progres: 0, statut: 'envoi', source, fichier: f, choix };
    E.envois.unshift(envoi);
    lancerEnvoi(envoi);
  }
  E.pourDemande = null;
  if (E.onglet !== 'depots') { E.onglet = 'depots'; E.sousVue = null; }
  afficher();
}
async function lancerEnvoi(envoi) {
  envoi.statut = 'envoi'; envoi.erreur = null;
  const d = new Date();
  const chemin = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}/${envoi.id}/${nomSur(envoi.nom)}`;
  let dernier = 0;
  try {
    await envoyerFichier(chemin, envoi.fichier, typeDe(envoi.fichier), (p) => {
      envoi.progres = p;
      if (Date.now() - dernier > 400) { dernier = Date.now(); majEnvoi(envoi); }
    });
    const { matiere, type, annee } = envoi.choix;
    await rest('depots', { methode: 'POST', entetes: { Prefer: 'return=minimal' }, corps: {
      id: envoi.id, nom: envoi.nom.slice(0, 200), fichier: chemin, taille: envoi.taille, source: envoi.source,
      matiere: matiere || null, type: matiere && type ? type : null, annee: /^\d{4}$/.test(annee) ? annee : null,
    } }).catch(async (e) => { await appel(cheminObjet(chemin), { methode: 'DELETE' }).catch(() => {}); throw e; });
    E.envois = E.envois.filter((x) => x !== envoi);
    await chargerDepots();
    toast(`${envoi.nom} envoyé ✓`);
  } catch (e) {
    envoi.statut = 'erreur'; envoi.erreur = e.message;
  }
  afficher();
}
function majEnvoi(envoi) {
  const el = document.querySelector(`[data-envoi="${envoi.id}"]`);
  if (!el) return;
  const i = el.querySelector('.bar i'); if (i) i.style.width = Math.round(envoi.progres * 100) + '%';
  const t = el.querySelector('.pct'); if (t) t.textContent = Math.round(envoi.progres * 100) + ' %';
}

// ================= Photos → PDF =================
function chargerImage(fichier) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(fichier); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('Image illisible')); };
    img.src = url;
  });
}
/** Redimensionne (2000 px max), tourne, et améliore le contraste d'une photo de feuille */
async function preparerPage(page) {
  const img = page.img; const max = 2000;
  const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * r), h = Math.round(img.naturalHeight * r);
  const tourne = page.rot % 180 !== 0;
  const c = document.createElement('canvas'); c.width = tourne ? h : w; c.height = tourne ? w : h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2); g.rotate((page.rot * Math.PI) / 180); g.drawImage(img, -w / 2, -h / 2, w, h);
  if (E.ameliorer) {
    const d = g.getImageData(0, 0, c.width, c.height), p = d.data, hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) { const y = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0; p[i] = y; hist[y]++; }
    const n = p.length / 4; let bas = 0, haut = 255, s = 0;
    for (let v = 0; v < 256; v++) { s += hist[v]; if (s > n * 0.02) { bas = v; break; } }
    s = 0; for (let v = 255; v >= 0; v--) { s += hist[v]; if (s > n * 0.10) { haut = v; break; } } // le papier devient blanc
    const eche = 255 / Math.max(20, haut - bas);
    for (let i = 0; i < p.length; i += 4) { let y = (p[i] - bas) * eche; y = y < 0 ? 0 : y > 255 ? 255 : y; y = 255 * Math.pow(y / 255, 1.25); p[i] = p[i + 1] = p[i + 2] = y; }
    g.putImageData(d, 0, 0);
  }
  return { canvas: c, blob: await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.82)) };
}
async function ajouterPhotos(fichiers) {
  for (const f of fichiers) {
    try { const img = await chargerImage(f); E.photos.push({ id: crypto.randomUUID(), img, rot: 0, apercu: null }); }
    catch { toast(`${f.name} : image illisible.`); }
  }
  await apercus(); afficher();
}
async function apercus() {
  for (const p of E.photos) if (!p.apercu || p.apercuRot !== p.rot || p.apercuAm !== E.ameliorer) {
    const { canvas } = await preparerPage({ ...p, img: p.img });
    const t = document.createElement('canvas'); const r = 420 / Math.max(canvas.width, canvas.height);
    t.width = canvas.width * r; t.height = canvas.height * r; t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    p.apercu = t.toDataURL('image/jpeg', 0.7); p.apercuRot = p.rot; p.apercuAm = E.ameliorer;
  }
}
async function creerPdf() {
  if (!E.photos.length || !window.PDFLib) return;
  E.chargement = true; afficher();
  try {
    const doc = await PDFLib.PDFDocument.create();
    for (const p of E.photos) {
      const { blob } = await preparerPage(p);
      const jpg = await doc.embedJpg(await blob.arrayBuffer());
      const largeur = 595.28, hauteur = (largeur * jpg.height) / jpg.width; // largeur A4
      doc.addPage([largeur, hauteur]).drawImage(jpg, { x: 0, y: 0, width: largeur, height: hauteur });
    }
    const octets = await doc.save();
    const d = new Date();
    const nom = `${E.choix.matiere ? E.choix.matiere + ' - ' : ''}Photos ${d.toLocaleDateString('fr-FR').replace(/\//g, '-')} ${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}.pdf`;
    const fichier = new File([octets], nom, { type: 'application/pdf' });
    E.photos = []; E.sousVue = null; E.chargement = false;
    await deposer([fichier], 'photos');
  } catch (e) { E.chargement = false; toast('PDF impossible : ' + e.message); afficher(); }
}

// ================= Fichiers partagés vers l'app =================
async function recupererPartages() {
  if (!('caches' in window)) return;
  const cache = await caches.open('bacly-admin-partage');
  const cles = await cache.keys();
  for (const k of cles) {
    const r = await cache.match(k);
    const blob = await r.blob();
    E.recus.push(new File([blob], decodeURIComponent(r.headers.get('X-Nom') || 'sujet.pdf'), { type: r.headers.get('Content-Type') || blob.type }));
    await cache.delete(k);
  }
  if (E.recus.length) { E.onglet = 'deposer'; history.replaceState(null, '', location.pathname); }
}

// ================= Affichage =================
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast.m); toast.m = setTimeout(() => { el.hidden = true; }, 3600);
}
function appliquerTheme() {
  const sombre = E.theme === 'sombre' || (E.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = sombre ? 'sombre' : 'clair';
  document.querySelector('meta[name="theme-color"]').content = sombre ? '#061417' : '#F2F8F7';
  dessinerFormes(sombre);
}
/** Formes géométriques grises dispersées au hasard (comme dans l'app de gestion) */
function dessinerFormes(sombre) {
  const w = innerWidth, h = innerHeight, svg = $('#fond');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  let graine = 7; const rnd = () => ((graine = (graine * 16807) % 2147483647) / 2147483647);
  const c = sombre ? '#FFFFFF' : '#55716D', [o1, o2] = sombre ? [0.05, 0.11] : [0.10, 0.22];
  const n = Math.round((w * h) / 20000) + 6;
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = rnd() * (w + 40) - 40, y = rnd() * (h + 40) - 40, t = 26 + rnd() * 150, o = o1 + rnd() * (o2 - o1), rot = rnd() * 360;
    const plein = rnd() < 0.3, k = Math.floor(rnd() * 7);
    const st = plein ? `fill="${c}" fill-opacity="${(o * 0.5).toFixed(3)}"` : `fill="none" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="${[1.2, 1.6, 2][Math.floor(rnd() * 3)]}"`;
    const tr = `transform="rotate(${rot.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"`;
    if (k === 0) s += `<circle cx="${x}" cy="${y}" r="${t / 2}" ${st}/>`;
    else if (k === 1) s += `<circle cx="${x}" cy="${y}" r="${t / 2}" fill="none" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="${(t / 8).toFixed(0)}"/>`;
    else if (k === 2) s += `<rect x="${x - t / 2}" y="${y - t / 2}" width="${t}" height="${t}" rx="${[0, 8, 16][Math.floor(rnd() * 3)]}" ${st} ${tr}/>`;
    else if (k === 3) s += `<rect x="${x - t / 3}" y="${y - t / 3}" width="${t / 1.5}" height="${t / 1.5}" ${st} transform="rotate(45 ${x} ${y})"/>`;
    else if (k === 4 || k === 5) {
      const m = k === 4 ? 3 : 6;
      s += `<polygon points="${Array.from({ length: m }, (_, j) => `${(x + (t / 2) * Math.cos(((rot + (j * 360) / m) * Math.PI) / 180)).toFixed(0)},${(y + (t / 2) * Math.sin(((rot + (j * 360) / m) * Math.PI) / 180)).toFixed(0)}`).join(' ')}" ${st}/>`;
    } else s += `<path d="M${x - t / 4} ${y}H${x + t / 4}M${x} ${y - t / 4}V${y + t / 4}" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="2.5" stroke-linecap="round" ${tr}/>`;
  }
  svg.innerHTML = s;
}
const entete = (titre, sous) => `<div class="entete"><div><div class="small">${sous}</div><h1 class="h1">${titre}</h1></div><div class="avatar" title="${esc(E.session?.email)}">${esc((E.session?.email || 'A')[0].toUpperCase())}</div></div>`;

function vueConnexion() {
  return `<section class="connexion" style="display:flex;flex-direction:column">
  <div class="logo"><img src="icons/logo-320.png" alt="Logo Bacly"></div>
  <div style="text-align:center"><div class="nom">Bac<em>ly</em><small>ADMIN</small></div>
  <p class="mut" style="margin-top:10px">Dépose des sujets de partout.<br>Le PC s'occupe du reste.</p></div>
  <form id="fConnexion" style="display:flex;flex-direction:column;gap:10px;margin-top:8px" novalidate>
    <label class="champ">${ic('mail-outline', 20, 'color:var(--muted)')}<input type="email" name="email" placeholder="Ton e-mail" autocomplete="username" required value="${esc(E.emailSaisi ?? lire('ba-email', ''))}"></label>
    <label class="champ">${ic('lock-closed-outline', 20, 'color:var(--muted)')}<input type="password" name="mdp" placeholder="Mot de passe" autocomplete="current-password" required><button type="button" data-a="voirMdp" aria-label="Afficher le mot de passe">${ic('eye-outline', 20, 'color:var(--muted)')}</button></label>
    ${E.erreur ? `<div class="erreur">${esc(E.erreur)}</div>` : ''}
    <button class="btn p plein" type="submit" ${E.chargement ? 'disabled' : ''}>${E.chargement ? '<span class="chargement"></span>' : ic('log-in-outline')} Se connecter</button>
  </form>
  <div class="small" style="text-align:center">${ic('shield-checkmark-outline', 13)} Accès réservé à l'administratrice</div>
  ${carteInstaller()}</section>`;
}
function carteInstaller() {
  const ios = /iphone|ipad/i.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches;
  if (!E.installer && !ios) return '';
  return `<div class="card row" style="gap:12px;padding:12px 14px"><div class="logo" style="width:42px;height:42px;border-radius:12px;margin:0">${'<img src="icons/icon-192.png" alt="">'}</div>
  <div style="flex:1"><div class="b" style="font-size:14px">Installer Bacly Admin</div><div class="small">${E.installer ? "Sur l'écran d'accueil, comme une app" : 'Safari : Partager ⎋ puis « Sur l\'écran d\'accueil »'}</div></div>
  ${E.installer ? '<button class="puce on" data-a="installer">Installer</button>' : ''}</div>`;
}
function cartePC() {
  if (E.pc?.erreur === 'installation') return `<div class="card" style="border-color:var(--warning);background:var(--warningSoft)"><div class="b">${ic('construct-outline', 18)} Installation à terminer</div><div class="small" style="color:var(--text);margin-top:6px">Lance le script <b>supabase-installation.sql</b> dans Supabase (SQL Editor), puis recharge la page.</div></div>`;
  if (pcEnLigne()) return `<div class="card row" style="gap:12px;padding:12px 14px">${ic('desktop-outline', 20, 'color:var(--primary)')}<div style="flex:1"><div class="b" style="font-size:14px">PC en ligne</div><div class="small">Classement et OCR actifs · vu ${ilYa(E.pc.vu)}</div></div><span class="pastille" style="background:var(--success);box-shadow:0 0 0 4px var(--successSoft)"></span></div>`;
  return `<div class="card row" style="gap:12px;padding:12px 14px;border-color:var(--warning);background:var(--warningSoft)">${ic('moon-outline', 20, 'color:var(--warning)')}<div style="flex:1"><div class="b" style="font-size:14px">PC éteint</div><div class="small">Tes dépôts attendront son prochain démarrage${E.pc?.vu ? ' · vu ' + ilYa(E.pc.vu) : ''}</div></div></div>`;
}
function ilYa(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 90) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  const dt = new Date(d), hier = new Date(Date.now() - 86400000);
  const h = dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (dt.toDateString() === new Date().toDateString()) return `aujourd'hui à ${h}`;
  if (dt.toDateString() === hier.toDateString()) return `hier à ${h}`;
  return `le ${dt.toLocaleDateString('fr-FR')} à ${h}`;
}
function blocClassement(c, prefixe = 'c') {
  const types = typesPour(c.matiere);
  return `<div class="over" style="margin-top:4px">Classement <span>(facultatif, sinon le PC devine)</span></div>
  <div><div class="small" style="margin-bottom:8px">Matière</div><div class="puces">${['Automatique', ...matieresPC()].map((m) => `<button class="puce ${(m === 'Automatique' ? !c.matiere : c.matiere === m) ? 'on' : ''}" data-a="${prefixe}Matiere" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>
  <div><div class="small" style="margin-bottom:8px">Type${c.matiere ? '' : ' <span>(choisis d\'abord une matière)</span>'}</div><div class="puces">${['Automatique', ...types].map((t) => `<button class="puce ${(t === 'Automatique' ? !c.type : c.type === t) ? 'on' : ''}" data-a="${prefixe}Type" data-v="${esc(t)}" ${c.matiere ? '' : 'disabled'}>${esc(t)}</button>`).join('')}</div></div>
  <div class="row" style="gap:10px"><label class="champ" style="flex:1;min-height:46px">${ic('calendar-outline', 18, 'color:var(--muted)')}<input inputmode="numeric" maxlength="4" placeholder="Année" data-champ="${prefixe}Annee" value="${esc(c.annee ?? '')}"></label>
  <div class="small" style="flex:1.4">${ic('information-circle-outline', 14)} Annales : au moins 10 pages</div></div>`;
}
function vueDeposer() {
  const recus = E.recus.length ? `<div class="card" style="border-color:var(--primary)"><div class="row" style="gap:10px">${ic('share-outline', 20, 'color:var(--primary)')}<div style="flex:1"><div class="b">${E.recus.length} fichier${E.recus.length > 1 ? 's' : ''} reçu${E.recus.length > 1 ? 's' : ''}</div><div class="small">${esc(E.recus.map((f) => f.name).join(', ')).slice(0, 160)}</div></div></div>
    <div class="row" style="gap:10px;margin-top:12px"><button class="btn p" style="flex:1;min-height:44px" data-a="envoyerRecus">${ic('cloud-upload-outline', 18)} Envoyer</button><button class="btn" style="min-height:44px" data-a="oublierRecus">Annuler</button></div></div>` : '';
  const dem = E.pourDemande ? `<div class="card row" style="gap:10px;padding:12px 14px">${ic('chatbubbles-outline', 18, 'color:var(--accent)')}<div class="small" style="flex:1;color:var(--text)">Pour la demande : « ${esc(E.pourDemande.message)} »</div><button data-a="oublierDemande" aria-label="Retirer">${ic('close', 18, 'color:var(--muted)')}</button></div>` : '';
  return `${entete('Déposer', 'Bonjour')}${cartePC()}${recus}${dem}
  <div class="card depot-zone" id="zone">
    <div class="rond">${ic('cloud-upload-outline', 28, 'color:var(--primary)')}</div>
    <div class="serif" style="font-size:24px;margin-top:10px">Ajoute tes sujets</div><div class="small" style="margin-top:4px">PDF, JPG ou PNG · 50 Mo max par fichier</div>
    <div class="row" style="gap:10px;margin-top:16px"><button class="btn p" style="flex:1;min-height:46px;font-size:14px" data-a="choisir">${ic('document-text-outline', 18)} Choisir des PDF</button><button class="btn" style="flex:1;min-height:46px;font-size:14px" data-a="photographier">${ic('camera-outline', 18)} Photographier</button></div>
  </div>${blocClassement(E.choix)}`;
}
function vuePhotos() {
  const n = E.photos.length;
  return `<div class="row" style="gap:12px"><button class="retour" data-a="fermerPhotos" aria-label="Retour">${ic('chevron-back')}</button><h1 class="h1" style="font-size:30px">Photos de l'épreuve</h1></div>
  <div class="small">Page par page, dans l'ordre. Tiens le téléphone bien au-dessus de la feuille, avec de la lumière.</div>
  <div class="pages">${E.photos.map((p, i) => `<div class="page"><img src="${p.apercu}" alt="Page ${i + 1}"><span class="num">${i + 1}</span>
    <div class="outils"><button data-a="pGauche" data-i="${i}" aria-label="Avancer" ${i ? '' : 'disabled style="opacity:.3"'}>${ic('chevron-back', 16)}</button><button data-a="pTourner" data-i="${i}" aria-label="Tourner">${ic('reload-outline', 16)}</button><button data-a="pSupprimer" data-i="${i}" aria-label="Supprimer">${ic('trash-outline', 16)}</button><button data-a="pDroite" data-i="${i}" aria-label="Reculer" ${i < n - 1 ? '' : 'disabled style="opacity:.3"'}>${ic('chevron-forward', 16)}</button></div></div>`).join('')}
    <button class="ajout-page" data-a="photo">${ic('camera-outline', 30, 'color:var(--primary)')}<span class="b" style="font-size:14px">${n ? 'Ajouter une page' : 'Prendre la 1re page'}</span><span class="small" data-a="galerie" style="text-decoration:underline">ou depuis la galerie</span></button></div>
  <button class="card row" style="gap:10px;padding:12px 14px;text-align:left" data-a="ameliorer">${ic('sparkles-outline', 18, 'color:var(--accent)')}<span style="flex:1;font-size:14px">Contraste amélioré (noir et blanc)</span><span class="pill" style="background:${E.ameliorer ? 'var(--primarySoft);color:var(--accent)' : 'var(--surface);color:var(--muted)'}">${E.ameliorer ? 'Oui' : 'Non'}</span></button>
  <button class="btn p plein" data-a="creerPdf" ${n && !E.chargement ? '' : 'disabled'}>${E.chargement ? '<span class="chargement"></span> Création…' : `${ic('document-attach-outline')} Créer le PDF · ${n} page${n > 1 ? 's' : ''}`}</button>
  ${blocClassement(E.choix)}`;
}
const STATUTS = {
  envoye: ['Envoyé', 'var(--primarySoft)', 'var(--accent)', () => (pcEnLigne() ? 'Le PC va le récupérer…' : 'En attente du PC')],
  au_pc: ['Au PC', 'var(--primarySoft)', 'var(--accent)', (d) => d.message || 'Le PC lit le sujet…'],
  a_classer: ['Au PC', 'var(--primarySoft)', 'var(--accent)', () => 'Classement demandé…'],
  a_verifier: ['À vérifier', 'var(--warningSoft)', 'var(--warning)', (d) => d.message || 'Matière non reconnue'],
  publie: ['Publié', 'var(--successSoft)', 'var(--success)', () => "Visible dans l'app"],
  erreur: ['Erreur', 'var(--dangerSoft)', 'var(--danger)', (d) => d.message || 'Problème au PC'],
  a_supprimer: ['Suppression', 'var(--surface)', 'var(--muted)', () => 'Le PC le met à la corbeille…'],
};
function infoDepot(d) {
  const r = d.resultat || {};
  if (d.statut === 'publie' && r.matiere) return [r.matiere, r.type, r.annee].filter(Boolean).join(' · ') + (r.pages ? ` · ${r.pages} p.` : '');
  return [r.pages ? `${r.pages} pages` : null, mo(d.taille), d.matiere ? [d.matiere, d.type].filter(Boolean).join(' · ') : null].filter(Boolean).join(' · ');
}
function vueDepots() {
  const auj = new Date().toDateString();
  const duJour = E.depots.filter((d) => new Date(d.cree).toDateString() === auj);
  const filtres = { tous: () => true, cours: (d) => ['envoye', 'au_pc', 'a_classer', 'a_supprimer'].includes(d.statut), verif: (d) => ['a_verifier', 'erreur'].includes(d.statut), publie: (d) => d.statut === 'publie' };
  const nbVerif = E.depots.filter(filtres.verif).length;
  const liste = E.depots.filter(filtres[E.filtre]);
  const envois = E.filtre === 'tous' || E.filtre === 'cours' ? E.envois : E.envois.filter((x) => E.filtre === 'verif' && x.statut === 'erreur');
  const carteEnvoi = (x) => `<div class="card" data-envoi="${x.id}"><div class="row" style="gap:12px"><div class="vignette">${ic(x.source === 'photos' ? 'camera-outline' : 'document-text-outline')}</div><div style="flex:1;min-width:0"><div class="ligne-titre">${esc(x.nom)}</div><div class="small">${mo(x.taille)}</div></div></div>
    ${x.statut === 'erreur' ? `<div class="row" style="gap:8px;margin-top:10px"><span class="pill" style="background:var(--dangerSoft);color:var(--danger)">Non envoyé</span><span class="small" style="color:var(--text)">${esc(x.erreur)}</span></div><div class="row" style="gap:8px;margin-top:10px"><button class="puce on" data-a="reessayer" data-id="${x.id}">${ic('refresh-outline', 13)} Réessayer</button><button class="puce" data-a="abandonner" data-id="${x.id}">Retirer</button></div>`
      : `<div class="row" style="gap:8px;margin-top:10px"><span class="pill" style="background:var(--primarySoft);color:var(--accent)">Envoi</span><span class="small" style="color:var(--text)">Envoi en cours… <span class="pct">${Math.round(x.progres * 100)} %</span></span></div><div class="bar" style="margin-top:10px"><i style="width:${Math.round(x.progres * 100)}%"></i></div>`}</div>`;
  const carte = (d) => {
    const [pill, bg, fg, msg] = STATUTS[d.statut] ?? STATUTS.au_pc;
    const icone = d.statut === 'publie' ? 'checkmark-circle-outline' : d.statut === 'a_verifier' || d.statut === 'erreur' ? 'alert-circle-outline' : d.source === 'photos' ? 'camera-outline' : 'document-text-outline';
    const actions = d.statut === 'a_verifier' ? `<div class="row" style="gap:8px;margin-top:10px"><button class="puce on" data-a="classer" data-id="${d.id}">Classer</button><button class="puce" data-a="supprimer" data-id="${d.id}">Supprimer</button></div>`
      : d.statut === 'erreur' || d.statut === 'envoye' ? `<div class="row" style="gap:8px;margin-top:10px"><button class="puce" data-a="supprimer" data-id="${d.id}">${ic('trash-outline', 13)} Supprimer</button></div>` : '';
    return `<div class="card"><div class="row" style="gap:12px"><div class="vignette">${ic(icone)}</div><div style="flex:1;min-width:0"><div class="ligne-titre">${esc(d.resultat?.titre || d.nom)}</div><div class="small">${esc(infoDepot(d))}</div></div><span class="small">${esc(ilYa(d.cree).replace("aujourd'hui à ", ''))}</span></div>
      <div class="row" style="gap:8px;margin-top:10px"><span class="pill" style="background:${bg};color:${fg}">${pill}</span><span class="small" style="color:var(--text)">${esc(msg(d))}</span></div>${actions}</div>`;
  };
  return `${entete('Mes dépôts', `Aujourd'hui · ${duJour.length} dépôt${duJour.length > 1 ? 's' : ''}, ${duJour.filter((d) => d.statut === 'publie').length} publié${duJour.filter((d) => d.statut === 'publie').length > 1 ? 's' : ''}`)}
  <div class="defile">${[['tous', 'Tous'], ['cours', 'En cours'], ['verif', `À vérifier${nbVerif ? ' · ' + nbVerif : ''}`], ['publie', 'Publiés']].map(([k, l]) => `<button class="puce ${E.filtre === k ? 'on' : ''}" data-a="filtre" data-v="${k}">${l}</button>`).join('')}</div>
  ${envois.map(carteEnvoi).join('')}${liste.map(carte).join('')}
  ${!envois.length && !liste.length ? `<div class="vide">${ic('albums-outline', 36)}<p style="margin-top:10px">Rien ici pour le moment.</p></div>` : ''}`;
}
function vueDemandes() {
  if (E.demandes == null) return `${entete('Demandes', 'Envoyées depuis l\'app Bacly · anonymes')}<div class="vide"><span class="chargement"></span></div>`;
  if (E.demandesErreur === 'installation') return `${entete('Demandes', 'Envoyées depuis l\'app Bacly')}<div class="card"><div class="b">${ic('construct-outline', 18)} Pas encore disponible</div><div class="small" style="color:var(--text);margin-top:6px">Crée d'abord la table des demandes (serveur du PC → onglet Demandes), puis relance le script <b>supabase-installation.sql</b>.</div></div>`;
  const quand = (d) => { const h = (Date.now() - new Date(d).getTime()) / 3600000; return h < 1 ? "à l'instant" : h < 24 ? `il y a ${Math.round(h)} h` : h < 48 ? 'hier' : new Date(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }); };
  return `${entete('Demandes', 'Envoyées depuis l\'app Bacly · anonymes')}
  <div class="puces"><span class="puce on">À traiter · ${E.demandes.length}</span></div>
  ${E.demandes.map((d) => `<div class="card"><div class="row" style="gap:12px;align-items:flex-start">${d.type === 'signalement' ? ic('flag-outline', 22, 'color:var(--warning)') : ic('add-circle-outline', 22, 'color:var(--primary)')}
    <div style="flex:1;min-width:0"><div class="b" style="font-size:14px">${d.type === 'signalement' ? 'Signalement' : 'Demande'}${d.sujet_titre ? ' · ' + esc(d.sujet_titre) : ''}</div><div class="small" style="margin-top:3px;color:var(--text);overflow-wrap:anywhere">« ${esc(d.message)} »</div></div><span class="pill" style="background:var(--surface);color:var(--muted)">${quand(d.cree)}</span></div>
    <div class="row" style="gap:8px;margin-top:12px"><button class="puce on" data-a="traite" data-id="${d.id}">${ic('checkmark', 13)} Traité</button><button class="puce" data-a="deposerPour" data-id="${d.id}">${ic('cloud-upload-outline', 13)} Déposer le sujet</button></div></div>`).join('')}
  ${E.demandes.length ? '' : `<div class="vide">${ic('chatbubbles-outline', 36)}<p style="margin-top:10px">Aucune demande pour le moment.</p></div>`}`;
}
function vueReglages() {
  const op = (v, l) => `<button class="puce ${E.theme === v ? 'on' : ''}" data-a="theme" data-v="${v}">${l}</button>`;
  return `${entete('Réglages', 'Bacly Admin')}
  <div class="over">Apparence</div><div class="puces">${op('auto', 'Comme le téléphone')}${op('sombre', 'Sombre')}${op('clair', 'Clair')}</div>
  <div class="over" style="margin-top:6px">Compte</div>
  <div class="card row" style="gap:12px">${ic('person-circle-outline', 24, 'color:var(--accent)')}<div style="flex:1;min-width:0"><div class="b" style="overflow-wrap:anywhere">${esc(E.session?.email || '')}</div><div class="small">Administratrice</div></div></div>
  ${carteInstaller()}
  <div class="card"><div class="b" style="margin-bottom:6px">${ic('information-circle-outline', 18, 'color:var(--accent)')} Comment ça marche</div><div class="small" style="color:var(--text);line-height:1.6">1. Tu déposes un PDF ou des photos, d'où tu veux.<br>2. Le fichier attend en ligne, dans un casier privé.<br>3. Dès que le PC est allumé, il le récupère, le lit (OCR), le classe et le publie dans Bacly.<br>Astuce : depuis WhatsApp ou Fichiers, touche <b>Partager</b> → <b>Bacly Admin</b>.</div></div>
  <button class="btn d plein" data-a="deconnecter">${ic('log-out-outline')} Se déconnecter</button>
  <div class="small" style="text-align:center">Bacly Admin · version 1.0</div>`;
}
function nav() {
  const nb = E.demandes?.length || 0;
  const it = [['deposer', 'cloud-upload', 'Déposer'], ['depots', 'albums', 'Mes dépôts'], ['demandes', 'chatbubbles', 'Demandes'], ['reglages', 'settings', 'Réglages']];
  return it.map(([k, i, l]) => `<button class="${E.onglet === k ? 'on' : ''}" data-a="onglet" data-v="${k}">${ic(E.onglet === k ? i : i + '-outline', 22)}<span>${l}</span>${k === 'demandes' && nb ? `<span class="badge">${nb > 99 ? '99+' : nb}</span>` : ''}</button>`).join('');
}
function afficher() {
  const app = $('#app'), n = $('#nav');
  const actif = document.activeElement?.dataset?.champ;
  if (!E.session) { app.innerHTML = vueConnexion(); n.hidden = true; return; }
  n.hidden = !!E.sousVue; n.innerHTML = nav();
  app.innerHTML = E.sousVue === 'photos' ? vuePhotos() : { deposer: vueDeposer, depots: vueDepots, demandes: vueDemandes, reglages: vueReglages }[E.onglet]();
  if (actif) { const el = document.querySelector(`[data-champ="${actif}"]`); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
}

// ================= Feuille « Classer » =================
function ouvrirClasser(d) {
  const c = { matiere: d.resultat?.matiere ?? d.matiere ?? null, type: d.resultat?.type ?? d.type ?? null, annee: d.resultat?.annee ?? d.annee ?? '' };
  const f = $('#feuille');
  const rendre = () => {
    f.innerHTML = `<div class="contenu"><div class="row" style="justify-content:space-between"><div class="serif" style="font-size:26px">Classer</div><button data-f="fermer" aria-label="Fermer">${ic('close', 24)}</button></div>
    <div class="small">${esc(d.nom)}</div>${blocClassement(c, 'f')}
    <button class="btn p plein" data-f="valider" ${c.matiere ? '' : 'disabled'}>${ic('checkmark')} Classer et publier</button></div>`;
  };
  rendre(); f.hidden = false;
  f.onclick = async (e) => {
    const b = e.target.closest('[data-a],[data-f]');
    if (e.target === f || b?.dataset.f === 'fermer') { f.hidden = true; return; }
    if (!b) return;
    if (b.dataset.a === 'fMatiere') { c.matiere = b.dataset.v === 'Automatique' ? null : b.dataset.v; if (!typesPour(c.matiere).includes(c.type)) c.type = null; rendre(); }
    if (b.dataset.a === 'fType') { c.type = b.dataset.v === 'Automatique' ? null : b.dataset.v; rendre(); }
    if (b.dataset.f === 'valider') {
      c.annee = f.querySelector('[data-champ="fAnnee"]').value.trim();
      try {
        await rest(`depots?id=eq.${d.id}`, { methode: 'PATCH', entetes: { Prefer: 'return=minimal' }, corps: { matiere: c.matiere, type: c.type, annee: /^\d{4}$/.test(c.annee) ? c.annee : null, statut: 'a_classer', message: null, maj: new Date().toISOString() } });
        f.hidden = true; toast('Classement envoyé au PC ✓'); await chargerDepots(); afficher();
      } catch (err) { toast(err.message); }
    }
  };
}

// ================= Évènements =================
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.closest('#feuille')) return;
  const a = b.dataset.a, v = b.dataset.v, i = Number(b.dataset.i);
  switch (a) {
    case 'voirMdp': { const inp = b.parentElement.querySelector('input'); inp.type = inp.type === 'password' ? 'text' : 'password'; break; }
    case 'installer': if (E.installer) { E.installer.prompt(); await E.installer.userChoice.catch(() => {}); E.installer = null; afficher(); } break;
    case 'onglet': E.onglet = v; E.sousVue = null; afficher(); scrollTo(0, 0); if (v === 'depots') chargerDepots().then(afficher); if (v === 'demandes') chargerDemandes().then(afficher); break;
    case 'cMatiere': E.choix.matiere = v === 'Automatique' ? null : v; if (!typesPour(E.choix.matiere).includes(E.choix.type)) E.choix.type = null; afficher(); break;
    case 'cType': E.choix.type = v === 'Automatique' ? null : v; afficher(); break;
    case 'choisir': $('#choixFichiers').click(); break;
    case 'photographier': E.sousVue = 'photos'; afficher(); scrollTo(0, 0); if (!E.photos.length) $('#choixPhoto').click(); break;
    case 'photo': if (e.target.closest('[data-a="galerie"]')) break; $('#choixPhoto').click(); break;
    case 'galerie': e.stopPropagation(); $('#choixGalerie').click(); break;
    case 'fermerPhotos': E.sousVue = null; afficher(); break;
    case 'pTourner': E.photos[i].rot = (E.photos[i].rot + 90) % 360; await apercus(); afficher(); break;
    case 'pSupprimer': E.photos.splice(i, 1); afficher(); break;
    case 'pGauche': if (i > 0) { [E.photos[i - 1], E.photos[i]] = [E.photos[i], E.photos[i - 1]]; afficher(); } break;
    case 'pDroite': if (i < E.photos.length - 1) { [E.photos[i + 1], E.photos[i]] = [E.photos[i], E.photos[i + 1]]; afficher(); } break;
    case 'ameliorer': E.ameliorer = !E.ameliorer; ecrire('ba-ameliorer', E.ameliorer); await apercus(); afficher(); break;
    case 'creerPdf': creerPdf(); break;
    case 'envoyerRecus': { const f = E.recus; E.recus = []; deposer(f); break; }
    case 'oublierRecus': E.recus = []; afficher(); break;
    case 'oublierDemande': E.pourDemande = null; afficher(); break;
    case 'filtre': E.filtre = v; afficher(); break;
    case 'reessayer': { const x = E.envois.find((y) => y.id === b.dataset.id); if (x) { x.progres = 0; lancerEnvoi(x); afficher(); } break; }
    case 'abandonner': E.envois = E.envois.filter((y) => y.id !== b.dataset.id); afficher(); break;
    case 'classer': { const d = E.depots.find((y) => y.id === b.dataset.id); if (d) ouvrirClasser(d); break; }
    case 'supprimer': {
      const d = E.depots.find((y) => y.id === b.dataset.id);
      if (!d || !confirm(`Supprimer « ${d.nom} » ?`)) break;
      try {
        if (d.statut === 'envoye') {
          await appel(cheminObjet(d.fichier), { methode: 'DELETE' }).catch(() => {});
          await rest(`depots?id=eq.${d.id}`, { methode: 'DELETE', entetes: { Prefer: 'return=minimal' } });
        } else await rest(`depots?id=eq.${d.id}`, { methode: 'PATCH', entetes: { Prefer: 'return=minimal' }, corps: { statut: 'a_supprimer', maj: new Date().toISOString() } });
        await chargerDepots(); afficher();
      } catch (err) { toast(err.message); }
      break;
    }
    case 'traite': {
      try { await rest(`demandes?id=eq.${Number(b.dataset.id)}`, { methode: 'DELETE', entetes: { Prefer: 'return=minimal' } }); E.demandes = E.demandes.filter((d) => String(d.id) !== b.dataset.id); afficher(); toast('Demande traitée ✓'); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'deposerPour': E.pourDemande = E.demandes.find((d) => String(d.id) === b.dataset.id); E.onglet = 'deposer'; afficher(); scrollTo(0, 0); break;
    case 'theme': E.theme = v; ecrire('ba-theme', v); appliquerTheme(); afficher(); break;
    case 'deconnecter': if (confirm('Se déconnecter de Bacly Admin ?')) deconnecter(); break;
  }
});
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.champ;
  if (k === 'cAnnee') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); E.choix.annee = e.target.value; }
  if (k === 'fAnnee') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'fConnexion') return;
  e.preventDefault();
  const email = e.target.email.value.trim().toLowerCase(), mdp = e.target.mdp.value;
  E.emailSaisi = email;
  if (!email || !mdp) { E.erreur = 'Entre ton e-mail et ton mot de passe.'; afficher(); return; }
  E.chargement = true; E.erreur = ''; afficher();
  try { await seConnecter(email, mdp); ecrire('ba-email', email); E.chargement = false; demarrerSession(); }
  catch (err) { E.chargement = false; E.erreur = err.message; afficher(); }
});
$('#choixFichiers').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) deposer(f); };
$('#choixPhoto').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) { E.sousVue = 'photos'; ajouterPhotos(f); } };
$('#choixGalerie').onchange = $('#choixPhoto').onchange;
// glisser-déposer (sur ordinateur)
addEventListener('dragover', (e) => { if (!E.session) return; e.preventDefault(); $('#zone')?.classList.add('survol'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#zone')?.classList.remove('survol'); });
addEventListener('drop', (e) => { if (!E.session) return; e.preventDefault(); $('#zone')?.classList.remove('survol'); const f = [...(e.dataTransfer?.files ?? [])]; if (f.length) deposer(f); });
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); E.installer = e; afficher(); });
addEventListener('beforeunload', (e) => { if (E.envois.some((x) => x.statut === 'envoi') || E.photos.length) { e.preventDefault(); e.returnValue = ''; } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (E.theme === 'auto') appliquerTheme(); });
let redim; addEventListener('resize', () => { clearTimeout(redim); redim = setTimeout(appliquerTheme, 200); });

// ================= Démarrage =================
let minuteries = [];
async function demarrerSession() {
  minuteries.forEach(clearInterval);
  afficher();
  await Promise.all([chargerPC(), chargerDepots(), chargerDemandes()]);
  afficher();
  minuteries = [
    setInterval(async () => { if (!document.hidden && E.session) { await chargerPC(); if (E.onglet === 'deposer' && !E.sousVue) afficher(); } }, 30_000),
    setInterval(async () => { if (!document.hidden && E.session && E.onglet === 'depots') { await chargerDepots(); afficher(); } }, 15_000),
    setInterval(async () => { if (!document.hidden && E.session) { await chargerDemandes(); if (E.onglet !== 'deposer' || !E.sousVue) { $('#nav').innerHTML = nav(); if (E.onglet === 'demandes') afficher(); } } }, 120_000),
  ];
}
(async function demarrer() {
  appliquerTheme();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (new URLSearchParams(location.search).has('partage')) await recupererPartages().catch(() => {});
  if (E.session) demarrerSession(); else afficher();
})();
