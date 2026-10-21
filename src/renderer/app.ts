import type { Api, PublicSettings, SessionListItem } from '../app/ipc-types.js';
import type { RecorderStatus } from '../core/recorder-service.js';
import type { Playback } from '../lol/game-client.js';
import type { SessionMeta } from '../session/session.js';
import { AudioEngine, type ClockState } from './audio-engine.js';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const view = document.getElementById('view')!;
const logLines: string[] = [];
let cleanupView: (() => void) | undefined;

// ---------- helpers ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'class') el.className = String(value);
    else if (key === 'style') el.setAttribute('style', String(value));
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

function fmtTime(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(Math.round(seconds));
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Electron prefixes errors from the main process; keep only the message. */
function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function show(render: () => (() => void) | void): void {
  cleanupView?.();
  cleanupView = undefined;
  view.replaceChildren();
  cleanupView = render() ?? undefined;
}

const SPEAKER_COLORS = ['#c8aa6e', '#0ac8b9', '#e84057', '#9b7bf7', '#3dd68c', '#f59e42', '#5b9cf5', '#f06bb0', '#a3d93c', '#7dd3fc'];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preference is just not remembered */
  }
}

// ---------- top bar ----------

let status: RecorderStatus = { discord: 'offline', lol: 'unknown' };
let recTimer: number | undefined;

function renderStatus(): void {
  const discord = document.getElementById('pill-discord')!;
  const labels: Record<RecorderStatus['discord'], [string, string]> = {
    online: [`Discord : ${status.botTag ?? 'connecté'}`, 'on'],
    connecting: ['Discord : connexion…', 'warn'],
    error: ['Discord : erreur', 'bad'],
    offline: ['Discord : hors ligne', ''],
  };
  const [dText, dClass] = labels[status.discord];
  discord.textContent = dText;
  discord.className = `pill ${dClass}`;
  discord.title = status.error ?? '';

  const lol = document.getElementById('pill-lol')!;
  if (status.lol === 'connected') {
    lol.textContent = `LoL : ${phaseLabel(status.phase)}`;
    lol.className = 'pill on';
  } else {
    lol.textContent = status.lol === 'not-running' ? 'LoL : client fermé' : 'LoL';
    lol.className = 'pill';
  }

  const rec = document.getElementById('rec')!;
  window.clearInterval(recTimer);
  if (status.recording) {
    const r = status.recording;
    const time = h('span');
    const tick = () => (time.textContent = fmtTime((Date.now() - r.startedAt) / 1000));
    tick();
    recTimer = window.setInterval(tick, 1000);
    rec.replaceChildren(
      h('span', { class: 'dot' }),
      h('span', {}, `#${r.channelName} · `, time, ` · ${r.segments} prises de parole`),
      h('button', { class: 'danger', onclick: () => api.stopRecording() }, 'Arrêter'),
    );
  } else {
    const msg = h('span', { class: 'muted' });
    rec.replaceChildren(
      msg,
      h(
        'button',
        {
          disabled: status.discord !== 'online',
          onclick: async () => {
            msg.textContent = '';
            const ok = await api.startRecording().catch((e) => ((msg.textContent = errorText(e)), true));
            if (!ok) msg.textContent = 'Rejoins un salon vocal sur Discord d’abord.';
          },
        },
        'Enregistrer mon salon vocal',
      ),
    );
  }
}

function phaseLabel(phase?: string): string {
  const labels: Record<string, string> = {
    None: 'accueil', Lobby: 'lobby', Matchmaking: 'file d’attente', ReadyCheck: 'partie trouvée', ChampSelect: 'sélection',
    GameStart: 'chargement', InProgress: 'en partie', WaitingForStats: 'fin de partie', PreEndOfGame: 'fin de partie', EndOfGame: 'fin de partie',
  };
  return labels[phase ?? ''] ?? phase ?? 'connecté';
}

// ---------- setup wizard ----------

