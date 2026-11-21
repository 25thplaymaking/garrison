# Running Garrison behind a reverse proxy

Garrison controls Docker on your host, so put it behind HTTPS before you open it
to the internet. In `.env`:

```env
HOST=127.0.0.1               # only the proxy can reach the panel
TRUST_PROXY_HEADERS=true     # rate limits see the real client address
COOKIE_SECURE=auto           # Secure cookie on HTTPS requests
SITE_URL=https://panel.example.com
```

Then `docker compose up -d` again.

The proxy must pass WebSocket upgrades: the live console, the RCON console and
live status updates use them.

## Caddy

Caddy gets and renews the certificate for you.

```caddy
panel.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
```

Garrison only trusts `X-Forwarded-For` when `TRUST_PROXY_HEADERS=true`, and it
uses the last address in the header (the one your proxy added).
