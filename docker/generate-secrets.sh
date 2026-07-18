#!/usr/bin/env bash
#
# Generates everything the production stack needs that must not live in git:
#
#   docker/.env      — strong random secrets + your domain, 0600
#   docker/pki/      — an internal CA and mTLS keypairs for api <-> collab
#
# SAFE BY DEFAULT: a plain run only fills in values that are MISSING. Existing
# secrets, your SMTP credentials and your domain are preserved, so re-running
# after an upgrade adds any newly-required value without disturbing a live
# deployment. Rotation is always explicit, and always backed up.
#
# Usage:
#   ./docker/generate-secrets.sh                          # create or complete; never overwrites
#   ./docker/generate-secrets.sh --domain docs.example.com --acme-email ops@example.com
#   ./docker/generate-secrets.sh --rotate certs           # internal mTLS PKI only
#   ./docker/generate-secrets.sh --rotate session         # session keys (signs everyone out)
#   ./docker/generate-secrets.sh --rotate collab-secret   # api<->collab shared secret
#   ./docker/generate-secrets.sh --rotate db-password     # DB password, applied to the live database
#   ./docker/generate-secrets.sh --rotate all
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
PKI_DIR="$HERE/pki"
COMPOSE_FILE="$HERE/docker-compose.prod.yml"
DOMAIN=""
ACME_EMAIL=""
ROTATE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --rotate)     ROTATE="${2:?--rotate needs one of: certs|session|collab-secret|db-password|all}"; shift 2 ;;
    --domain)     DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --acme-email) ACME_EMAIL="${2:?--acme-email needs a value}"; shift 2 ;;
    --force)
      echo "FATAL: --force has been removed." >&2
      echo "It regenerated every secret at once, which silently broke live deployments:" >&2
      echo "  * a new POSTGRES_PASSWORD does NOT change the password inside the existing" >&2
      echo "    database volume, so the stack could no longer reach its own database;" >&2
      echo "  * hand-edited SMTP credentials were overwritten." >&2
      echo "Use --rotate <certs|session|collab-secret|db-password|all> instead." >&2
      exit 2 ;;
    -h|--help)    sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$ROTATE" in
  ""|certs|session|collab-secret|db-password|all) ;;
  *) echo "FATAL: --rotate must be one of: certs|session|collab-secret|db-password|all" >&2; exit 2 ;;
esac

command -v openssl >/dev/null || { echo "FATAL: openssl is required" >&2; exit 1; }

rotating() { [ "$ROTATE" = "all" ] || [ "$ROTATE" = "$1" ]; }

# Reads a key from the existing env file. Parsed rather than sourced so a value
# can never be executed as shell.
current() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-
}

backup_env() {
  [ -f "$ENV_FILE" ] || return 0
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENV_FILE" "$ENV_FILE.bak.$stamp"
  chmod 600 "$ENV_FILE.bak.$stamp"
  echo "==> backed up previous secrets to $(basename "$ENV_FILE").bak.$stamp"
}

# ─── secrets ──────────────────────────────────────────────────────────────────

EXISTING=0
[ -f "$ENV_FILE" ] && EXISTING=1

# Preserve everything already set unless it is explicitly being rotated.
OLD_DB_PASSWORD="$(current POSTGRES_PASSWORD)"
POSTGRES_PASSWORD="$OLD_DB_PASSWORD"
SESSION_SECRET="$(current ASCIIDOCOLLAB_AUTH_SESSION_SECRET)"
SESSION_ENCRYPTION_KEY="$(current ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY)"
COLLAB_EDIT_SECRET="$(current ASCIIDOCOLLAB_COLLAB_EDIT_SECRET)"
[ -n "$DOMAIN" ]     || DOMAIN="$(current ADC_DOMAIN)"
[ -n "$ACME_EMAIL" ] || ACME_EMAIL="$(current ADC_ACME_EMAIL)"
SMTP_HOST="$(current ASCIIDOCOLLAB_AUTH_SMTP_HOST)"
SMTP_PORT="$(current ASCIIDOCOLLAB_AUTH_SMTP_PORT)"
SMTP_USER="$(current ASCIIDOCOLLAB_AUTH_SMTP_USER)"
SMTP_PASSWORD="$(current ASCIIDOCOLLAB_AUTH_SMTP_PASSWORD)"
EMAIL_FROM="$(current ASCIIDOCOLLAB_AUTH_EMAIL_FROM)"