function setupView(settings: PublicSettings): void {
  show(() => {
    const tokenInput = h('input', { type: 'password', placeholder: 'Colle ici le token du bot', autocomplete: 'off' });
    const tokenMsg = h('div');
    const inviteStep = h('div', { class: 'step' });
    const lolStep = h('div', { class: 'step' });
    let current = settings;

    const renderInvite = () => {
      inviteStep.replaceChildren(
        h('h2', {}, h('span', { class: 'num' }, '3'), 'Inviter le bot sur ton serveur'),
        current.inviteUrl
          ? h('div', {},
              h('p', { class: 'muted' }, 'Choisis le serveur où tu joues avec tes potes, puis valide. Il faut avoir le droit « Gérer le serveur ».'),
              h('button', { class: 'primary', onclick: () => api.openExternal(current.inviteUrl!) }, 'Inviter le bot'))
          : h('p', { class: 'muted' }, 'Disponible après l’étape 2.'),
      );
    };

    const renderLol = () => {
      const replay = current.replayApi;
      lolStep.replaceChildren(
        h('h2', {}, h('span', { class: 'num' }, '4'), 'League of Legends'),
        h('p', {}, 'Dossier : ', h('code', {}, current.lolDir), ' ', h('button', { class: 'link', onclick: async () => { current = await api.setLolDir(); renderLol(); } }, 'changer')),
        replay === undefined
          ? h('p', { class: 'error' }, 'Fichier Config\\game.cfg introuvable : vérifie le dossier (lance LoL une fois si besoin).')
          : replay
            ? h('p', { class: 'ok' }, '✓ Replay API activée.')
            : h('div', { class: 'row' },
                h('span', { class: 'muted' }, 'Il faut activer la Replay API pour synchroniser le son avec le replay.'),
                h('button', { class: 'primary', onclick: async () => { current = await api.enableReplayApi(); renderLol(); } }, 'Activer')),
      );
    };

    renderInvite();
    renderLol();

    view.append(
      h('div', { class: 'wizard' },
        h('h1', {}, settings.configured ? 'Réglages' : 'Bienvenue'),
        h('p', { class: 'muted' }, 'LoL Recorder utilise ton propre bot Discord pour enregistrer le vocal. On le crée une seule fois, ça prend 2 minutes.'),
        h('div', { class: 'step' },
          h('h2', {}, h('span', { class: 'num' }, '1'), 'Créer le bot'),
          h('ol', {},
            h('li', {}, 'Ouvre le portail développeur Discord et clique sur ', h('b', {}, 'New Application'), '. Nomme-la par exemple « LoL Recorder ».'),
            h('li', {}, 'Va dans l’onglet ', h('b', {}, 'Bot'), ', clique sur ', h('b', {}, 'Reset Token'), ' puis copie le token.'),
          ),
          h('p', {}, h('button', { onclick: () => api.openExternal('https://discord.com/developers/applications') }, 'Ouvrir le portail Discord')),
        ),
        h('div', { class: 'step' },
          h('h2', {}, h('span', { class: 'num' }, '2'), 'Coller le token'),
          settings.configured && h('p', { class: 'ok' }, `✓ Bot configuré : ${settings.botName ?? ''}. Colle un nouveau token pour le remplacer.`),
          h('div', { class: 'row' },
            tokenInput,
            h('button', {
              class: 'primary',
              onclick: async () => {
                tokenMsg.className = 'muted';
                tokenMsg.textContent = 'Vérification…';
                try {
                  current = await api.saveToken(tokenInput.value);
                  tokenInput.value = '';
                  tokenMsg.className = 'ok';
                  tokenMsg.textContent = `✓ Bot « ${current.botName} » reconnu. Le token est chiffré sur ce PC.`;
                  renderInvite();
                } catch (e) {
                  tokenMsg.className = 'error';
                  tokenMsg.textContent = errorText(e);
                }
              },
            }, 'Vérifier'),
          ),
          tokenMsg,
        ),
        inviteStep,
        lolStep,
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'primary', onclick: async () => { if ((await api.getSettings()).configured) listView(); else tokenMsg.textContent = 'Colle d’abord le token du bot.'; } }, 'Terminer'),
        ),
      ),
    );
  });
}

// ---------- session list ----------

function sessionTitle(meta: SessionMeta): string {
  if (meta.game?.championName) return meta.game.championName;
  return meta.gameId ? `Partie ${meta.gameId}` : 'Session vocale';
}

