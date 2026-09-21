# Contesto del progetto — interpelli watcher

## Obiettivo

Sapere ogni giorno se sul sito dell'Ufficio Scolastico Provinciale di Ascoli Piceno è
stato pubblicato un nuovo **interpello** (avviso per incarichi di supplenza). Le
scadenze sono di 24–72 ore, quindi la notifica deve arrivare in tempo per candidarsi.

Pagina interpelli: https://www.uspascolipiceno.it/wordpress/interpelli/

## Vincoli dichiarati dall'utente

1. **Deve girare sempre**, anche a computer spento. Niente cron locale, niente script
   da lanciare a mano.
2. **Gratis.** Nessun servizio a pagamento, nessun VPS.
3. **Semplicità.** Il meno codice possibile.
4. Frequenza: **ogni ora dalle 06:00 alle 19:00**, perché l'orario di pubblicazione
   non è fisso.

## Soluzione scelta

**GitHub Actions** con workflow schedulato, notifica tramite **issue aperta sul repo
stesso** (zero credenziali: GitHub manda già mail e push). Step Telegram opzionale già
presente, si attiva da solo se esistono i secret `TELEGRAM_TOKEN` e `TELEGRAM_CHAT_ID`.

Scartate: cron locale (vincolo 1), page-monitoring tipo Visualping/Distill (limiti dei
piani gratuiti, falsi positivi su pagina paginata), RSS-to-email tipo IFTTT/Blogtrottr
(il filtro per parola chiave è spesso a pagamento). Non riproporle.

---

## Misure sui dati reali (21/09/2026)

Script eseguito contro il sito vero. Campione: 180 post unici, 101 riconosciuti come
interpelli. Non riverificare senza un motivo concreto.

| Fatto | Valore misurato |
|---|---|
| Copertura del **titolo** da solo | **100 match su 101** |
| Match aggiunti da `excerpt` | 0 |
| Match aggiunti da `content` | 0 |
| Match aggiunti dalla **sola categoria 350** | 1 |
| Categoria `interpelli` | ID 350 |
| Categoria `albo-pretorio` | ID 288 |
| Finestra coperta dai 100 post recenti | fino a 2026-06-26 |
| Finestra coperta dai 100 della categoria 350 | fino a 2025-12-24 |
| Ripetizioni massime dello stesso allegato in un post | 2 |
| Post con più di 6 allegati unici | 4 su 100, massimo 20 allegati |

Conseguenze da tenere presenti:

- Il **titolo è il segnale che decide**. Descrizione e contenuto non hanno mai deciso
  da soli. Restano nel filtro perché il contenuto va scaricato comunque per gli
  allegati: costo zero.
- La **categoria 350 serve davvero**, ma per un caso su cento: avvisi che non
  contengono mai la parola chiave, tipo `AVVISO PUBBLICO DI SELEZIONE PER IL
  RECLUTAMENTO DI PERSONALE DOCENTE SUPPLENZA BREVE`.
- La seconda chiamata (categoria 350) **allarga la finestra di circa sei mesi**. È la
  rete di sicurezza per il caso "workflow fermo a lungo". Se fallisce da sola, si
  prosegue con la prima.
- Il post **26294** ("Interpello IC MONTEGIORGIO scorrimento graduatoria") ha
  `categories: [288]`, solo albo-pretorio. Filtrando per sola categoria l'avresti
  perso. L'archiviazione del sito non è coerente.

### Il fuso orario

Il sito espone `date: 2026-09-21T11:55:23` e `date_gmt: 2026-09-21T10:55:23`:
differenza di un'ora in pieno settembre, quando l'Italia è UTC+2. WordPress è quindi
configurato su un **offset fisso UTC+1**, non su Europe/Rome.

Lo script perciò:

- **ordina** per `date_gmt` (istante reale, con la `Z` aggiunta a mano perché arriva
  senza suffisso e Node lo interpreterebbe come ora locale del runner);
- **mostra** `date` grezzo tramite `formattaDataSito`, senza conversioni, così
  l'orario nella notifica coincide con quello scritto sulla pagina pubblica.

Non "sistemare" questa doppia gestione convertendo tutto: la discrepanza è del sito, e
allinearsi al suo orario evita che l'utente pensi a un bug.

---

## Regole di filtro

1. **Chiave `interpell`**, non `interpello`: il sito alterna singolare, plurale e
   maiuscolo.
2. Si cerca in titolo, descrizione e contenuto.
3. Si accetta anche la sola categoria 350.
4. **Mai la categoria da sola** (vedi post 26294).
5. Gli esiti vengono notificati ma etichettati `(esito, non una nuova candidatura)`.
   Il regex richiede che `esito`/`esiti` sia vicino a `interpell`: da solo marcherebbe
   anche titoli come `Decreto esiti assegnazioni provvisorie e utilizzazioni`, che
   interpelli non sono.

**Compromesso accettato consapevolmente:** il filtro è volutamente largo e produce
qualche falso positivo. Un avviso di troppo si ignora, un interpello perso no. Non
stringere il filtro senza che l'utente lo chieda.

---

## Dettagli implementativi da non rompere

- **Mai interpolare `${{ }}` dentro una riga di comando.** Il titolo arriva da un sito
  di terzi e contiene virgolette: `Interpello ... - "IC NARDI".` spezzava l'argomento
  e faceva fallire `gh issue create`, e un titolo con `$(...)` sarebbe stato eseguito
  sul runner, che ha `contents: write` e `issues: write`. Il titolo passa per la
  variabile d'ambiente `TITOLO`. Vale per qualsiasi valore futuro preso dal sito.
