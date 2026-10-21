/**
 * Prototype: Discord bot that records every voice participant to separate
 * tracks, and (optionally) follows the League client to timestamp the game.
 *
 *   npm run record
 *
 * Slash commands: /record start, /record stop
 */
import 'dotenv/config';
import {
  ChannelType, Client, GatewayIntentBits, MessageFlags, SlashCommandBuilder,
  type ChatInputCommandInteraction, type VoiceBasedChannel,
} from 'discord.js';
import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { VoiceRecorder } from '../discord/voice-recorder.js';
import { createSession, saveSession, type SessionMeta } from '../session/session.js';
import { GameWatcher, downloadReplayWhenReady } from '../lol/game-watcher.js';
import { estimateGameStart } from '../lol/clock.js';
import type { LcuClient } from '../lol/lcu.js';

const token = required('DISCORD_TOKEN');
const guildId = required('DISCORD_GUILD_ID');
const ownerId = process.env.DISCORD_OWNER_ID;
const sessionsRoot = process.env.SESSIONS_DIR ?? 'sessions';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variable manquante : ${name} (voir .env.example)`);
    process.exit(1);
  }
  return value;
}

interface Recording {
  dir: string;
  meta: SessionMeta;
  recorder: VoiceRecorder;
  channel: VoiceBasedChannel;
}

let current: Recording | undefined;
let lcu: LcuClient | undefined;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const command = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Enregistrement du vocal pour LoL Recorder')
  .addSubcommand((s) => s.setName('start').setDescription('Rejoint ton salon vocal et enregistre'))
  .addSubcommand((s) => s.setName('stop').setDescription("Arrête l'enregistrement"));

client.once('clientReady', async () => {
  console.log(`Connecté en tant que ${client.user?.tag}`);
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([command.toJSON()]);
  console.log('Commandes /record enregistrées sur le serveur.');
  void startGameWatcher();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'record') return;
  try {
    if (interaction.options.getSubcommand() === 'start') await onStart(interaction);
    else await onStop(interaction);
  } catch (err) {
    console.error(err);
    const content = `Erreur : ${(err as Error).message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(content);
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});

async function onStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel) {
    await interaction.reply({ content: "Rejoins d'abord un salon vocal.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  await startRecording(channel);
  await interaction.editReply(recordingNotice(channel));
}

async function onStop(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!current) {
    await interaction.reply({ content: 'Aucun enregistrement en cours.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const dir = await stopRecording();
  await interaction.editReply(`Enregistrement terminé, sauvegardé dans \`${dir}\`.`);
}

function recordingNotice(channel: VoiceBasedChannel): string {
  return `🔴 Enregistrement du salon **${channel.name}** en cours (pour revoir nos games LoL avec le vocal). Les fichiers restent sur le PC de l'hôte. Dis-le si tu ne veux pas être enregistré.`;
}

async function startRecording(channel: VoiceBasedChannel): Promise<void> {
  if (current) await stopRecording();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const { dir, meta } = await createSession(sessionsRoot, { guildId: channel.guild.id, channelId: channel.id });
  const recorder = new VoiceRecorder(connection, dir, new Set([client.user!.id]));
  recorder.on('segment', (segment) => {
    meta.segments.push(segment);
    const m = channel.guild.members.cache.get(segment.userId);
    meta.speakers[segment.userId] ??= { userId: segment.userId, displayName: m?.displayName ?? segment.userId };
    void saveSession(dir, meta);
    console.log(`  segment ${meta.speakers[segment.userId]!.displayName} ${(segment.durationMs / 1000).toFixed(1)} s`);
  });
  current = { dir, meta, recorder, channel };
  console.log(`Enregistrement de #${channel.name} dans ${dir}`);
}

async function stopRecording(): Promise<string> {
  const rec = current!;
  current = undefined;
  await rec.recorder.stop();
  getVoiceConnection(rec.channel.guild.id)?.destroy();
  rec.meta.gameStartWallMs = estimateGameStart(rec.meta.clockSamples);
  await saveSession(rec.dir, rec.meta);
  console.log(`Session sauvegardée : ${rec.dir} (${rec.meta.segments.length} segments)`);
  return rec.dir;
}

/** Auto-start when the owner enters a lobby, and timestamp the game. */
async function startGameWatcher(): Promise<void> {
  const watcher = new GameWatcher();
  watcher.on('phase', (p) => console.log(`[LoL] phase : ${p}`));
  watcher.on('error', (err: Error) => console.warn(`[LoL] ${err.message}`));
  watcher.on('pregame', async () => {
    if (current || !ownerId) return;
    const guild = await client.guilds.fetch(guildId);
    const channel = (await guild.members.fetch(ownerId)).voice.channel;
    if (!channel) return;
    await startRecording(channel);
    const text = channel.type === ChannelType.GuildVoice ? channel : undefined;
    await text?.send(recordingNotice(channel)).catch(() => undefined);
  });
  watcher.on('game-start', (gameId?: number) => {
    console.log(`[LoL] partie ${gameId ?? '?'} commencée`);
    if (current) current.meta.gameId = gameId;
  });
  watcher.on('clock', (sample) => current?.meta.clockSamples.push(sample));
  watcher.on('game-end', async (gameId?: number) => {
    console.log(`[LoL] partie ${gameId ?? '?'} terminée`);
    if (current) {
      current.meta.gameStartWallMs = estimateGameStart(current.meta.clockSamples);
      await saveSession(current.dir, current.meta);
    }
    if (gameId && lcu) {
      const ok = await downloadReplayWhenReady(lcu, gameId);
      console.log(ok ? `[LoL] replay ${gameId} disponible` : `[LoL] replay ${gameId} non téléchargé`);
    }
  });
  try {
    lcu = await watcher.start();
    console.log('[LoL] client détecté, suivi des parties actif.');
  } catch (err) {
    console.warn(`[LoL] client introuvable (${(err as Error).message}). Le bot enregistre quand même avec /record.`);
  }
}

process.on('SIGINT', async () => {
  if (current) await stopRecording();
  await client.destroy();
  process.exit(0);
});

await client.login(token);