function listView(): void {
  show(() => {
    const cards = h('div', { class: 'cards' });
    const banner = h('div');
    const log = h('div', { class: 'log' }, logLines.join('\n'));

    const refresh = async () => {
      const [items, settings] = await Promise.all([api.listSessions(), api.getSettings()]);
      banner.replaceChildren(
        settings.replayApi === false
          ? h('div', { class: 'banner' }, h('span', {}, 'La Replay API de LoL n’est pas activée : le son ne pourra pas suivre le replay.'), h('button', { onclick: async () => { await api.enableReplayApi(); void refresh(); } }, 'Activer'))
          : '',
      );
      cards.replaceChildren(...(items.length ? items.map(card) : [h('div', { class: 'empty' },
        h('h2', {}, 'Aucune partie enregistrée'),
        h('p', {}, 'Laisse l’app ouverte : dès que tu entres en lobby, le bot rejoint ton salon vocal et enregistre.'),
        h('p', {}, 'Tu peux aussi lancer ', h('code', {}, '/record start'), ' dans Discord.'))]));
    };

    const card = ({ meta, replayState }: SessionListItem) => {
      const g = meta.game;
      const speakers = Object.values(meta.speakers).map((s) => s.displayName).join(', ') || 'personne n’a parlé';
      const date = new Date(meta.createdAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      const bits = [
        date,
        g?.gameLengthS ? fmtTime(g.gameLengthS) : '',
        g?.kills !== undefined ? `${g.kills}/${g.deaths}/${g.assists}` : '',
        meta.channelName ? `#${meta.channelName}` : '',
      ].filter(Boolean);
      const replay =
        replayState === 'watch' ? 'Replay prêt'
        : replayState === 'download' ? 'Replay à télécharger'
        : replayState === 'downloading' ? 'Téléchargement…'
        : replayState === 'missingOrExpired' || replayState === 'incompatible' ? 'Replay expiré : audio seul'
        : meta.gameId ? 'Ouvre LoL pour voir le replay' : '';
      return h('div', { class: `card ${g?.win === true ? 'win' : g?.win === false ? 'loss' : ''}` },
        h('div', { class: 'bar' }),
        h('div', {},
          h('div', { class: 'title' }, sessionTitle(meta), g?.win !== undefined ? h('span', { class: 'muted' }, g.win ? ' · Victoire' : ' · Défaite') : ''),
          h('div', { class: 'meta' }, bits.join(' · ')),
          h('div', { class: 'meta' }, `🎙 ${speakers}`, replay ? ` · ${replay}` : ''),
        ),
        h('div', { class: 'actions' },
          replayState === 'download' && !!meta.gameId && h('button', { onclick: async () => { await api.downloadReplay(meta.gameId!).catch(() => undefined); setTimeout(refresh, 2000); } }, 'Télécharger'),
          h('button', { class: 'primary', disabled: meta.segments.length === 0, onclick: () => playerView(meta.id, replayState) }, 'Revoir'),
        ),
      );
    };

    view.append(
      h('div', { class: 'wrap' },
        h('div', { class: 'list-head' },
          h('h1', {}, 'Mes parties'),
          h('div', { class: 'spacer' }),
          h('button', { onclick: () => api.openSessionsFolder() }, 'Ouvrir le dossier'),
          h('button', { onclick: async () => setupView(await api.getSettings()) }, 'Réglages'),
        ),
        banner,
        cards,
        h('details', {}, h('summary', {}, 'Journal'), log),
      ),
    );

    void refresh();
    const offSessions = api.onSessionsChanged(() => void refresh());
    const offLog = api.onLog(() => (log.textContent = logLines.join('\n')));
    const offStatus = api.onStatus(() => void 0);
    return () => {
      offSessions();
      offLog();
      offStatus();
    };
  });
}

// ---------- player ----------

function playerView(sessionId: string, replayState?: string): void {
  show(() => {
    let disposed = false;
    let engine: AudioEngine | undefined;
    let raf = 0;
    const offs: (() => void)[] = [];

    // Two clock sources: the League replay when it runs, otherwise a local clock.
    let replay: { playback: Playback; at: number } | undefined;
    const local = { base: 0, startedAt: 0, playing: false };
    const localTime = () => local.base + (local.playing ? (performance.now() - local.startedAt) / 1000 : 0);
    const clock = (): ClockState & { source: 'replay' | 'local' } => {
      if (replay) {
        const p = replay.playback;
        const elapsed = p.paused || p.seeking ? 0 : ((performance.now() - replay.at) / 1000) * p.speed;
        return { time: p.time + elapsed, paused: p.paused || p.seeking, speed: p.speed, source: 'replay' };
      }
      return { time: localTime(), paused: !local.playing, speed: 1, source: 'local' };
    };

    const seek = (time: number) => {
      if (replay) void api.seekReplay(Math.max(0, time));
      else {
        local.base = time;
        local.startedAt = performance.now();
      }
    };

    const togglePlay = () => {
      if (replay) void api.setReplayPaused(!replay.playback.paused);
      else {
        local.base = localTime();
        local.startedAt = performance.now();
        local.playing = !local.playing;
      }
    };

    const root = h('div', { class: 'wrap' }, h('p', { class: 'muted' }, 'Chargement…'));
    view.append(root);

    void api.getSession(sessionId).then((meta) => {
      if (disposed) return;
      // Voice-only session (no game clock): time 0 is the start of the recording.
      if (meta.gameStartWallMs === undefined) meta.gameStartWallMs = Math.min(Date.parse(meta.createdAt), ...meta.segments.map((s) => s.startWallMs));
      const hasGameClock = meta.clockSamples.length > 0;
      engine = new AudioEngine(meta);
      engine.master = load('volume:master', 1);

      const starts = meta.segments.map((s) => (s.startWallMs - meta.gameStartWallMs!) / 1000);
      const ends = meta.segments.map((s, i) => starts[i]! + s.durationMs / 1000);
      const tMin = Math.min(0, ...starts) - 2;
      let tMax = Math.max(meta.game?.gameLengthS ?? 0, ...ends) + 2;
      local.base = Math.max(tMin, Math.min(0, ...starts));
      const pct = (t: number) => `${((t - tMin) / (tMax - tMin)) * 100}%`;

      const speakerIds = [...new Set(meta.segments.map((s) => s.userId))];
      const color = new Map(speakerIds.map((id, i) => [id, SPEAKER_COLORS[i % SPEAKER_COLORS.length]!]));
      const segEls: { el: HTMLElement; userId: string; start: number; end: number }[] = [];

      const trackClick = (e: MouseEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        seek(tMin + ((e.clientX - rect.left) / rect.width) * (tMax - tMin));
      };

      const lanes = speakerIds.map((userId) => {
        const name = meta.speakers[userId]?.displayName ?? userId;
        const vol = load(`volume:${userId}`, 1);
        engine!.setVolume(userId, vol);
        const who = h('div', { class: 'who' });
        const muteBtn = h('button', {}, 'Muet');
        muteBtn.addEventListener('click', () => {
          engine!.setMuted(userId, !engine!.isMuted(userId));
          who.classList.toggle('muted', engine!.isMuted(userId));
          muteBtn.textContent = engine!.isMuted(userId) ? 'Activer' : 'Muet';
        });
        who.append(
          h('span', { class: 'name', style: `color:${color.get(userId)}` }, name),
          muteBtn,
          h('input', { type: 'range', min: 0, max: 1.5, step: 0.05, value: vol, title: 'Volume', oninput: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            engine!.setVolume(userId, v);
            store(`volume:${userId}`, v);
          } }),
        );
        const track = h('div', { class: 'track', onclick: trackClick });
        meta.segments.forEach((s, i) => {
          if (s.userId !== userId) return;
          const el = h('div', { class: 'seg', style: `left:${pct(starts[i]!)};width:calc(${pct(ends[i]!)} - ${pct(starts[i]!)});background:${color.get(userId)}` });
          segEls.push({ el, userId, start: starts[i]!, end: ends[i]! });
          track.append(el);
        });
        return h('div', { class: 'lane' }, who, track);
      });

      const ruler = h('div', { class: 'ruler' });
      const renderRuler = () => {
        const marks: Node[] = [];
        const step = tMax - tMin > 1800 ? 300 : tMax - tMin > 600 ? 120 : 60;
        for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
          marks.push(h('span', { class: t === 0 ? 'zero' : '', style: `left:${pct(t)}` }, t === 0 && hasGameClock ? '0:00 début' : fmtTime(t)));
        }
        ruler.replaceChildren(...marks);
      };
      const relayout = () => {
        for (const s of segEls) {
          s.el.style.left = pct(s.start);
          s.el.style.width = `calc(${pct(s.end)} - ${pct(s.start)})`;
        }
        pregame.style.width = pct(0);
        renderRuler();
      };

      const playhead = h('div', { class: 'playhead' });
      const pregame = h('div', { class: 'pregame', style: `width:${pct(0)}`, title: 'Avant la partie (sélection, chargement)' });
      const clockEl = h('div', { class: 'clock' }, '0:00');
      const sourceEl = h('div', { class: 'source muted' });
      const playBtn = h('button', { class: 'primary', onclick: togglePlay }, 'Lecture');
      const replayMsg = h('span', { class: 'muted' });
      const launchBtn = h('button', {
        disabled: !meta.gameId || replayState === 'missingOrExpired' || replayState === 'incompatible',
        onclick: async () => {
          replayMsg.textContent = 'Ouverture du replay dans League…';
          try {
            if (replayState === 'download') await api.downloadReplay(meta.gameId!);
            await api.watchReplay(meta.gameId!);
            replayMsg.textContent = 'Le replay se lance. Le son suivra automatiquement.';
          } catch (e) {
            replayMsg.textContent = errorText(e);
          }
        },
      }, 'Lancer le replay LoL');

      root.replaceChildren(
        h('div', { class: 'player-head' },
          h('button', { onclick: listView }, '← Retour'),
          h('div', {},
            h('h1', {}, sessionTitle(meta)),
            h('div', { class: 'muted' }, new Date(meta.createdAt).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })),
          ),
          h('div', { class: 'spacer' }),
          launchBtn,
        ),
        h('div', { class: 'transport' },
          playBtn,
          h('div', {}, clockEl, sourceEl),
          h('div', { style: 'flex:1' }, replayMsg),
          h('label', { class: 'muted' }, 'Volume ',
            h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: engine.master, oninput: (e: Event) => {
              engine!.master = Number((e.target as HTMLInputElement).value);
              store('volume:master', engine!.master);
            } })),
        ),
        h('div', { class: 'timeline' },
          ruler,
          h('div', { class: 'playhead-layer' },
            ...lanes,
            h('div', { style: 'position:absolute;top:0;bottom:0;left:212px;right:0;pointer-events:none' }, pregame, playhead),
          ),
        ),
        hasGameClock ? '' : h('p', { class: 'muted' }, 'Pas d’horloge de partie pour cette session : lecture du vocal seul, depuis le début de l’enregistrement.'),
      );
      renderRuler();

      offs.push(api.onPlayback((p) => {
        replay = p ? { playback: p, at: performance.now() } : undefined;
        if (p && p.length + 2 > tMax) {
          tMax = p.length + 2;
          relayout();
        }
      }));
      void api.followReplay(true);

      let lastTalking = '';
      const frame = () => {
        if (disposed) return;
        const c = clock();
        if (c.source === 'local' && local.playing && c.time > tMax) togglePlay();
        const talking = engine!.tick(c);
        clockEl.textContent = fmtTime(c.time);
        sourceEl.textContent = c.source === 'replay' ? `Synchronisé sur le replay${c.speed !== 1 ? ` · x${c.speed}` : ''}` : 'Lecture locale (pas de replay ouvert)';
        playBtn.textContent = c.paused ? 'Lecture' : 'Pause';
        playhead.style.left = pct(c.time);
        const key = [...talking].join();
        if (key !== lastTalking) {
          lastTalking = key;
          for (const s of segEls) s.el.classList.remove('talking');
        }
        for (const s of segEls) if (talking.has(s.userId) && c.time >= s.start && c.time < s.end) s.el.classList.add('talking');
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      engine?.stop();
      offs.forEach((off) => off());
      window.removeEventListener('keydown', onKey);
      void api.followReplay(false);
    };
  });
}

// ---------- boot ----------

api.onStatus((s) => {
  status = s;
  renderStatus();
});
api.onLog((line) => {
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
});

void (async () => {
  status = await api.getStatus();
  renderStatus();
  const settings = await api.getSettings();
  if (settings.configured) listView();
  else setupView(settings);
})();
