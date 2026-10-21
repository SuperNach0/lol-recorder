import { inviteUrl } from '../core/recorder-service.js';

export interface BotIdentity {
  applicationId: string;
  botName: string;
  ownerId?: string;
  inviteUrl: string;
}

/** Validates a bot token without opening a gateway connection. */
export async function checkToken(token: string): Promise<BotIdentity> {
  const res = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${token.trim()}` } });
  if (res.status === 401) throw new Error('Token invalide. Recopie-le depuis l’onglet Bot (bouton Reset Token).');
  if (!res.ok) throw new Error(`Discord a répondu ${res.status}`);
  const app = (await res.json()) as { id: string; name: string; owner?: { id: string }; team?: { owner_user_id: string } | null };
  return {
    applicationId: app.id,
    botName: app.name,
    ownerId: app.team?.owner_user_id ?? app.owner?.id,
    inviteUrl: inviteUrl(app.id),
  };
}
