#!/usr/bin/env node
/**
 * Controlla il sito USP Ascoli Piceno e segnala i nuovi interpelli.
 *
 * Fonte primaria: REST API di WordPress. Fallback: feed RSS.
 * Stato: state/seen.json -> elenco degli ID già notificati.
 * Nessuna dipendenza esterna: richiede Node 20+ (fetch nativo).
 *
 * Scelte di progetto motivate dai dati reali del sito (misure del 21/09/2026,
 * campione di 181 post, 101 riconosciuti come interpelli):
 * - Il titolo da solo copre 100 dei 101 match. È il segnale principale.
 * - La categoria "interpelli" (350) recupera l'unico caso rimasto: avvisi che non
 *   contengono mai la parola chiave (es. "AVVISO PUBBLICO DI SELEZIONE...").
 * - Non ci si affida SOLO alla categoria: alcuni interpelli finiscono solo in
 *   "albo-pretorio" (post 26294, categories: [288]). Le due regole si coprono a vicenda.
 * - Descrizione e contenuto non hanno mai deciso da soli, ma restano nel filtro:
 *   il contenuto va scaricato comunque per estrarre gli allegati, quindi è gratis.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASE = 'https://www.uspascolipiceno.it/wordpress';
const API = `${BASE}/wp-json/wp/v2/posts`;
const FEED = `${BASE}/feed/`;
const PAGINA_PUBBLICA = `${BASE}/interpelli/`;

const CATEGORIA_INTERPELLI = 350;
const PER_PAGE = 100;            // massimo consentito dalla REST API
const KEYWORD = /interpell/i;    // copre interpello, interpelli, INTERPELLO...
// "esito" deve riferirsi a un interpello: da solo marcherebbe anche titoli come
// "Decreto esiti assegnazioni provvisorie e utilizzazioni", che interpelli non sono.
const ESITO = /\besit[oi]\b[\s\S]{0,40}interpell/i;
const STATE_FILE = 'state/seen.json';
const MAX_IDS_IN_STATE = 800;
const TIMEOUT_MS = 20000;
const MAX_ALLEGATI = 12;         // oltre, il messaggio dichiara quanti ne restano
const MAX_BODY_CHARS = 60000;    // il corpo di una issue GitHub si ferma a 65536

// ---------------------------------------------------------------- utilities

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'interpelli-watcher/1.1 (+github actions)',
        Accept: 'application/json, application/rss+xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} su ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, tentativi = 3) {
  let ultimoErrore;
  for (let i = 1; i <= tentativi; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErrore = err;
      log(`tentativo ${i}/${tentativi} fallito: ${err.message}`);
      if (i < tentativi) await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  throw ultimoErrore;
}

/** Rimuove i tag HTML e decodifica le entità più comuni. */
function pulisci(html = '') {
  return decodifica(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodifica(testo = '') {
  return testo
    .replace(/&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8212;|&mdash;/g, '--')
    .replace(/&#8230;|&hellip;/g, '...')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&'); // per ultimo, altrimenti riscrive le altre entità
}

/** Estrae i PDF/DOCX allegati al post, deduplicati. */
function estraiAllegati(html = '') {
  const trovati = new Map();
  const re = /href="([^"]*\/wp-content\/uploads\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodifica(m[1]);
    if (trovati.has(url)) continue;
    let nome = decodeURIComponent(url.split('/').pop() || url);
    nome = nome.replace(/^(annotazione_|timbro__|m_pi\.)/i, '');
    trovati.set(url, nome);
  }
  // Nessun taglio qui: il numero esatto serve a componiMessaggio, che decide
  // quanti mostrarne e lo dichiara. Ci sono post con 20 allegati.
  return [...trovati].map(([url, nome]) => ({ url, nome }));
}

/** Formatta la data così come la espone il sito, senza conversioni di fuso. */
function formattaDataSito(grezza) {
  const m = String(grezza).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  const [, anno, mese, giorno, ore, minuti] = m;
  return `${giorno}/${mese}/${anno}, ${ore}:${minuti}`;
}

function formattaData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ------------------------------------------------------------------ sorgenti

function normalizza(p) {
  return {
    id: `post-${p.id}`,
    titolo: pulisci(p.title?.rendered),
    descrizione: pulisci(p.excerpt?.rendered),
    testo: pulisci(p.content?.rendered),
    categorie: Array.isArray(p.categories) ? p.categories : [],
    allegati: estraiAllegati(p.content?.rendered || ''),
    link: p.link,
    // date_gmt è in UTC ma arriva senza suffisso: lo aggiungiamo, altrimenti
    // Node lo interpreta come ora locale del runner (che gira in UTC).
    // Serve per ordinare correttamente in senso cronologico.
    data: p.date_gmt ? `${p.date_gmt}Z` : p.date,
    // Il sito gira su un offset fisso UTC+1, quindi d'estate il suo orario non
    // coincide con l'ora italiana. Mostriamo il suo, così il confronto con la
    // pagina pubblica torna sempre.
    dataSito: p.date || '',
  };
}

async function daRestApi(extra = {}) {
  const url = new URL(API);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('orderby', 'date');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('_fields', 'id,date,date_gmt,link,title,excerpt,content,categories');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));

  const res = await fetchWithTimeout(url.toString());
  const posts = await res.json();
  if (!Array.isArray(posts)) throw new Error('La REST API non ha restituito un array');
  return posts.map(normalizza);
}

