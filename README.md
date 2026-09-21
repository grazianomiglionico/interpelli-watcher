# Interpelli watcher — USP Ascoli Piceno

Controlla automaticamente il sito dell'Ufficio Scolastico di Ascoli Piceno e avvisa
quando viene pubblicato un nuovo interpello. Gira su GitHub Actions: nessun server,
nessun costo, funziona anche a computer spento.

## Come funziona

1. Ogni ora, dalle 06:00 alle 19:00 circa, il workflow interroga la REST API di
   WordPress con due chiamate: gli ultimi 100 post di qualunque categoria e gli
   ultimi 100 della categoria *interpelli*.
2. Tiene i post che contengono `interpell` nel **titolo**, nella **descrizione** o
   nel **contenuto**, oppure che stanno nella categoria *interpelli* (ID 350).
3. Confronta gli ID con `state/seen.json`. Se ne trova di nuovi, apre una **issue**
   su questo repository — GitHub ti manda mail e notifica push in automatico.
   La issue contiene titolo, data e i **link diretti ai PDF e ai moduli allegati**.
4. Committa lo stato aggiornato, così al giro dopo non ti rinotifica le stesse cose.

Se la REST API smette di rispondere, lo script passa da solo al feed RSS.

## Perché il filtro è fatto così

Sono scelte prese guardando i dati reali del sito, non a occhio:

- **Non basta la categoria.** Il post 26294 ("Interpello IC MONTEGIORGIO scorrimento
  graduatoria") è archiviato solo in *albo-pretorio*, non in *interpelli*. Filtrando
  per sola categoria l'avresti perso.
- **Non basta nemmeno la parola chiave.** Su 101 interpelli reali, uno non contiene
  mai "interpello": `AVVISO PUBBLICO DI SELEZIONE PER IL RECLUTAMENTO DI PERSONALE
  DOCENTE SUPPLENZA BREVE`. Lo recupera la categoria.
- **Si cerca anche nel contenuto**, anche se finora non ha mai aggiunto nulla rispetto
  al titolo: il contenuto va scaricato comunque per estrarre gli allegati, quindi
  controllarlo non costa niente e copre il caso in cui il titolo sia solo un numero di
  protocollo.
- **La chiave è `interpell`, non `interpello`.** Il sito alterna singolare, plurale e
  maiuscolo ("INTERPELLO", "Interpelli", "interpello").
- **Gli "esiti" vengono segnalati ma etichettati.** Post come "Esito interpello IC
  Centro D'Azeglio" sono risultati, non nuove candidature. Li ricevi comunque — meglio
  una notifica in più che una in meno — ma con l'etichetta `(esito, non una nuova
  candidatura)` così li riconosci dal titolo della mail.

Il prezzo di queste scelte è qualche falso positivo: un post che nomina un interpello
di sfuggita ti arriverà lo stesso. È voluto. Un avviso di troppo si ignora in due
secondi, un interpello perso no.

## Sugli orari

Le pubblicazioni si concentrano fra le 07:00 e le 15:30 (ora del sito). La finestra
06:00–19:00 è quindi già molto larga: non serve stringerla né allargarla.

Attenzione a un dettaglio: il sito espone `date: 11:55` e `date_gmt: 10:55`, cioè gira
su un **offset fisso UTC+1** invece che su Europe/Rome. D'estate il suo orario è
indietro di un'ora rispetto all'ora italiana reale. Lo script mostra l'orario così come
lo scrive il sito, in modo che il confronto con la pagina pubblica torni sempre, ma
ordina i post per l'istante reale (`date_gmt`).

## Installazione (10 minuti)

1. Crea un repository su GitHub. Se lo fai **pubblico** i minuti di Actions sono
   illimitati; se privato hai 2.000 minuti al mese e questo workflow ne consuma ~20.
2. Copia dentro il contenuto di questa cartella, mantenendo i percorsi:
   ```
   .github/workflows/interpelli.yml
   scripts/check-interpelli.mjs
   state/seen.json
   ```
3. Fai push.
4. **Settings → Actions → General → Workflow permissions** → *Read and write
   permissions*. Senza questo il bot non può committare lo stato né aprire le issue,
   e il job fallisce all'ultimo passaggio.
5. **Actions → Controllo interpelli → Run workflow** per la prima esecuzione manuale.
   Serve da taratura: segna gli interpelli già online come "visti" senza notificarti
   nulla. Da lì in avanti ti avvisa solo per le novità.
6. Verifica di ricevere le notifiche: **Watch → All Activity** in alto a destra nel
   repo, e la mail per le issue attiva nelle impostazioni del tuo account GitHub.

## Verificare che funzioni davvero

Apri `state/seen.json`, cancella un ID dalla lista, committa e lancia il workflow a
mano. Devi ricevere la issue per quell'interpello. Fallo prima di affidarti al
sistema: un meccanismo di notifica che non hai mai visto scattare non è un
meccanismo di notifica.

## Notifica su Telegram (opzionale)

La issue su GitHub basta e non richiede configurazione. Se vuoi anche il messaggio
sul telefono:

1. Scrivi a [@BotFather](https://t.me/BotFather), crea un bot, copia il token.
2. Scrivi un messaggio al tuo bot, apri `https://api.telegram.org/bot<TOKEN>/getUpdates`
   e copia il tuo `chat.id`.
3. Nel repo: **Settings → Secrets and variables → Actions → New repository secret**,
   crea `TELEGRAM_TOKEN` e `TELEGRAM_CHAT_ID`.

Lo step è già nel workflow e si attiva da solo quando i secret esistono.

## Cose da sapere

- **Ritardi del cron.** GitHub non garantisce l'orario esatto: nei momenti di picco un
  job schedulato può partire con 5–20 minuti di ritardo. Irrilevante con un controllo
  ogni ora.
- **Disattivazione dopo 60 giorni.** GitHub sospende i workflow schedulati nei repo
  senza attività da 60 giorni (avvisa per mail prima). Ogni nuovo interpello produce un
  commit e resetta il contatore; in periodi lunghi senza pubblicazioni basta un commit
  qualsiasi per riattivarlo.
- **Se il sito cambia.** Se cadono sia REST API sia RSS, il job fallisce in modo
  visibile e GitHub ti manda la mail di workflow fallito, invece di restare zitto. È
  voluto: un controllo che tace per un guasto è peggio di uno che si lamenta.
- **Se arrivano molti interpelli insieme.** Il corpo di una issue GitHub si ferma a
  65536 caratteri. Se il workflow è rimasto fermo a lungo, la issue mostra i più
  recenti e dichiara in fondo quanti ne restano fuori, con il link alla pagina.
  **La issue viene aperta in ogni caso:** se il corpo completo venisse rifiutato, il
  workflow riprova con il solo elenco di titoli e link, e in ultima istanza con un
  avviso di una riga. L'avviso ti arriva comunque, al massimo perdi i dettagli.
- **Il feed RSS espone solo 15 post.** Quando la REST API cade, la copertura del
  fallback è molto più stretta: va bene per un'ora di disservizio, non per giorni.

## Modifiche frequenti

- **Frequenza:** il `cron` nel workflow. `0 4-18 * * *` = ogni ora; `0,30 4-18 * * *`
  = ogni mezz'ora.
- **Parola chiave:** costante `KEYWORD` in `scripts/check-interpelli.mjs`.
- **Escludere gli esiti:** nello stesso file, in `main()`, aggiungi
  `.filter((e) => !ESITO.test(e.titolo))` dopo `elementi.filter(eInterpello)`.
- **Quanti post esaminare:** costante `PER_PAGE` (massimo 100, limite della REST API).
