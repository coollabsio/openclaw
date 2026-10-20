# Back up and restore `/data`

`/data` is the only directory that survives a new container. The image sets `HOME` and `OPENCLAW_HOME` to `/data`, so OpenClaw state is `/data/.openclaw` rather than `/root/.openclaw`.

This page is the answer to [how to back up `/data`](https://github.com/coollabsio/openclaw/issues/71).

## What is on the volume

| Path | What it is |
|---|---|
| `/data/.openclaw/openclaw.json` | Gateway config, including `gateway.auth.token` from `OPENCLAW_GATEWAY_TOKEN`. |
| `/data/.openclaw/openclaw.extra.json` | Unrecognized top-level keys parked so `openclaw.json` stays valid. The gateway does not load this file. |
| `/data/.openclaw/credentials/` | Channel and provider credentials written at runtime. |
| `/data/.openclaw/state/openclaw.sqlite` | Shared state database. Paired devices are rows in `device_pairing_paired` (OpenClaw 2026.10.5). Older `devices/paired.json` files are imported once and renamed `.migrated`. |
| `/data/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | That agent's chat history and auth profiles. |
| `/data/.openclaw/agents/<agentId>/sessions/` | Session transcripts. |
| `/data/workspace/` | Agent workspace files. |
| `/data/linuxbrew/` | Linuxbrew copied on first start. This is often the largest directory. |
| `/data/npm-global/`, `/data/uv/`, `/data/go/` | Tool installs from skills and `brew`/`npm`/`uv`/`go`. |

`docker compose down` keeps the named volume. `docker compose down -v` deletes it. On a Coolify server, **Delete Unused Volumes** in Docker cleanup deletes volumes that no container is using, including a stopped application's data.

## Safe copy

OpenClaw 2026.10.5 keeps devices and chat history in SQLite with a write-ahead log. Copying a live `.sqlite` file (or tarring `/data` while the gateway is writing) can miss the `-wal` or `-shm` sidecar and restore a torn database. Upstream's backup command says not to copy live `.sqlite`, `-wal`, `-shm`, or `-journal` files. Two methods avoid that.

### Stop the container, then archive the volume

This is a full `/data` backup: config, paired devices, chat history, workspace, and Linuxbrew. It is the same idea as Coolify's **Stop containers during archive**.

```bash
docker stop openclaw
docker run --rm \
  -v openclaw-data:/data:ro \
  -v "$PWD":/backup \
  alpine \
  tar czf /backup/openclaw-data.tgz -C /data .
docker start openclaw
```

`openclaw-data` is the volume name from the `docker run -v openclaw-data:/data` example and from [`docker-compose.yml`](../docker-compose.yml). On Coolify the Docker volume name includes the resource id. `docker volume ls` shows it. The archive root is the contents of `/data`, not a parent directory named `data`.

### Snapshot OpenClaw state while the gateway is running

`openclaw backup create` (OpenClaw 2026.10.5) reads each OpenClaw SQLite database through SQLite's online backup API, so the gateway can stay up. The archive is state, config, credentials, and agent databases. It does **not** include `/data/linuxbrew`, `/data/npm-global`, `/data/uv`, or `/data/go`. Write it outside the state and workspace trees. `/tmp` inside the container is fine. `/data/.openclaw` and `/data/workspace` are rejected as output paths.

```bash
docker exec openclaw openclaw backup create --output /tmp --verify --no-include-workspace
```

The command prints `Backup archive: /tmp/<timestamp>-openclaw-backup.tar.gz`. Copy that file out:

```bash
docker cp openclaw:/tmp/<timestamp>-openclaw-backup.tar.gz .
```

`openclaw backup verify <archive>` checks the manifest and the SQLite snapshots. Docs: https://docs.openclaw.ai/cli/backup

That archive is not one atomic snapshot of every file. Config is pinned, then each database is snapshotted. A full server-crash copy is still the stopped volume archive above.

## Restore a volume archive

Coolify does not restore a storage archive from the dashboard. Restore into the volume yourself, with the application stopped, and try the archive on a scratch volume before you overwrite the real one.

```bash
docker volume create openclaw-restore-test
docker run --rm \
  -v openclaw-restore-test:/data \
  -v "$PWD":/backup:ro \
  alpine \
  tar xzf /backup/openclaw-data.tgz --numeric-owner -C /data
docker run --rm -v openclaw-restore-test:/data:ro alpine \
  sh -c 'test -f /data/.openclaw/openclaw.json && echo ok'
```

To put it back on the live volume:

```bash
docker stop openclaw
docker run --rm \
  -v openclaw-data:/data \
  -v "$PWD":/backup:ro \
  alpine \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/openclaw-data.tgz --numeric-owner -C /data'
docker start openclaw
```

After start, `openclaw.json` is still under `/data/.openclaw/`, and `openclaw devices list` inside the container shows the paired devices that were in `state/openclaw.sqlite`. Channel logins that keep ratchet state (WhatsApp in particular) can need a fresh link if you restored an older copy over a newer session.

`openclaw backup restore <archive> --target <empty-directory>` extracts an `openclaw backup` archive into a new directory. It does not replace the live state directory. Stop the container, copy the restored state into `/data/.openclaw`, and start again. See https://docs.openclaw.ai/cli/backup for the manifest layout.

## Coolify storage backups

Coolify 4.3.0 and later can schedule a `.tar.gz` of an application's volume mount or directory mount, keep it on the deployment server, and copy it to S3-compatible storage.

1. Open the application, select **Backups**, then **Add** under **Storage backups**.
2. Choose the `/data` volume as the backup target. A volume mount with or without a source path is supported. A file mount is not.
3. Set **Archive behavior** to **Stop containers during archive**. Coolify stops containers that use the volume, writes the archive, and starts them again. **Keep containers running** can capture a torn SQLite file. The application is down for the archive step.
4. Optional: enable an S3 destination. A copy that stays only on the same server is lost with that server. Retention defaults to 7 successful archives.
5. Open **Executions** and download a **Success** archive before you rely on the schedule.

There is no restore button. Download the archive and extract it into the volume root with the commands above, while the application is stopped. Docs: https://coolify.io/docs/core/persistent-storage/storage-mounts/backups
