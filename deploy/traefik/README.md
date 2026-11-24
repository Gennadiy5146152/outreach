# Outreach HTTPS ingress

The existing Timeweb server **Daring Woodpecker**, `213.171.10.147`, runs the
application on port 3000 and an existing Traefik proxy on ports 80/443.
`outreach.korotkov.dev` has an A record pointing to this server (TTL 600).
The apex domain, mail records and other applications are independent.

Install `outreach.yml` at `/etc/traefik/dynamic/outreach.yml`. The existing file
provider watches this directory, and its `letsEncrypt` resolver obtains and
renews the certificate. The global HTTP entry point redirects to HTTPS.
The web service joins the existing external `common-traefik` Docker network.
The proxy reaches it by its stable container name, so recreating the application
container does not invalidate the route. PostgreSQL and delivery workers remain
on their existing application network. Create `common-traefik` first when
bringing up this production Compose file on a new host.

After the certificate is valid, configure the application's server `.env`:

```dotenv
CABINET_PUBLIC_URL=https://outreach.korotkov.dev
CABINET_ALLOW_HTTP=false
AUTH_COOKIE_SECURE=true
TRUST_PROXY=172.18.0.8/32
```

`172.18.0.8` is the verified Traefik address on this host. Trust only that
proxy address, and update it if the proxy is recreated with a different address.
Do not trust forwarded headers from arbitrary clients. Recreate the web service
to apply environment changes; the normal deployment command also does this.
These settings enable secure cookies, HTTPS cabinet API checks and the canonical
email verification/recovery links. Existing delivery workers are unaffected.

Check `/api/health`, `/api/cabinet/auth/options`, the login page, HTTP-to-HTTPS
redirect and certificate hostname/expiration after deployment. Do not submit
signup/reset forms or send messages as part of a visual or ingress check.
