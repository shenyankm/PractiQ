# Production deployment

The personal service and import Web frontend run at https://practiq.shenyankm.com.
The offline practice app remains separately packaged. Production uses the existing
host Caddy, a dedicated Compose project, and separate PostgreSQL/RabbitMQ volumes.
Other host applications and historical databases are not adopted or modified.

## Host configuration

Install the two Compose files from `server/deploy/` under
`/opt/practiq/config/server/deploy/`. Install `deploy.sh` root-owned, mode 755, as
`/usr/local/sbin/practiq-deploy`. Docker Compose 2.24.4+ is required for `!override`.
Keep `/etc/practiq/service.env`, `/etc/practiq/runtime.env` and
`/etc/practiq/image.env` root-owned, mode 600. Put only the AI service token,
model settings and tracing settings in `runtime.env`. Keep infrastructure
credentials in `service.env`, which supplies Compose interpolation only:

```dotenv
PRACTIQ_ENV_FILE=/etc/practiq/runtime.env
PRACTIQ_STORAGE_DIR=/var/lib/practiq
DATABASE_URI=postgresql://practiq:GENERATE_PASSWORD@127.0.0.1:5433/practiq
POSTGRES_PASSWORD=GENERATE_PASSWORD
RABBITMQ_URI=amqp://practiq:GENERATE_SERVICE_PASSWORD@127.0.0.1:5673/practiq
RABBITMQ_ADMIN_USER=practiq-admin
RABBITMQ_ADMIN_PASSWORD=GENERATE_ADMIN_PASSWORD
```

Generate distinct passwords and an `AI_SERVICE_TOKEN`; do not use the placeholders.
Provider credentials belong only in `runtime.env`; never copy administrator
passwords into that container environment file. The deployed provider uses
`LLM_PROVIDER=openai`, `AI_MODEL_API=responses`, `LLM_MODEL=deepseek-v4.1-flash`
and the operator's HTTPS gateway. Model capabilities and live output quality must
be verified separately with explicitly authorized model work.

Create only a new empty storage directory owned by UID/GID 10001. Never recursively
change permissions on existing data. Load the first trusted application image and
set `PRACTIQ_IMAGE=sha256:<image ID>` in `image.env` before initialization.
Start PostgreSQL and RabbitMQ, create a
restricted RabbitMQ `practiq` user with permissions on only the `practiq` vhost,
and initialize the **new empty** database once with
`docker compose ... run --rm --no-deps ai python -m practiq_ai.manage init-db`.
Do not initialize or migrate a historical database through this deployment.

Append the provided Caddy site to the existing host Caddyfile, validate, then
reload Caddy. It obtains and renews TLS certificates. Public ports are 80/443;
service 8090, PostgreSQL 5433, RabbitMQ 5673 and management 15673 bind to loopback.
No provider credentials or service tokens are supplied to GitHub Actions.

If Docker Hub is unreachable, transfer infrastructure images from a trusted host.
After pulling RabbitMQ using the pinned digest, save/load its tagged image and set
`PRACTIQ_RABBITMQ_IMAGE` to that image's verified `sha256:` image ID. This preserves
an immutable local reference without requiring a registry lookup after loading.

## CI and deployment

`Production deployment` calls the existing full AI service/Web CI for the exact
commit, then builds a SHA-tagged image and retains a compressed artifact for three
days. On `main`, it sends that image over SSH and verifies public HTTPS readiness.
Deployment concurrency prevents overlapping updates. Main's normal CI remains
independent; a failed verification never starts the deployment job.

The `production` GitHub environment stores `DEPLOY_SSH_KEY` and
`DEPLOY_KNOWN_HOSTS`. Restrict its deployment branches to `main`. Pin the actual
host key, verified during initial SSH access. The dedicated public key in Ubuntu's
`authorized_keys` uses `restrict` and this forced command:

```text
command="sudo /usr/local/sbin/practiq-deploy \"$SSH_ORIGINAL_COMMAND\""
```

The receiver accepts only `deploy <40 lowercase hex digits>`, takes a host lock,
loads the compressed image directly from stdin using Docker's gzip support, and
updates only the AI container. It never executes
repository scripts supplied through SSH. Changes to the root-owned host receiver,
Compose files, Caddy or infrastructure require a separate operator update.

## Recovery and limitations

The receiver pins the previous image ID before loading an archive, so repeated
builds of the same SHA cannot overwrite the rollback target. It stores the new
immutable image ID only after loading. It restores the previous image if container
health or local readiness fails, including HUP/INT/TERM interruption. SIGKILL or
host failure still require operator recovery. It performs no schema migrations, volume removal
or image pruning. Keep original images for unfinished tasks whose execution
fingerprints require them. A rollback failure needs operator intervention.

This single-instance deployment has a short restart interruption. Schedule updates
after imports and grading finish; graceful shutdown is bounded at 65 seconds.
An interrupted paid request can remain unknown and requires explicit recovery;
deployment must never retry it. A green readiness endpoint does not establish
model compatibility, import quality, backup recovery or notification delivery.
Take consistent database/files/configuration backups before service upgrades as
described in [operations](operations.md). GitHub artifact retention is not a backup.