- **Bootstrap al primo avvio.** Se `bootstrapped` è `false`, lo script segna tutto come
  già visto **senza notificare**, per non sommergere l'utente con lo storico. È il
  motivo per cui la prima esecuzione sembra "non fare niente": è corretto.
- **ID nello stesso namespace fra le due sorgenti.** La REST dà `post-26468`, il guid
  RSS dà `https://.../wordpress/?p=26468`. `idDaGuid` riporta il secondo al primo.
  Senza questa normalizzazione, dopo un giro in fallback RSS il giro REST successivo
  rinotifica tutto (misurato: 101 nuovi invece di 91).
- **L'avviso deve arrivare sempre: il corpo è la parte sacrificabile.** È la priorità
  dichiarata dall'utente. Il limite GitHub è 65536 caratteri per il corpo di una issue
  e un run su 101 nuovi ne produceva 72189: `gh issue create` sarebbe stato rifiutato e
  l'utente non avrebbe ricevuto niente. Difese, in ordine:
  1. `componiMessaggio` si ferma a `MAX_BODY_CHARS` (60000) e dichiara quanti
     interpelli restano fuori, poi taglia comunque il risultato come rete di sicurezza;
  2. lo script scrive anche `nuovi-interpelli-breve.md`, solo titoli e link: sullo
     stesso campione da 101 interpelli sta in 29175 caratteri e **non ne omette
     nessuno**;
  3. il workflow prova i due corpi in ordine e, se entrambi vengono rifiutati, apre
     comunque una issue con un corpo di una riga e il link alla pagina.

  Non togliere questa catena per "semplificare": un avviso senza dettagli vale molto
  più di nessun avviso.
- **Allegati: nessun taglio silenzioso.** `estraiAllegati` restituisce tutto,
  `componiMessaggio` ne mostra `MAX_ALLEGATI` e dichiara i restanti. La deduplica per
  URL serve perché nei blocchi con anteprima PDF lo stesso file compare due volte
  (`<object data>` e link). Si ripuliscono i prefissi `annotazione_`, `timbro__`,
  `m_pi.`.
- **Decodifica entità HTML:** `&amp;` va sostituito **per ultimo**, altrimenti
  riscrive le altre entità (`&amp;lt;` diventerebbe `<` invece di `&lt;`).
- **La label `interpello` deve esistere**, altrimenti `gh issue create` fallisce. Il
  workflow la crea da sé con `gh label create ... || true`.
- **Telegram senza `parse_mode`.** Il taglio a 3500 byte può spezzare un marcatore
  Markdown a metà e Telegram risponde `400 can't parse entities`. In testo semplice
  gli URL restano cliccabili.
- **`concurrency: group: interpelli`** evita che due run sovrapposte litighino sul
  commit dello stato.
- **Permessi:** `contents: write` + `issues: write`, e nel repo va impostato
  *Settings → Actions → General → Workflow permissions → Read and write*. È l'errore
  più probabile in fase di installazione.
- **Stato limitato a 800 ID** (`MAX_IDS_IN_STATE`) per non far crescere il file
  all'infinito.

---

## Stato dei test

Verificato il 21/09/2026 contro il sito vero, non solo con fixture:

- run completo: 100 post recenti + 100 della categoria = 180 unici, 101 interpelli,
  exit 0;
- corpo della issue generato: 59900 caratteri, 83 blocchi mostrati, 18 dichiarati
  fuori; corpo breve di riserva 29175 caratteri con tutti e 101;
- catena di fallback dello step issue simulata con un `gh` finto: corpo completo
  rifiutato → riesce il breve; entrambi rifiutati → riesce l'avviso minimo. In tutti i
  casi lo step esce 0 e la issue viene aperta;
- titolo con virgolette e `$(id -un)` passato a `gh` intatto, non eseguito;
- fallback RSS forzato (endpoint REST rotto): 15 elementi dal feed, 10 interpelli, ID
  salvati come `post-26471` e non rinotificati al giro REST successivo;
- funzioni pure verificate singolarmente: `idDaGuid`, `ESITO` (due falsi positivi reali
  esclusi), `formattaDataSito`, `decodifica` (`&amp;` per ultimo), `estraiAllegati`
  (20 allegati unici, deduplica, rimozione prefissi).

**Mai verificata la catena di notifica su GitHub** (apertura issue, mail, push):
richiede un run reale sul repo. Per provarla: cancellare un ID da `state/seen.json`,
committare, lanciare il workflow a mano da Actions.

## Cose note e non risolte

- **Ritardi del cron GitHub:** 5–20 minuti nei momenti di picco. Accettato, irrilevante
  con controllo orario.
- **Sospensione dopo 60 giorni** di inattività del repo per i workflow schedulati. Ogni
  nuovo interpello produce un commit e resetta il contatore, ma un periodo lungo senza
  pubblicazioni (luglio–agosto) potrebbe farla scattare. Se succede: uno step che tocca
  un file di heartbeat una volta a settimana.
- **Nessuna notifica di "job fallito"** oltre alla mail standard di GitHub. Se cadono
  sia REST sia RSS, lo script esce con codice diverso da zero: scelta voluta, un
  controllo che tace per un guasto è peggio di uno che si lamenta.
- **Il feed RSS espone solo 15 elementi.** In fallback la copertura è molto più stretta
  della REST API: va bene per un'ora di disservizio, non per giorni.
