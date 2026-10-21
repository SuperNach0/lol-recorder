# LoL Recorder

Enregistre tes parties de League of Legends avec le vocal Discord (une piste par personne), puis rejoue le replay officiel du client LoL synchronisé avec les voix.

> État : **prototypes** (bot d'enregistrement + pilotage du replay). L'app desktop Electron viendra ensuite.

## Comment ça marche

1. Un bot Discord, lancé sur ton PC, rejoint ton salon vocal et écrit un fichier `.ogg` par prise de parole et par personne, horodaté à la milliseconde.
2. Pendant la partie, l'app lit le temps de jeu via la [Live Client Data API](https://developer.riotgames.com/docs/lol#game-client-api) et en déduit l'heure exacte du début de partie.
3. À la fin, elle demande au client LoL de télécharger le replay (`.rofl`).
4. À la lecture, elle suit l'horloge du replay via la Replay API et sait qui parlait à chaque seconde.

Tout est rangé dans `sessions/<date>/` : `session.json` + les fichiers audio.

## Installation (Windows)

1. Installe [Node.js 22 LTS](https://nodejs.org/) (22.12 ou plus).
2. Clone le dépôt puis `npm install`.
3. **Crée le bot Discord** :
   - [Portail développeur Discord](https://discord.com/developers/applications) > *New Application*.
   - Onglet *Bot* > *Reset Token*, copie le token.
   - Onglet *OAuth2* > *URL Generator* : coche `bot` et `applications.commands`, puis les permissions *Connect*, *Speak*, *Send Messages*. Ouvre l'URL générée pour inviter le bot sur ton serveur.
4. Copie `.env.example` en `.env` et remplis `DISCORD_TOKEN`, `DISCORD_GUILD_ID` et `DISCORD_OWNER_ID` (active le mode développeur dans Discord pour copier les identifiants).
5. **Active la Replay API** : dans `C:\Riot Games\League of Legends\Config\game.cfg`, sous `[General]`, ajoute la ligne `EnableReplayApi=1`.

## Utilisation

### Enregistrer

```
npm run record
```

- Le bot rejoint automatiquement ton salon dès que tu entres en lobby LoL (si `DISCORD_OWNER_ID` est rempli et le client LoL ouvert).
- Sinon, dans Discord : `/record start` et `/record stop`.
- Le bot annonce l'enregistrement dans le salon. Préviens tes potes : enregistrer quelqu'un sans son accord est interdit par Discord.

### Revoir

```
npm run replay -- watch <gameId>          # lance le replay (gameId dans sessions/.../session.json)
npm run replay -- status                  # position actuelle du replay
npm run replay -- seek 600                # saute à 10:00
npm run replay -- sync sessions/<dossier> # affiche en direct qui parle
```

Le lecteur audio synchronisé arrive avec l'app Electron.

## Limites connues

- Un `.rofl` n'est lisible que sur le patch où la partie a été jouée (environ 2 semaines). L'audio, lui, reste.
- Discord chiffre les appels de bout en bout (DAVE) : c'est géré par `@discordjs/voice` 0.19.

## Développement

```
npm test          # tests unitaires (ffmpeg requis pour le test Ogg)
npm run typecheck
```