rotating session       && { backup_env; SESSION_SECRET=""; SESSION_ENCRYPTION_KEY=""; }
rotating collab-secret && { backup_env; COLLAB_EDIT_SECRET=""; }

# Hex rather than base64 for the DB password: it lands inside a postgresql:// URL,
# and hex needs no percent-encoding, so it cannot corrupt the DSN.
[ -n "$POSTGRES_PASSWORD" ]      || POSTGRES_PASSWORD="$(openssl rand -hex 24)"
[ -n "$SESSION_SECRET" ]         || SESSION_SECRET="$(openssl rand -base64 32)"
[ -n "$SESSION_ENCRYPTION_KEY" ] || SESSION_ENCRYPTION_KEY="$(openssl rand -base64 32)"
[ -n "$COLLAB_EDIT_SECRET" ]     || COLLAB_EDIT_SECRET="$(openssl rand -base64 32)"
[ -n "$SMTP_PORT" ]              || SMTP_PORT="587"

if [ -z "$DOMAIN" ]; then
  echo "Where will this instance be reached?"
  echo "  A domain (docs.example.com) gets a publicly-trusted certificate automatically."
  echo "  An IP or LAN name (192.168.1.10, docs.lan) gets a self-signed one instead."
  read -r -p "Domain or IP: " DOMAIN
fi
[ -n "$DOMAIN" ] || { echo "FATAL: a domain or IP is required" >&2; exit 1; }

# Decide how the certificate is obtained. Let's Encrypt cannot validate a bare IP
# or a name that does not resolve publicly, so those get Caddy's internal CA.
# An IPv4/IPv6 literal, "localhost", or a single-label/.lan/.local/.internal name
# is treated as a private target.
case "$DOMAIN" in
  localhost|*.local|*.lan|*.internal|*.home.arpa) PRIVATE_TARGET=1 ;;
  *:*)                                            PRIVATE_TARGET=1 ;;  # IPv6 literal
  *[!0-9.]*)                                      PRIVATE_TARGET=0 ;;  # has a non-IPv4 char
  *)                                              PRIVATE_TARGET=1 ;;  # all digits/dots: IPv4
esac
case "$DOMAIN" in *.*) ;; *) PRIVATE_TARGET=1 ;; esac  # single-label hostname

if [ "$PRIVATE_TARGET" -eq 1 ]; then
  ADC_TLS="internal"
  echo "==> '$DOMAIN' cannot be validated by Let's Encrypt — using a self-signed"
  echo "    certificate from Caddy's internal CA. Browsers will warn until that CA"
  echo "    is trusted; see \"Deploying without a domain\" in docker/README.md."
else
  # ACME needs a contact address: Caddy will not start with an empty one, and
  # without it there is no warning before a renewal failure becomes an outage.
  if [ -z "$ACME_EMAIL" ]; then
    read -r -p "Email for Let's Encrypt (required for certificate expiry warnings): " ACME_EMAIL || true
  fi
  if [ -z "$ACME_EMAIL" ]; then
    echo "FATAL: an email address is required for a public domain." >&2
    echo "       Re-run with --acme-email you@example.com, or use an IP/LAN name" >&2
    echo "       to deploy with a self-signed certificate instead." >&2
    exit 1
  fi
  ADC_TLS="$ACME_EMAIL"
fi
# A bare IP is not a valid email domain, so fall back to a placeholder there.
# Either way this should be replaced with an address your SMTP relay accepts.
if [ -z "$EMAIL_FROM" ]; then
  if [ "$PRIVATE_TARGET" -eq 1 ]; then EMAIL_FROM="noreply@localhost"; else EMAIL_FROM="noreply@$DOMAIN"; fi
