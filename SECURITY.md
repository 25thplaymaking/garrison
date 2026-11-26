# Security

Garrison controls Docker on the host it runs on, so treat the panel like root
access to that machine:

- Put it behind HTTPS (see `docs/reverse-proxy.md`) and use strong passwords.
- Keep `.env` private. Never commit it or paste `JWT_SECRET`, `MONGO_PASSWORD`
  or API keys anywhere public. If one leaks, change it and restart the panel.
- Never open the RCON ports in your firewall; Garrison binds them to 127.0.0.1.

## Reporting a problem

Please report security problems privately through GitHub's
**Security → Report a vulnerability** on this repository, not in a public issue.
Include what you found and how to reproduce it, without real passwords, keys
or server addresses.
