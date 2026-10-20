# Connect the OpenClaw Mac app

The Mac app is a client of the gateway in this container. Its connection settings belong on the Mac, in the app's own config (`~/.openclaw/openclaw.json` on that Mac, or the Connection window). Do not put `gateway.remote` into the container's `/data/.openclaw/openclaw.json`. This image sets the container gateway to `gateway.mode` `local` and `gateway.auth.mode` `token`.

Checked against OpenClaw **v2026.10.5** (`docs/platforms/mac/remote.md`, `docs/cli/devices.md`, `docs/gateway/pairing.md`, and the Mac app sources `GatewayRemoteConfig.swift`, `ConnectionModeResolver.swift`, and `PrimaryGatewayControlConfiguration.swift`). Docs: https://docs.openclaw.ai/platforms/mac/remote

[Issue #20](https://github.com/coollabsio/openclaw/issues/20) suggested this container edit:

```json
{
  "gateway": {
    "mode": "local",
    "remote": {
      "token": "<gateway token>",
      "transport": "direct",
      "url": "wss://AUTH_USERNAME:AUTH_PASSWORD@your-host"
    }
  }
}
```

That is not how v2026.10.5 connects.

- `gateway.mode` `local` means this Mac runs the gateway. `ConnectionModeResolver` stops there and does not use `gateway.remote`. The container is the gateway, so the Mac's mode is `remote`.
- The gateway token is `gateway.remote.token`, a separate field. It is not accepted in the URL. The `openclaw://gateway/add` link rejects a token, a password, URL userinfo, a query, and a fragment. Putting the token in the address is the failure the issue ran into.
- The supported direct-URL writer (`openclaw-mac primary set --direct-url`, and the same check in the app) rejects a URL that has a username, a password, a query, or a fragment. `wss://user:password@host` is an invalid direct URL. `gateway.remote.password` is the gateway's own password auth, not this image's HTTP basic auth.
- A `ws://` URL with no port is rewritten to port **18789**. This image does not publish 18789. nginx listens on **8080** (or Coolify's HTTPS proxy in front of 8080).

## Gateway URL and token

In the menu bar, choose **Connection…**, then **Remote (another host)**. Paste the gateway address and type `OPENCLAW_GATEWAY_TOKEN` into **Gateway token**. Leave **Gateway password** empty. This image writes token auth, not password auth.

Or, from the Mac:

```bash
openclaw-mac primary set \
  --direct-url 'wss://your-host.example.com' \
  --token-file /path/to/gateway-token
```

That writes `gateway.mode` `remote`, `gateway.remote.transport` `direct`, `gateway.remote.url`, and `gateway.remote.token`.

| Where the container is reached | Address to paste |
|---|---|
| Coolify (or any HTTPS reverse proxy) on the public internet | `wss://<your domain>` with no port, user, or token. TLS ends at the proxy, which forwards to container port 8080. |
| `docker run -p 8080:8080` on a LAN or localhost | `ws://<host>:8080`. The port is required. `ws://` is only accepted for localhost, private and link-local addresses, `.local`, and Tailscale. A public host must be `wss://`. |

`OPENCLAW_GATEWAY_TOKEN` is the same value the container requires at startup. Generate it with `openssl rand -hex 32`.

## HTTP basic auth

When `AUTH_PASSWORD` is set, nginx requires HTTP basic auth on `/` and on the WebSocket. It does not skip that check for a `Bearer` token on those routes. The Mac app's direct URL cannot carry `AUTH_USERNAME` / `AUTH_PASSWORD`, so the upgrade gets `401` before the gateway sees the token.

Use one of these:

1. **Direct `wss://` or `ws://` with no basic auth.** Leave `AUTH_PASSWORD` unset. nginx does not challenge the WebSocket. The gateway token and device approval still apply. The Control UI is then reachable without a browser password. Anyone who can open the URL still needs the token, and a new device still has to be approved.
2. **SSH to the Docker host, with the gateway port only on loopback.** Publish `127.0.0.1:18789:18789` on the host (not `0.0.0.0`). In the Mac app choose the SSH transport, set the SSH target to a user on that host, set the remote gateway port to `18789`, and pass the gateway token in the token field. Do not publish 18789 on a public interface. That port is the gateway itself and skips nginx. Coolify's proxy does not forward 18789 unless you add this mapping.

The browser Control UI keeps working with `AUTH_PASSWORD` set. Sign in at `https://<your domain>` or `http://localhost:8080`, enter the gateway token, and approve the browser with the commands below. That path is separate from the Mac app.

## Approve the Mac

The first connection creates a device pairing request. Pending requests expire about five minutes after the device stops retrying. A device that keeps reconnecting keeps one `requestId`. If it retries with a new key or different scopes, the id changes. List again immediately before you approve.

In a Coolify terminal, or with `docker exec`, `OPENCLAW_GATEWAY_TOKEN` is already set and `HOME` / `OPENCLAW_HOME` are `/data`. Leave `OPENCLAW_GATEWAY_URL` unset and do not pass `--url`. The CLI then uses `ws://127.0.0.1:18789` and reads `/data/.openclaw/openclaw.json`. `--url` aimed at port 8080 or the public `wss://` address hits nginx basic auth and returns `401`.

```bash
openclaw devices list
openclaw devices approve <requestId>
```

`openclaw devices approve` with no id, or with `--latest`, only prints the newest request and exits 1. Pass the id from `openclaw devices list`.

Approving the device lets the Mac connect. A Mac that also acts as a node has a second request for its command surface. The two ids are not interchangeable. On the same gateway:

```bash
openclaw nodes pending
openclaw nodes approve <nodeRequestId>
```

Docs: https://docs.openclaw.ai/cli/devices and https://docs.openclaw.ai/gateway/pairing

The paired device is stored in `/data/.openclaw/state/openclaw.sqlite` (`device_pairing_paired`), which is on the volume. See [Back up and restore `/data`](backup-restore.md).