/** Riporta il guid del feed allo stesso namespace degli ID della REST API. */
function idDaGuid(guid, link) {
  const m = String(guid).match(/[?&]p=(\d+)/);
  return m ? `post-${m[1]}` : guid || link;
}

async function daRss() {
  const res = await fetchWithTimeout(FEED);
  const xml = await res.text();
  const items = xml.split(/<item[\s>]/i).slice(1);

  return items.map((item) => {
    const prendi = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return '';
      return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    };
    const link = pulisci(prendi('link'));
    const contenuto = prendi('content:encoded') || prendi('description');
    return {
      // Il guid RSS è "https://.../wordpress/?p=26468", la REST dà "post-26468".
      // Senza normalizzare, un giro in fallback RSS salva ID di un altro
      // namespace e il giro REST successivo rinotifica tutto da capo.
      id: idDaGuid(pulisci(prendi('guid')), link),
      titolo: pulisci(prendi('title')),
      descrizione: pulisci(prendi('description')),
      testo: pulisci(contenuto),
      categorie: [],
      allegati: estraiAllegati(contenuto),
      link,
      data: prendi('pubDate'),
      dataSito: '', // l'RSS non espone l'ora locale del sito: si usa formattaData
    };
  });
}

/**
 * Due chiamate deduplicate:
 *  1. gli ultimi 100 post di qualunque categoria (prende anche gli interpelli
 *     finiti solo in "albo-pretorio");
 *  2. gli ultimi 100 della categoria "interpelli" (rete di sicurezza se il
 *     workflow è rimasto fermo a lungo e nel frattempo sono usciti molti post).
 */
async function scaricaElementi() {
  try {
    const [recenti, categoria] = await Promise.all([
      withRetry(() => daRestApi()),
      withRetry(() => daRestApi({ categories: CATEGORIA_INTERPELLI })).catch((err) => {
        log(`Elenco per categoria non disponibile (${err.message}), proseguo con i soli post recenti.`);
        return [];
      }),
    ]);

    const perId = new Map();
    for (const e of [...recenti, ...categoria]) perId.set(e.id, e);
    log(`REST API OK: ${recenti.length} post recenti + ${categoria.length} in categoria = ${perId.size} unici.`);
    return [...perId.values()];
  } catch (err) {
    log(`REST API non disponibile (${err.message}). Passo al feed RSS.`);
    const elementi = await withRetry(daRss);
    log(`RSS OK: ${elementi.length} elementi.`);
    return elementi;
  }
}

// -------------------------------------------------------------------- filtro

function eInterpello(e) {
  return (
    KEYWORD.test(e.titolo || '') ||
    KEYWORD.test(e.descrizione || '') ||
    KEYWORD.test(e.testo || '') ||
    e.categorie.includes(CATEGORIA_INTERPELLI)
  );
}

// -------------------------------------------------------------------- stato

async function leggiStato() {
  try {
    const stato = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return {
      bootstrapped: Boolean(stato.bootstrapped),
      ids: Array.isArray(stato.ids) ? stato.ids : [],
    };
  } catch {
    log('Nessuno stato precedente trovato: primo avvio.');
    return { bootstrapped: false, ids: [] };
  }
}

async function scriviStato(ids) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const stato = {
    bootstrapped: true,
    aggiornatoIl: new Date().toISOString(),
    ids: ids.slice(0, MAX_IDS_IN_STATE),
  };
  await writeFile(STATE_FILE, `${JSON.stringify(stato, null, 2)}\n`, 'utf8');
}

// --------------------------------------------------------------- messaggio

function titoloNotifica(nuovi) {
  if (nuovi.length === 1) return `Nuovo interpello: ${nuovi[0].titolo}`.slice(0, 180);
  return `${nuovi.length} nuovi interpelli pubblicati`;
}

function componiBlocco(n) {
  const etichetta = ESITO.test(n.titolo) ? ' *(esito, non una nuova candidatura)*' : '';
  const parti = [`### ${n.titolo}${etichetta}`];

  const quando = formattaDataSito(n.dataSito) || formattaData(n.data);
  if (quando) parti.push(`**Pubblicato:** ${quando}`);

  if (n.allegati.length) {
    const mostrati = n.allegati.slice(0, MAX_ALLEGATI);
    const elenco = mostrati.map((a) => `- [${a.nome}](${a.url})`);
    const restanti = n.allegati.length - mostrati.length;
    if (restanti > 0) elenco.push(`- _...e altri ${restanti} allegati sulla pagina._`);
    parti.push(elenco.join('\n'));
  }

  if (n.link) parti.push(`[Apri la pagina sul sito](${n.link})`);
  return parti.join('\n\n');
}

