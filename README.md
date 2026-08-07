# 🎲 Perudo online

Gioco di dadi e bluff (Perudo) multiplayer via browser. Un **host** crea un tavolo,
imposta quanti dadi per giocatore (1–5) e condivide un **link/codice**; gli amici si
uniscono dal telefono scrivendo il proprio nome — **anche da reti diverse**, perché
tutto passa da un server pubblico.

## Come si gioca

- Ogni giocatore ha dei dadi nascosti nel proprio "bicchiere".
- A turno si **dichiara** (quantità + valore). Il rilancio deve alzare la quantità,
  oppure mantenerla ma aumentare il valore.
- Chi non ci crede fa **"Dubito!"**: si scoprono tutti i dadi e si contano quelli col
  valore dichiarato su tutto il tavolo.
  - Se ce ne sono **almeno quanti dichiarati** → chi ha dubitato perde un dado.
  - Altrimenti → chi ha dichiarato perde un dado.
- Chi arriva a **0 dadi è eliminato**. Vince l'ultimo rimasto.
- Il primo round lo apre un giocatore a caso; i round successivi li apre il giocatore
  successivo in senso di gioco.

## Requisiti

- [Node.js](https://nodejs.org) 18 o superiore (per girare in locale). Verifica con:

  ```bash
  node --version
  ```

## Avvio in locale

```bash
npm install
npm start
```

Poi apri `http://localhost:3000`. Per simulare più giocatori, apri più schede/finestre
del browser (o collega altri dispositivi sulla stessa rete usando l'IP del PC).

### Test della logica di gioco

```bash
npm test
```

Esegue i test unitari dell'engine (`game/engine.test.js`): validazione dei rilanci,
conteggio del "dubito", eliminazione e vittoria, passaggio dello starter tra round.

## Deploy gratuito su Render (URL pubblico)

Per giocare con amici fuori dalla tua rete serve un server raggiungibile da internet.

1. Crea un repository Git con questo progetto e caricalo su GitHub.
2. Vai su [render.com](https://render.com) → **New** → **Web Service** e collega il repo.
3. Render legge `render.yaml` in automatico (runtime Node, build `npm install`, start
   `node server.js`, piano **Free**). Conferma e attendi il deploy.
4. Ottieni un URL tipo `https://perudo-online.onrender.com`: quello è il link da girare.

> **Nota sul piano Free di Render**: dopo ~15 minuti di inattività il servizio va in
> "sleep"; la prima connessione lo risveglia in ~30–60 secondi. Perfetto per partite
> occasionali. Le partite in corso vivono in memoria: se il server riavvia, si perdono.

### Alternativa: PC + tunnel pubblico

Se preferisci non usare il cloud, puoi far girare il server sul tuo PC (`npm start`) ed
esporlo con un tunnel come [ngrok](https://ngrok.com) o Cloudflare Tunnel:

```bash
ngrok http 3000
```

ngrok ti dà un URL pubblico temporaneo da condividere. Funziona solo mentre il tuo PC e
il tunnel sono accesi.

## Struttura del progetto

```
server.js            Express + Socket.IO: instrada gli eventi realtime
game/
  engine.js          Logica pura del gioco (regole, validazioni, conteggio)
  engine.test.js     Test unitari dell'engine
  rooms.js           Gestione tavoli in memoria + codici + reconnect
public/
  index.html         Interfaccia (home / lobby / gioco), mobile-first
  styles.css
  client.js          Client Socket.IO: rendering e interazioni
render.yaml          Configurazione deploy su Render
```

## Note tecniche

- **Server autoritativo**: dadi e regole vivono lato server; a ogni giocatore arrivano
  **solo i propri** dadi, così non si può barare ispezionando il browser.
- **Reconnect**: un token salvato nel browser permette di rientrare al proprio posto
  dopo un refresh o una disconnessione temporanea del telefono.
