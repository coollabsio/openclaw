# Connect the OpenClaw Android app

The official Android app is a client of the gateway in this container. Host, port, TLS, and the gateway token belong in the app. Do not put `gateway.remote` into the container's `/data/.openclaw/openclaw.json`. This image sets `gateway.mode` to `local` and `gateway.auth.mode` to `token`.

Checked against OpenClaw **v2026.11.3** (`docs/cli/qr.md`, `docs/gateway/config-gateway.md`, `src/cli/qr-cli.ts`, `src/pairing/setup-code.ts`, `src/gateway/net.ts`, and `apps/android/Config/Version.properties`). The same `gateway.publicOrigin` fallback is in tag `v2026.10.10`. The published pages are https://docs.openclaw.ai/cli/qr and https://docs.openclaw.ai/gateway/config-gateway.

[Issue #118](https://github.com/coollabsio/openclaw/issues/118) is the Coolify case this page covers.

## Gateway address

Coolify serves the deployment on an HTTPS hostname and forwards to this container. nginx listens on `PORT`, default **8080**. `location /` proxies to `http://127.0.0.1:18789` (`OPENCLAW_GATEWAY_PORT`, default **18789**). That block sets `proxy_http_version 1.1`, `Upgrade`, and `Connection`, so a WebSocket upgrade reaches the gateway.

The Android address for that hostname is `wss://<your domain>` on port **443**. Port 443 is the default TLS port. `openclaw qr` drops a default port, so the printed URL has no `:443`. In the manual form, enter the hostname, port `443`, and TLS. Ports 8080 and 18789 stay inside the container.

| Where the container is reached | Address |
|---|---|
| Coolify, or any HTTPS reverse proxy, on the public internet | `wss://<your domain>` with no user and no token. TLS ends at the proxy, which forwards to container port 8080. |
| `docker run -p 8080:8080` on a LAN or localhost | `ws://<host>:8080`. The port is required. A public host must be `wss://`. |

`OPENCLAW_GATEWAY_TOKEN` is the gateway token. Generate it with `openssl rand -hex 32`. Coolify's service page says the template generates `AUTH_USERNAME`, `AUTH_PASSWORD`, and `OPENCLAW_GATEWAY_TOKEN` at deploy time. This image does not generate the token itself.

## Public URL with loopback bind

`configure.js` writes `gateway.bind` from `OPENCLAW_GATEWAY_BIND` only when `gateway.bind` is unset. The default is `loopback`, which listens on `127.0.0.1`. With no public pairing URL, `openclaw qr` fails with this error:

```text
Gateway is only bound to loopback. Set gateway.publicOrigin to your public HTTPS origin, configure plugins.entries.device-pair.config.publicUrl, enable tailscale serve, or set gateway.bind=lan.
```

Leave `gateway.bind` on `loopback`. This image has no dedicated env var for `gateway.publicOrigin`. Set the upstream key with the generic writers that already exist.

```bash
OPENCLAW__gateway__publicOrigin=https://your-host.example
```

```bash
OPENCLAW_CONFIG_JSON='{"gateway":{"publicOrigin":"https://your-host.example"}}'
```

Both are applied on every start, after the saved `openclaw.json` is merged. `OPENCLAW_CONFIG_JSON` is applied last, so it wins when both are set. A mounted file at `OPENCLAW_CUSTOM_CONFIG` (default `/app/config/openclaw.json`) can hold the same key. The saved config is merged on top of that file, and either env writer replaces the key again when it is set.

`gateway.publicOrigin` is an externally reachable HTTPS origin. It has no user, password, path, query, or fragment. OpenClaw accepts `http://` only for `localhost`, `127.0.0.1`, or `[::1]`. `https://your-host.example` is the pairing URL `wss://your-host.example`. An invalid value makes `openclaw qr` fail with `Configured gateway.publicOrigin is invalid.`

Restart after setting the variable. In a Coolify terminal, or with `docker exec`, `HOME` and `OPENCLAW_HOME` are `/data`. Leave `OPENCLAW_GATEWAY_URL` unset.

```bash
openclaw qr
```

One setup code, without a config change:

```bash
openclaw qr --url 'wss://your-host.example'
```

`--public-url` overrides the same field. When both flags are present, `--url` wins. A username or password in the URL is invalid, and the command fails with `Configured publicUrl is invalid.`

`openclaw qr` uses `gateway.publicOrigin` only after the earlier candidates are absent. Those candidates are `--url`, `plugins.entries.device-pair.config.publicUrl`, Tailscale Serve or Funnel, `gateway.remote.url`, and a non-loopback bind. With `gateway.bind` set to `lan`, the printed URL is the LAN address.

The error text also offers `gateway.bind=lan` and Tailscale Serve. `lan` listens on `0.0.0.0` inside the container, so traffic to that port skips nginx. This image's Dockerfiles do not install Tailscale. `gateway.tailscale.mode` set to `serve` or `funnel` makes QR setup run `tailscale status --json`. With no `tailscale` binary, that fails with `Tailscale Serve is enabled, but MagicDNS could not be resolved.` Leave the bind on loopback. Leave 18789 unpublished. Leave Tailscale mode unset.

`plugins.entries.device-pair.config.publicUrl` is the other key named in the error. It has no dedicated env var. Set it with the same dot-notation or JSON writers if you want that override instead of `gateway.publicOrigin`.

## HTTP basic auth

When `AUTH_PASSWORD` is set, nginx requires HTTP basic auth on `location /`, including the WebSocket. The gateway token is a separate credential. `configure.js` stores `OPENCLAW_GATEWAY_TOKEN` in `gateway.auth.token` and sets `gateway.auth.mode` to `token`.

In the Android form:

- **Gateway token** is `OPENCLAW_GATEWAY_TOKEN`.
- **Gateway password** is `gateway.auth.password`. Leave it empty. This image does not set password auth.
- Neither field is `AUTH_USERNAME` or `AUTH_PASSWORD`.

`openclaw qr --url` changes the address inside the setup code. The code carries a short-lived bootstrap token, not the nginx login. The phone still has to pass basic auth before the gateway accepts the upgrade. [Issue #118](https://github.com/coollabsio/openclaw/issues/118) reports a check against that deployment's public HTTPS endpoint. No basic login, or a wrong one, returned HTTP 401. The correct login returned HTTP 101. TLS verification passed on those requests.

A `Bearer` header does not skip basic auth on `/`. The bearer exception is a fixed list of Control UI paths, and it applies only when `Authorization` starts with `Bearer`. The gateway WebSocket is on `/`, so it keeps `auth_basic`.

Three other locations are separate from that exception:

- `/browser/` has its own `auth_basic "Openclaw"` block whenever `AUTH_PASSWORD` is set. It proxies to the browser sidecar at `browser:3000`. It is the VNC sidecar, and the bearer map does not apply to it.
- `/healthz` has no basic auth. It is the container health probe.
- The hooks location, when hooks are enabled, skips basic auth and forwards `Authorization` for the hooks token. The path is `hooks.path`, or `/hooks` when that value is empty. The Android gateway WebSocket stays on `/`.

Clearing `AUTH_PASSWORD` removes the challenge from `/`, from the WebSocket, and from `/browser/`. Leave `AUTH_PASSWORD` set so the Control UI and the browser sidecar stay behind the same login.

The Mac app has the same limit, and its own SSH transport. See [Connect the OpenClaw Mac app](mac-app.md).

## Official Android builds

No source tag checked for this page includes proxy basic login.

[PR 162247](https://github.com/openclaw/openclaw/pull/162247) adds `GatewayProxyAuth.kt` and a proxy-login form. GitHub reports the pull request open, with `merged` false, as of 2026-11-15. Its last update was 2026-11-04. The Coolify note on that PR is [this comment](https://github.com/openclaw/openclaw/pull/162247#issuecomment-6633347686).

`GatewayProxyAuth.kt` returns HTTP 404 on the default branch, on `v2026.10.10`, on `v2026.11.3`, and on the prerelease `v2026.11.5-beta.3`. Tag `v2026.11.3` records Android version name `2026.11.3` and version code `2026110301` in `apps/android/Config/Version.properties`. Both values come from that file in the tag.

[Issue 122215](https://github.com/openclaw/openclaw/issues/122215) is still open. It reports that Play build 2026.7.4 shows host, port, gateway token, password, and TLS, and has no custom-header field. A comment on 2026-10-04 reports client version `2026.9.60` with the same gap. Those reports describe the custom-header editor. The basic-login pull request is still unmerged.

Until that PR is merged and an official build contains it, the official app cannot send `AUTH_USERNAME` and `AUTH_PASSWORD`.

## Interim options

1. **Use the phone browser.** Open `https://<your domain>`. Sign in with `AUTH_USERNAME` and `AUTH_PASSWORD`, then enter `OPENCLAW_GATEWAY_TOKEN` in the Control UI. Approve the browser from inside the container:

   ```bash
   openclaw devices list
   openclaw devices approve <requestId>
   ```

   Leave `OPENCLAW_GATEWAY_URL` unset and do not pass `--url`. A URL on port 8080 or the public `wss://` address hits nginx and returns 401. `/browser/` stays on basic auth. This path opens the Control UI in the phone browser.

2. **Use the Mac app's SSH transport when the client is a Mac.** The steps are in [Connect the OpenClaw Mac app](mac-app.md). The Android manual form collects host, port, token, password, and TLS. Publishing **18789** does not reach the loopback listener. Docker delivers a published port to the container's other address, and the gateway is bound to `127.0.0.1` inside the container. Leave 18789 unpublished.

3. **Keep Tailscale off the gateway port.** This image does not install Tailscale or set `gateway.tailscale`. A tailnet client that opens the Coolify HTTPS URL still receives the nginx challenge. The builds checked above still have no field for that login. [Issue #118](https://github.com/coollabsio/openclaw/issues/118) calls out the VPN-switching tradeoff for a phone that already uses another VPN. Leave **18789** unpublished on the tailnet as well.

Approval commands are documented at https://docs.openclaw.ai/cli/devices and https://docs.openclaw.ai/gateway/pairing.
