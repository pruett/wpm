#!/usr/bin/env bash
# Idempotent VPS provisioning for WPM
# Run: ssh root@<vps-ip> 'bash -s' < scripts/vps-setup.sh <domain> <email>
set -euo pipefail

DOMAIN="${1:?Usage: vps-setup.sh <domain> <email>}"
EMAIL="${2:?Usage: vps-setup.sh <domain> <email>}"
APP_DIR="/opt/wpm"

echo "=== WPM VPS Setup: ${DOMAIN} ==="

# --- Docker ---
if ! command -v docker &>/dev/null; then
    echo "--- Installing Docker ---"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi
echo "Docker: $(docker --version)"

# --- Firewall ---
echo "--- Configuring firewall ---"
apt-get update -qq
apt-get install -y -qq ufw certbot > /dev/null
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# --- App directory ---
echo "--- Creating ${APP_DIR} ---"
mkdir -p "${APP_DIR}/certbot"

# --- SSL certificate ---
if [ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
    echo "--- Obtaining SSL certificate (standalone) ---"
    certbot certonly --standalone -d "${DOMAIN}" \
        --non-interactive --agree-tos --email "${EMAIL}"

    # Switch renewal method to webroot (nginx serves challenges once running)
    RENEWAL_CONF="/etc/letsencrypt/renewal/${DOMAIN}.conf"
    if [ -f "${RENEWAL_CONF}" ]; then
        sed -i "s/authenticator = standalone/authenticator = webroot/" "${RENEWAL_CONF}"
        grep -q "webroot_path" "${RENEWAL_CONF}" || \
            sed -i "/\[renewalparams\]/a webroot_path = ${APP_DIR}/certbot" "${RENEWAL_CONF}"
    fi
else
    echo "--- SSL certificate already exists ---"
fi

# --- Cert renewal hook (reload nginx after renewal) ---
HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"
mkdir -p "${HOOK_DIR}"
cat > "${HOOK_DIR}/reload-nginx.sh" << 'HOOK'
#!/usr/bin/env bash
cd /opt/wpm
docker compose exec -T nginx nginx -s reload
HOOK
chmod +x "${HOOK_DIR}/reload-nginx.sh"

# --- Enable certbot auto-renewal timer ---
systemctl enable --now certbot.timer 2>/dev/null || true

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy docker-compose.yml and nginx/ to ${APP_DIR}"
echo "  2. Create ${APP_DIR}/.env (see .env.example)"
echo "  3. docker login ghcr.io"
echo "  4. cd ${APP_DIR} && docker compose pull && docker compose up -d"
