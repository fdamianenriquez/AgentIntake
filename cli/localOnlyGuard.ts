import type { RequestHandler } from 'express';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  const match = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  return match ? match[1].toLowerCase() : '';
}

// Studio writes the user's API key to .env and spends their LLM quota, so it
// must only answer the user's own browser tab. Binding to 127.0.0.1 keeps
// other machines out; these two checks keep other *websites* out:
// - Host must be a loopback name, which defeats DNS rebinding (an attacker's
//   domain resolved to 127.0.0.1 still arrives with the attacker's Host).
// - Origin, when the browser sends one, must be Studio's own origin, so a page
//   on another site can't make cross-site calls to these routes.
export function localOnlyGuard(): RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host ?? '';
    if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) {
      res.status(403).json({ error: 'Studio only accepts requests addressed to localhost.' });
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      res.status(403).json({ error: 'Cross-origin requests to Studio are not allowed.' });
      return;
    }

    next();
  };
}
