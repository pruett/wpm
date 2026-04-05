#!/bin/bash
set -euo pipefail

# First-run setup for Hetzner VPS
# Run once after creating the server: ssh wpm 'bash -s' < scripts/setup-vps.sh

DOMAIN="${1:-wpm.cash}"
EMAIL="${2:-pruett.kevin@gmail.com}"
APP_DIR="/opt/wpm"

echo "=== WPM VPS Setup ==="
echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"

# Create app directory
mkdir -p "$APP_DIR"

# Install certbot
apt-get update -qq
apt-get install -y certbot

# Get initial TLS certificate (standalone mode, before nginx starts)
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "=== Obtaining TLS certificate ==="
  certbot certonly --standalone \
    -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL"
  echo "Certificate obtained for $DOMAIN"
else
  echo "Certificate already exists for $DOMAIN"
fi

# Generate node RSA keys if they don't exist
KEYS_VOL_DIR="/var/lib/docker/volumes/wpm_keys/_data"
if [ ! -f "$KEYS_VOL_DIR/node.pem" ]; then
  echo "=== Generating node signing keys ==="
  mkdir -p "$KEYS_VOL_DIR"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEYS_VOL_DIR/node.pem"
  openssl pkey -in "$KEYS_VOL_DIR/node.pem" -pubout -out "$KEYS_VOL_DIR/node.pub"
  echo "Node keys generated"
else
  echo "Node keys already exist"
fi

# Set up certbot auto-renewal cron
if ! crontab -l 2>/dev/null | grep -q certbot; then
  (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && docker exec wpm-nginx-1 nginx -s reload") | crontab -
  echo "Certbot renewal cron added"
fi

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Point DNS A record for $DOMAIN -> $(curl -s ifconfig.me)"
echo "  2. Copy .env and docker-compose.yml to $APP_DIR"
echo "  3. docker compose pull && docker compose up -d"
