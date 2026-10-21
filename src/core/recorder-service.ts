import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import {
  ChannelType, Client, GatewayIntentBits, MessageFlags, SlashCommandBuilder, Team,
  type ChatInputCommandInteraction, type Guild, type VoiceBasedChannel,
} from 'discord.js';
import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { VoiceRecorder } from '../discord/voice-recorder.js';
import { createSession, saveSession, type GameSummary, type SessionMeta } from '../session/session.js';
import { GameWatcher, downloadReplayWhenReady } from '../lol/game-watcher.js';
import { estimateGameStart } from '../lol/clock.js';
import type { LcuClient } from '../lol/lcu.js';

export interface RecorderConfig {
  token: string;
  sessionsRoot: string;
  /** Discord user whose voice channel is joined automatically. Defaults to the bot's owner. */
  ownerId?: string;
  lockfile?: string;
}

export interface RecorderStatus {
  discord: 'offline' | 'connecting' | 'online' | 'error';
  botTag?: string;
  lol: 'unknown' | 'not-running' | 'connected';
  phase?: string;
  recording?: { sessionId: string; channelName: string; guildName: string; startedAt: number; segments: number };
  error?: string;
}

/** Permissions the bot needs: View Channel, Send Messages, Connect, Speak. */
export const BOT_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 20n) | (1n << 21n);

export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
}

interface Recording {
  dir: string;
  meta: SessionMeta;
  recorder: VoiceRecorder;
  channel: VoiceBasedChannel;
  startedAt: number;
}

const command = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Enregistrement du vocal pour LoL Recorder')
  .addSubcommand((s) => s.setName('start').setDescription('Rejoint ton salon vocal et enregistre'))
  .addSubcommand((s) => s.setName('stop').setDescription("Arrête l'enregistrement"));

/**
 * Runs the Discord bot and the League client watcher. Emits:
 * - `status` (RecorderStatus) whenever something visible changes
 * - `log` (string)
 * - `session` (dir: string) when a session file was written
 */
export class RecorderService extends EventEmitter {
  private client: Client | undefined;
  private watcher: GameWatcher | undefined;
  private lcu: LcuClient | undefined;
  private current: Recording | undefined;
  private ownerId: string | undefined;
  private state: RecorderStatus = { discord: 'offline', lol: 'unknown' };
  private lolRetry: NodeJS.Timeout | undefined;

  constructor(private readonly config: RecorderConfig) {
    super();
  }

  get status(): RecorderStatus {
    const rec = this.current;
    return {
      ...this.state,
      recording: rec && {
        sessionId: rec.meta.id,
        channelName: rec.channel.name,
        guildName: rec.channel.guild.name,
        startedAt: rec.startedAt,
        segments: rec.meta.segments.length,
      },
    };
  }