function componiMessaggio(nuovi) {
  const intestazione =
    nuovi.length === 1
      ? `Rilevato **1 nuovo interpello** su [uspascolipiceno.it](${PAGINA_PUBBLICA}).`
      : `Rilevati **${nuovi.length} nuovi interpelli** su [uspascolipiceno.it](${PAGINA_PUBBLICA}).`;

  const piede = `_Controllo automatico eseguito il ${formattaData(new Date().toISOString())}._`;

  // GitHub rifiuta i corpi oltre 65536 caratteri. Con molti interpelli in un
  // colpo solo (workflow fermo a lungo) il limite si raggiunge davvero: un run
  // di prova su 101 nuovi ha prodotto 72189 caratteri. Meglio una issue
  // troncata che una issue rifiutata.
  const blocchi = [];
  let lunghezza = intestazione.length + piede.length + 16;
  let omessi = 0;

  for (const n of nuovi) {
    const blocco = componiBlocco(n);
    if (omessi === 0 && lunghezza + blocco.length + 200 <= MAX_BODY_CHARS) {
      blocchi.push(blocco);
      lunghezza += blocco.length + 9; // il separatore "\n\n---\n\n"
    } else {
      omessi++;
    }
  }

  const coda = omessi
    ? [
        '',
        '---',
        `**Altri ${omessi} interpelli non entrano in questa issue** (limite di lunghezza di GitHub).`,
        `Li trovi su [uspascolipiceno.it](${PAGINA_PUBBLICA}).`,
      ]
    : [];

  const corpo = [intestazione, '', blocchi.join('\n\n---\n\n'), ...coda, '', '---', piede].join('\n');
  // Rete di sicurezza: qualunque cosa sia andata storta nel conteggio sopra,
  // da qui non esce un corpo che GitHub rifiuterebbe.
  return corpo.length > MAX_BODY_CHARS ? `${corpo.slice(0, MAX_BODY_CHARS - 80)}\n\n_(messaggio troncato)_` : corpo;
}

/**
 * Versione minima del messaggio: solo titolo e link, niente date né allegati.
 * Serve al workflow come secondo tentativo se la issue completa viene rifiutata.
 * L'avviso deve arrivare comunque: il corpo è la parte sacrificabile.
 */
function componiMessaggioBreve(nuovi) {
  const righe = nuovi.map((n) => {
    const titolo = n.titolo.length > 120 ? `${n.titolo.slice(0, 117)}...` : n.titolo;
    const etichetta = ESITO.test(n.titolo) ? ' _(esito)_' : '';
    return n.link ? `- [${titolo}](${n.link})${etichetta}` : `- ${titolo}${etichetta}`;
  });

  const corpo = [
    `Rilevati **${nuovi.length}** nuovi interpelli su [uspascolipiceno.it](${PAGINA_PUBBLICA}).`,
    '',
    ...righe,
  ].join('\n');

  return corpo.length > MAX_BODY_CHARS ? `${corpo.slice(0, MAX_BODY_CHARS - 80)}\n\n_(elenco troncato)_` : corpo;
}

/** Espone i risultati agli step successivi del workflow. */
async function pubblicaOutput(ceNuovi, titolo = '', quanti = 0) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const righe = [
    `has_new=${ceNuovi}`,
    `count=${quanti}`,
    `title<<__EOF__\n${titolo}\n__EOF__`,
  ].join('\n');
  await writeFile(file, `${righe}\n`, { flag: 'a' });
}

// --------------------------------------------------------------------- main

async function main() {
  const elementi = await scaricaElementi();
  const interpelli = elementi.filter(eInterpello);
  log(`Post che risultano interpelli: ${interpelli.length}`);

  const stato = await leggiStato();
  const visti = new Set(stato.ids);

  // Primo avvio: allineo lo stato senza sommergere di notifiche lo storico.
  if (!stato.bootstrapped) {
    log(`Primo avvio: segno ${interpelli.length} interpelli come già visti, nessuna notifica.`);
    await scriviStato(interpelli.map((e) => e.id));
    await pubblicaOutput(false);
    return;
  }

  const nuovi = interpelli
    .filter((e) => !visti.has(e.id))
    .sort((a, b) => new Date(b.data) - new Date(a.data));

  if (nuovi.length === 0) {
    log('Nessun nuovo interpello.');
    await pubblicaOutput(false);
    return;
  }

  log(`Trovati ${nuovi.length} nuovi interpelli:`);
  for (const n of nuovi) log(` - ${n.titolo}`);

  await writeFile('nuovi-interpelli.md', componiMessaggio(nuovi), 'utf8');
  await writeFile('nuovi-interpelli-breve.md', componiMessaggioBreve(nuovi), 'utf8');
  await scriviStato([...nuovi.map((e) => e.id), ...stato.ids]);
  await pubblicaOutput(true, titoloNotifica(nuovi), nuovi.length);
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