fi

# ─── database password rotation ───────────────────────────────────────────────
#
# The password lives in two places: this file and the role inside the database
# volume. Writing a new one here WITHOUT changing the role is what used to lock
# the stack out of its own database, so the change is applied to the live
# database first, and only persisted here if that succeeded.
if rotating db-password; then
  if [ -z "$OLD_DB_PASSWORD" ]; then
    echo "==> no existing database password to rotate; one will be generated"
    POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  else
    NEW_DB_PASSWORD="$(openssl rand -hex 24)"
    echo "==> rotating the database password"
    if ! docker compose -f "$COMPOSE_FILE" ps --status running postgres 2>/dev/null | grep -q postgres; then
      echo "FATAL: the postgres service is not running." >&2
      echo "The password inside the database volume can only be changed while it is up." >&2
      echo "Start the stack, then re-run:  docker compose -f docker/docker-compose.prod.yml up -d postgres" >&2
      exit 1
    fi
    if docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$OLD_DB_PASSWORD" postgres \
         psql -U asciidocollab -d asciidocollab -v ON_ERROR_STOP=1 \
         -c "ALTER USER asciidocollab WITH PASSWORD '$NEW_DB_PASSWORD';" >/dev/null 2>&1; then
      backup_env
      POSTGRES_PASSWORD="$NEW_DB_PASSWORD"
      echo "==> database role updated; restart api, collab and migrate to pick it up"
    else
      echo "FATAL: could not change the password inside the database." >&2
      echo "Nothing was written — your existing credentials still work." >&2
      exit 1
    fi
  fi
fi

if [ "$EXISTING" -eq 1 ] && [ -z "$ROTATE" ]; then
  echo "==> $(basename "$ENV_FILE") exists — filling in missing values only, existing secrets preserved"
fi

umask 077
cat > "$ENV_FILE" <<EOF
# Generated by docker/generate-secrets.sh — DO NOT COMMIT.
#
# Re-running the script is safe: it only fills in values that are missing.
# To rotate something deliberately:
#   ./docker/generate-secrets.sh --rotate certs          # internal mTLS PKI
#   ./docker/generate-secrets.sh --rotate session        # signs every user out
#   ./docker/generate-secrets.sh --rotate collab-secret
#   ./docker/generate-secrets.sh --rotate db-password    # also updates the live database
# Each rotation writes a timestamped .env.bak.* backup first.

# ─── Public identity ───────────────────────────────────────────────────────
ADC_DOMAIN=$DOMAIN
ADC_ACME_EMAIL=$ACME_EMAIL
# How Caddy obtains its certificate: an email address means Let's Encrypt,
# the literal "internal" means a self-signed certificate from Caddy's own CA.
ADC_TLS=$ADC_TLS

# ─── Secrets ───────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
ASCIIDOCOLLAB_AUTH_SESSION_SECRET=$SESSION_SECRET
ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY=$SESSION_ENCRYPTION_KEY
# Shared secret for the api -> collab internal edit endpoint. Must be identical
# on both services; compose wires this one value into both.
ASCIIDOCOLLAB_COLLAB_EDIT_SECRET=$COLLAB_EDIT_SECRET

# ─── Outbound email (REQUIRED — the api refuses to start without EMAIL_FROM) ──
ASCIIDOCOLLAB_AUTH_EMAIL_FROM=$EMAIL_FROM
ASCIIDOCOLLAB_AUTH_SMTP_HOST=$SMTP_HOST
ASCIIDOCOLLAB_AUTH_SMTP_PORT=$SMTP_PORT
ASCIIDOCOLLAB_AUTH_SMTP_USER=$SMTP_USER
ASCIIDOCOLLAB_AUTH_SMTP_PASSWORD=$SMTP_PASSWORD
EOF
chmod 600 "$ENV_FILE"
[ "$EXISTING" -eq 1 ] || echo "==> wrote $ENV_FILE (0600)"