  private update(patch: Partial<RecorderStatus>): void {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.status);
  }

  private log(message: string): void {
    this.emit('log', message);
  }

  async start(): Promise<void> {
    this.update({ discord: 'connecting', error: undefined });
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client = client;
    client.on('interactionCreate', (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'record') void this.onCommand(interaction);
    });
    client.on('guildCreate', (guild) => void this.registerCommands(guild));
    client.once('clientReady', async () => {
      this.update({ discord: 'online', botTag: client.user?.tag });
      this.log(`Bot connecté : ${client.user?.tag}`);
      this.ownerId = this.config.ownerId ?? (await this.applicationOwner());
      for (const guild of client.guilds.cache.values()) await this.registerCommands(guild);
    });
    try {
      await client.login(this.config.token);
    } catch (err) {
      this.update({ discord: 'error', error: (err as Error).message });
      throw err;
    }
    this.startGameWatcher();
  }

  async stop(): Promise<void> {
    if (this.lolRetry) clearTimeout(this.lolRetry);
    this.watcher?.stop();
    if (this.current) await this.stopRecording();
    await this.client?.destroy();
    this.update({ discord: 'offline' });
  }

  guilds(): { id: string; name: string }[] {
    return [...(this.client?.guilds.cache.values() ?? [])].map((g) => ({ id: g.id, name: g.name }));
  }

  applicationId(): string | undefined {
    return this.client?.application?.id;
  }

  private async applicationOwner(): Promise<string | undefined> {
    const app = await this.client!.application!.fetch();
    return app.owner instanceof Team ? app.owner.ownerId ?? undefined : app.owner?.id;
  }

  private async registerCommands(guild: Guild): Promise<void> {
    await guild.commands.set([command.toJSON()]).catch((e: Error) => this.log(`Commandes non enregistrées sur ${guild.name} : ${e.message}`));
  }

  /** Starts recording the voice channel the owner is in. */
  async startForOwner(): Promise<boolean> {
    const channel = await this.findOwnerChannel();
    if (!channel) return false;
    await this.startRecording(channel);
    return true;
  }

  private async findOwnerChannel(): Promise<VoiceBasedChannel | undefined> {
    if (!this.client || !this.ownerId) return undefined;
    for (const guild of this.client.guilds.cache.values()) {
      const member = await guild.members.fetch(this.ownerId).catch(() => undefined);
      if (member?.voice.channel) return member.voice.channel;
    }
    return undefined;
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      if (interaction.options.getSubcommand() === 'start') {
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        const channel = member.voice.channel;
        if (!channel) {
          await interaction.reply({ content: "Rejoins d'abord un salon vocal.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply();
        await this.startRecording(channel, false);
        await interaction.editReply(recordingNotice(channel));
      } else {
        if (!this.current) {
          await interaction.reply({ content: 'Aucun enregistrement en cours.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply();
        await this.stopRecording();
        await interaction.editReply('Enregistrement terminé.');
      }
    } catch (err) {
      this.log(`Erreur /record : ${(err as Error).message}`);
      const content = `Erreur : ${(err as Error).message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => undefined);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }

  async startRecording(channel: VoiceBasedChannel, announce = true): Promise<void> {
    if (this.current) await this.stopRecording();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      debug: true,
    });
    const { dir, meta } = await createSession(this.config.sessionsRoot, { guildId: channel.guild.id, channelId: channel.id });
    // Voice/encryption diagnostics, kept with the session so a failed recording can be investigated.
    const debugLog = createWriteStream(join(dir, 'debug.log'), { flags: 'a' });
    connection.on('debug', (message) => {
      if (!/"op":\s*[36]\b/.test(message)) debugLog.write(`${new Date().toISOString()} ${message}\n`);
    });
    connection.once(VoiceConnectionStatus.Destroyed, () => debugLog.end());
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    meta.channelName = channel.name;
    const recorder = new VoiceRecorder(connection, dir, new Set([this.client!.user!.id]));
    recorder.on('warn', (message: string) => {
      debugLog.write(`${new Date().toISOString()} ${message}\n`);
      this.log(message);
    });
    recorder.on('segment', (segment) => {
      meta.segments.push(segment);
      const m = channel.guild.members.cache.get(segment.userId);
      meta.speakers[segment.userId] ??= { userId: segment.userId, displayName: m?.displayName ?? segment.userId };
      void this.save(dir, meta);
      this.update({});
    });
    this.current = { dir, meta, recorder, channel, startedAt: Date.now() };
    await this.save(dir, meta);
    this.log(`Enregistrement de #${channel.name} (${channel.guild.name})`);
    this.update({});
    if (announce && channel.type === ChannelType.GuildVoice) await channel.send(recordingNotice(channel)).catch(() => undefined);
  }

  async stopRecording(): Promise<void> {
    const rec = this.current;
    if (!rec) return;
    this.current = undefined;
    await rec.recorder.stop();
    getVoiceConnection(rec.channel.guild.id)?.destroy();
    rec.meta.gameStartWallMs = estimateGameStart(rec.meta.clockSamples);
    rec.meta.endedAt = new Date().toISOString();
    await this.save(rec.dir, rec.meta);
    this.log(`Enregistrement terminé : ${rec.meta.segments.length} prises de parole`);
    this.update({});
  }

  private async save(dir: string, meta: SessionMeta): Promise<void> {
    await saveSession(dir, meta);
    this.emit('session', dir);
  }

  private startGameWatcher(): void {
    const watcher = new GameWatcher(this.config.lockfile);
    this.watcher = watcher;
    watcher.on('phase', (phase: string) => this.update({ phase }));
    watcher.on('error', (err: Error) => this.log(`LoL : ${err.message}`));
    watcher.on('close', () => {
      this.update({ lol: 'not-running', phase: undefined });
      this.retryGameWatcher();
    });
    watcher.on('pregame', () => {
      if (this.current) return;
      void this.startForOwner().catch((e: Error) => this.log(`Démarrage auto impossible : ${e.message}`));
    });
    watcher.on('game-start', (gameId?: number) => {
      this.log(`Partie ${gameId ?? '?'} commencée`);
      if (this.current) this.current.meta.gameId = gameId;
    });
    watcher.on('clock', (sample) => this.current?.meta.clockSamples.push(sample));
    watcher.on('summary', (gameId: number | undefined, summary: GameSummary) => {
      const rec = this.current;
      if (rec && rec.meta.gameId === gameId) {
        rec.meta.game = summary;
        void this.save(rec.dir, rec.meta);
      }
    });
    watcher.on('game-end', async (gameId?: number) => {
      this.log(`Partie ${gameId ?? '?'} terminée`);
      if (this.current) {
        this.current.meta.gameStartWallMs = estimateGameStart(this.current.meta.clockSamples);
        await this.save(this.current.dir, this.current.meta);
      }
      if (gameId && this.lcu) {
        const ok = await downloadReplayWhenReady(this.lcu, gameId, (m) => this.log(m));
        this.log(ok ? `Replay ${gameId} téléchargé` : `Replay ${gameId} non téléchargé`);
      }
    });
    watcher
      .start()
      .then((lcu) => {
        this.lcu = lcu;
        this.update({ lol: 'connected' });
      })
      .catch(() => {
        this.update({ lol: 'not-running' });
        this.retryGameWatcher();
      });
  }

  /** The League client may be started after us, or restarted: look for it again. */
  private retryGameWatcher(): void {
    if (this.lolRetry || this.state.discord === 'offline') return;
    this.lolRetry = setTimeout(() => {
      this.lolRetry = undefined;
      this.watcher?.removeAllListeners();
      this.watcher?.stop();
      this.startGameWatcher();
    }, 10_000);
  }
}

function recordingNotice(channel: VoiceBasedChannel): string {
  return `🔴 Enregistrement du salon **${channel.name}** en cours (pour revoir nos games LoL avec le vocal). Les fichiers restent sur le PC de l'hôte. Dis-le si tu ne veux pas être enregistré.`;
}
