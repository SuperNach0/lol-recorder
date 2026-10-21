# LoL Recorder

Enregistre tes parties de League of Legends avec le vocal Discord (une piste par personne), puis rejoue le replay officiel du client LoL synchronisé avec les voix.

## Installation

1. Télécharge `LoL-Recorder-Setup-x.y.z.exe` dans les [Releases](https://github.com/SuperNach0/lol-recorder/releases) et lance-le.
   Windows peut afficher « Windows a protégé votre ordinateur » car l'app n'est pas signée : clique sur *Informations complémentaires* puis *Exécuter quand même*.
2. Au premier lancement, l'assistant te guide :
   - créer ton bot sur le [portail développeur Discord](https://discord.com/developers/applications) et coller son token (il est chiffré sur ton PC) ;
   - inviter le bot sur ton serveur ;
   - activer la Replay API de LoL (un clic).

## Utilisation

- Laisse l'app ouverte (elle reste dans la zone de notification quand tu fermes la fenêtre).
- Dès que tu entres en lobby, le bot rejoint ton salon vocal et enregistre chaque personne sur sa propre piste. Il annonce l'enregistrement dans le salon : préviens tes potes, enregistrer quelqu'un sans son accord est interdit par Discord.
- Tu peux aussi lancer ou arrêter à la main : bouton en haut de l'app, ou `/record start` et `/record stop` dans Discord.
- À la fin de la partie, l'app récupère le replay.
- Dans *Mes parties*, clique sur **Revoir** puis **Lancer le replay LoL** : le son suit le replay, y compris pause, saut dans la timeline et vitesse x0.5 à x2. Tu règles le volume de chaque personne, et tu cliques sur la timeline pour sauter à un moment où quelqu'un parle.
- Sans replay ouvert (ou si le replay a expiré), tu peux écouter le vocal seul avec le bouton Lecture.

Les enregistrements sont dans `Documents\LoL Recorder`.

## Limites connues

- Un `.rofl` n'est lisible que sur le patch où la partie a été jouée (environ 2 semaines). L'audio, lui, reste.
- Discord chiffre les appels de bout en bout (DAVE) : c'est géré par `@discordjs/voice` 0.19.

## Développement

```
npm install
npm start                                   # lance l'app
npx tsx scripts/make-demo-session.ts <dossier>  # fausse partie pour tester le lecteur (ffmpeg requis)
npm test                                    # tests unitaires
npm run dist                                # installateur Windows dans release/
```

Outils en ligne de commande (même moteur que l'app) : `npm run record` (avec un `.env`, voir `.env.example`) et `npm run replay -- status | seek <s> | watch <gameId> | sync <dossier>`.

Chaque push sur `main` construit l'installateur via GitHub Actions et le publie dans les Releases.