# ─── internal PKI for api <-> collab mTLS ─────────────────────────────────────
#
# Both internal channels are mutually authenticated:
#   collab -> api    : the api's internal auth server  (port 4001)
#   api    -> collab : the collab internal edit server (port 4003)
#
# Certificates are issued for the compose service names ("api", "collab"), which
# is what the services resolve each other by.

if [ -d "$PKI_DIR" ] && ! rotating certs; then
  echo "==> $(basename "$PKI_DIR")/ exists — leaving it alone (rotate with --rotate certs)"
else
  if [ -d "$PKI_DIR" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    mv "$PKI_DIR" "$PKI_DIR.bak.$stamp"
    echo "==> previous PKI moved to $(basename "$PKI_DIR").bak.$stamp"
  fi
  mkdir -p "$PKI_DIR"
  umask 077

  # Internal CA. 10 years: it is never distributed, and rotating it requires
  # restarting both services, so a short lifetime buys nothing here.
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$PKI_DIR/ca.key" -out "$PKI_DIR/ca.crt" \
    -subj "/CN=AsciiDoCollab Internal CA" 2>/dev/null

  # Leaf certificates, 825 days (the maximum widely-accepted leaf lifetime).
  for svc in api collab; do
    openssl req -newkey rsa:2048 -sha256 -nodes \
      -keyout "$PKI_DIR/$svc.key" -out "$PKI_DIR/$svc.csr" \
      -subj "/CN=$svc" 2>/dev/null

    cat > "$PKI_DIR/$svc.ext" <<EOF
subjectAltName = DNS:$svc, DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth, clientAuth
keyUsage = digitalSignature, keyEncipherment
basicConstraints = CA:FALSE
EOF

    openssl x509 -req -in "$PKI_DIR/$svc.csr" -CA "$PKI_DIR/ca.crt" -CAkey "$PKI_DIR/ca.key" \
      -CAcreateserial -out "$PKI_DIR/$svc.crt" -days 825 -sha256 \
      -extfile "$PKI_DIR/$svc.ext" 2>/dev/null

    rm -f "$PKI_DIR/$svc.csr" "$PKI_DIR/$svc.ext"
  done
  rm -f "$PKI_DIR/ca.srl"

  # Private keys are owner-only. Certificates are public by nature and stay
  # readable so the directory can be inspected without sudo.
  #
  # The containers read these as uid 1000 (node). That works when the host user
  # owning them is also uid 1000, which is the common case but not guaranteed —
  # so instead of loosening the permissions for everyone (the keys used to be
  # world-readable to avoid a confusing crash), the mismatch is detected and
  # reported below with the exact fix.
  chmod 755 "$PKI_DIR"
  chmod 644 "$PKI_DIR"/*.crt
  chmod 600 "$PKI_DIR/api.key" "$PKI_DIR/collab.key"
  # ca.key is never mounted into any container; holding it is what allows minting
  # new trusted client certificates.
  chmod 600 "$PKI_DIR/ca.key"

  HOST_UID="$(id -u)"
  if [ "$HOST_UID" -ne 1000 ]; then
    echo
    echo "NOTE: your uid is $HOST_UID, but the containers read these keys as uid 1000."
    echo "      The private keys are mode 600, so api/collab would fail to start with"
    echo "      a certificate read error. Grant uid 1000 read access:"
    echo "        sudo chown 1000 $PKI_DIR/api.key $PKI_DIR/collab.key"
    echo "      (ca.key must NOT be made readable — no container needs it.)"
  fi
  echo "==> wrote $PKI_DIR (internal CA + api/collab mTLS keypairs)"
  if rotating certs; then
    echo "    restart api and collab to load them: docker compose -f docker/docker-compose.prod.yml restart api collab"
  fi
fi

if [ "$EXISTING" -eq 0 ]; then
  echo
  echo "Next:"
  echo "  1. Set your SMTP details in $ENV_FILE (email is required for signup and password reset)."
  echo "  2. Point your domain's DNS A/AAAA record at this host."
  echo "  3. docker compose -f docker/docker-compose.prod.yml up -d --build"
fi
