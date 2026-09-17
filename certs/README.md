# certs/

Local HTTPS material for Twitch Local Test. **Nothing here is committed** —
`.gitignore` excludes the whole directory.

Generate it once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1
```

That writes `localhost.pem` and `localhost-key.pem`, which the `web` container
mounts read-only and Vite uses to serve `https://localhost:8080/`.

Twitch frames the extension, and a browser refuses to frame a page whose
certificate it does not trust — there is no "proceed anyway" for an iframe.
That is why this uses mkcert (which installs a locally trusted CA) rather than
a plain self-signed certificate.
