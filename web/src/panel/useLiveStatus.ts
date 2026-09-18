import { useEffect, useState } from 'react';
import type { ExtAuth } from '../viewer/twitch';

/**
 * Is the channel live right now?
 *
 * A Panel is shown on the channel page whether or not there is a stream, and
 * the extension context carries no "live" flag. So this asks Twitch itself:
 * Get Streams with the extension's own `helixToken`
 * (`Authorization: Extension <helixToken>`), which Twitch documents for exactly
 * this kind of front-end call — Get Streams needs no scope. `api.twitch.tv` is
 * in every extension's default connect-src; nothing new is allow-listed.
 *
 * `unknown` until the first answer, and again whenever Twitch cannot be asked
 * (no helixToken in the local simulator, a network blip). Callers treat
 * unknown like offline for anything that matters: the Panel never sells.
 */
export type LiveStatus = 'live' | 'offline' | 'unknown';

const POLL_MS = 60_000;

export function useLiveStatus(auth: ExtAuth | null): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('unknown');
  const channelId = auth?.channelId ?? null;
  const clientId = auth?.clientId ?? null;
  const helixToken = auth?.helixToken ?? null;

  useEffect(() => {
    if (!channelId || !clientId || !helixToken) {
      setStatus('unknown');
      return;
    }
    let alive = true;
    const controller = new AbortController();

    const check = (): void => {
      fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(channelId)}`, {
        headers: { 'Client-Id': clientId, Authorization: `Extension ${helixToken}` },
        signal: controller.signal,
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ data?: Array<{ type?: string }> }>) : null))
        .then((body) => {
          if (!alive) return;
          if (!body) {
            setStatus('unknown');
            return;
          }
          setStatus(body.data?.some((s) => s.type === 'live') ? 'live' : 'offline');
        })
        .catch(() => {
          if (alive) setStatus('unknown');
        });
    };

    check();
    const id = window.setInterval(check, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
      controller.abort();
    };
  }, [channelId, clientId, helixToken]);

  return status;
}
