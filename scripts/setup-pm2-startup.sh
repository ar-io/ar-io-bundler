#!/bin/bash
# Setup PM2 auto-startup on system boot
# This configures systemd to automatically start PM2 services after reboot

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔧 Configuring PM2 Auto-Startup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ This script must be run with sudo"
    echo ""
    echo "Usage:"
    echo "  sudo ./scripts/setup-pm2-startup.sh"
    exit 1
fi

# Get the actual user (not root)
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(eval echo ~$ACTUAL_USER)

echo "📋 Configuration:"
echo "  User: $ACTUAL_USER"
echo "  Home: $ACTUAL_HOME"
echo ""

# Configure PM2 startup
echo "⚙️  Configuring PM2 systemd service..."

# Detect PM2 path dynamically
PM2_PATH=$(su - "$ACTUAL_USER" -c "which pm2" 2>/dev/null || command -v pm2)

if [ -z "$PM2_PATH" ]; then
    echo "❌ PM2 not found in PATH"
    echo "   Please install PM2: npm install -g pm2"
    exit 1
fi

echo "   Using PM2: $PM2_PATH"

# Install the systemd unit. This MUST run as root (the script already requires it):
# running `pm2 startup` as the unprivileged user only PRINTS a sudo command and does
# not write/enable the unit. The -u/--hp flags target the unit at the deploy user.
"$PM2_PATH" startup systemd -u "$ACTUAL_USER" --hp "$ACTUAL_HOME"

echo ""
echo "✅ PM2 systemd service configured!"
echo ""

# Verify the service was created
SERVICE_NAME="pm2-${ACTUAL_USER}.service"

if systemctl list-unit-files | grep -q "$SERVICE_NAME"; then
    echo "✅ Systemd service created: $SERVICE_NAME"

    # Enable the service
    echo "⚙️  Enabling PM2 service..."
    systemctl enable "$SERVICE_NAME"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ PM2 Auto-Startup Configured Successfully!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Your PM2 services will now automatically start on system boot."
    echo ""
    echo "Service details:"
    echo "  Service name: $SERVICE_NAME"
    echo "  User: $ACTUAL_USER"
    echo "  Status: Enabled"
    echo ""
    echo "Useful commands:"
    echo "  sudo systemctl status $SERVICE_NAME    # Check service status"
    echo "  sudo systemctl restart $SERVICE_NAME   # Restart PM2 services"
    echo "  pm2 list                               # List running processes"
    echo "  pm2 save                               # Save current process list"
    echo ""
else
    echo "❌ Failed to create systemd service"
    exit 1
fi
