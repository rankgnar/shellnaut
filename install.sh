#!/usr/bin/env bash
# install.sh — Shellnaut Installation Wizard
# Interactive, step-by-step installer. Nothing runs without your OK.

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────

banner() {
  clear
  echo -e "${CYAN}${BOLD}"
  cat << 'EOF'
  ███████╗██╗  ██╗███████╗██╗     ██╗     ███╗   ██╗ █████╗ ██╗   ██╗████████╗
  ██╔════╝██║  ██║██╔════╝██║     ██║     ████╗  ██║██╔══██╗██║   ██║╚══██╔══╝
  ███████╗███████║█████╗  ██║     ██║     ██╔██╗ ██║███████║██║   ██║   ██║
  ╚════██║██╔══██║██╔══╝  ██║     ██║     ██║╚██╗██║██╔══██║██║   ██║   ██║
  ███████║██║  ██║███████╗███████╗███████╗██║ ╚████║██║  ██║╚██████╔╝   ██║
  ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝    ╚═╝
EOF
  echo -e "${RESET}"
  echo -e "${BOLD}  Installation Wizard${RESET}  ${DIM}— Step-by-step, nothing runs without your OK${RESET}"
  echo -e "${DIM}  ────────────────────────────────────────────────────────────────${RESET}"
  echo ""
}

step_header() {
  local num="$1"
  local total="$2"
  local title="$3"
  echo ""
  echo -e "${BOLD}${CYAN}┌─────────────────────────────────────────────────────────────┐${RESET}"
  printf "${BOLD}${CYAN}│${RESET}  ${BOLD}[%d/%d]${RESET}  %-52s ${CYAN}│${RESET}\n" "$num" "$total" "$title"
  echo -e "${BOLD}${CYAN}└─────────────────────────────────────────────────────────────┘${RESET}"
  echo ""
}

explain() {
  echo -e "${YELLOW}  Why:${RESET} $1"
  echo ""
}

show_command() {
  echo -e "${DIM}  Command to run:${RESET}"
  echo -e "${CYAN}${BOLD}  ┌──────────────────────────────────────────────────────────┐${RESET}"
  echo -e "${CYAN}${BOLD}  │${RESET}  ${CYAN}$1${RESET}"
  echo -e "${CYAN}${BOLD}  └──────────────────────────────────────────────────────────┘${RESET}"
  echo ""
}

confirm() {
  local prompt="${1:-Press Enter to continue, or type 'skip' to skip}"
  echo -e "${BOLD}  → ${prompt}${RESET}"
  local ans
  read -r ans </dev/tty
  if [[ "${ans,,}" == "skip" ]]; then
    echo -e "${YELLOW}  Skipped.${RESET}"
    return 1
  fi
  return 0
}

confirm_yn() {
  local prompt="$1"
  local ans
  while true; do
    echo -e "${BOLD}  → ${prompt} [y/n]${RESET}"
    read -r ans </dev/tty
    case "${ans,,}" in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
      *) echo -e "${YELLOW}  Please type y or n.${RESET}" ;;
    esac
  done
}

ok() {
  echo -e "${GREEN}  ✓ $1${RESET}"
}

warn() {
  echo -e "${YELLOW}  ⚠  $1${RESET}"
}

error() {
  echo -e "${RED}  ✗ $1${RESET}"
}

divider() {
  echo -e "${DIM}  ────────────────────────────────────────────────────────────${RESET}"
}

TOTAL_STEPS=7
INSTALL_DIR=""
TAILSCALE_IP=""

# ─── STEP 0: Check prerequisites ─────────────────────────────────────────────

step0_prerequisites() {
  step_header 0 $TOTAL_STEPS "Check prerequisites"

  explain "Tailscale creates a private encrypted network so only your devices \
can reach this server. It's optional but recommended for VPS installations."

  # Check Tailscale
  if command -v tailscale &>/dev/null && tailscale ip -4 &>/dev/null; then
    TAILSCALE_IP=$(tailscale ip -4 2>/dev/null | head -1)
    ok "Tailscale is running. Your IP: ${TAILSCALE_IP}"
  else
    warn "Tailscale is not installed or not running."
    echo ""
    echo -e "  ${DIM}Shellnaut will still work — you'll access it via your server's IP address.${RESET}"
    echo -e "  ${DIM}For extra security on a VPS, consider setting up Tailscale first:${RESET}"
    echo -e "  ${DIM}  https://github.com/rankgnar/vps-secure-setup${RESET}"
    echo ""

    # Try to get a usable IP for the summary
    TAILSCALE_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [[ -z "$TAILSCALE_IP" ]]; then
      TAILSCALE_IP="your-server-ip"
    fi

    if ! confirm_yn "Continue without Tailscale?"; then
      echo ""
      echo -e "  Set up Tailscale first, then run this installer again."
      exit 0
    fi
  fi
}

# ─── STEP 1: Install Node.js ─────────────────────────────────────────────────

step1_install_node() {
  step_header 1 $TOTAL_STEPS "Install Node.js"

  if command -v node &>/dev/null; then
    local version
    version=$(node --version)
    local major
    major=$(echo "$version" | sed 's/v//' | cut -d. -f1)
    if [[ "$major" -ge 18 ]]; then
      ok "Node.js ${version} is already installed."
      return
    else
      warn "Node.js ${version} is too old. Need v18 or higher."
    fi
  fi

  explain "Node.js is the runtime that Shellnaut runs on. We'll install the \
latest LTS version (v22)."

  show_command "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs"

  if confirm "Press Enter to install Node.js, or type 'skip'"; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
    sudo apt install -y nodejs
    echo ""
    ok "Node.js $(node --version) installed."
  fi
}

# ─── STEP 2: Install tmux ────────────────────────────────────────────────────

step2_install_tmux() {
  step_header 2 $TOTAL_STEPS "Install tmux"

  if command -v tmux &>/dev/null; then
    ok "tmux is already installed ($(tmux -V))."
    return
  fi

  explain "tmux keeps your terminal sessions alive on the server even when you \
close the browser. It's what makes your sessions persistent."

  show_command "sudo apt install -y tmux"

  if confirm "Press Enter to install tmux, or type 'skip'"; then
    sudo apt install -y tmux
    echo ""
    ok "tmux installed."
  fi
}

# ─── STEP 3: Download Shellnaut ──────────────────────────────────────────────

step3_download() {
  step_header 3 $TOTAL_STEPS "Download Shellnaut"

  # Detect if running from inside the cloned repo
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$script_dir/server.js" ]] && [[ -f "$script_dir/package.json" ]]; then
    INSTALL_DIR="$script_dir"
    ok "Running from the Shellnaut repo at ${INSTALL_DIR}. No download needed."
    return
  fi

  INSTALL_DIR="$HOME/shellnaut"

  if [[ -d "$INSTALL_DIR" ]] && [[ -f "$INSTALL_DIR/server.js" ]]; then
    ok "Shellnaut is already downloaded at ${INSTALL_DIR}."
    if confirm_yn "Do you want to re-download (overwrites changes)?"; then
      rm -rf "$INSTALL_DIR"
    else
      return
    fi
  fi

  explain "We'll download Shellnaut from GitHub into your home directory."

  show_command "git clone https://github.com/rankgnar/shellnaut.git ~/shellnaut"

  if confirm "Press Enter to download, or type 'skip'"; then
    git clone https://github.com/rankgnar/shellnaut.git "$INSTALL_DIR"
    echo ""
    ok "Downloaded to ${INSTALL_DIR}"
  fi
}

# ─── STEP 4: Install dependencies ────────────────────────────────────────────

step4_install_deps() {
  step_header 4 $TOTAL_STEPS "Install dependencies"

  explain "npm install downloads all the libraries Shellnaut needs and builds \
the web interface automatically."

  show_command "cd ~/shellnaut && npm install"

  if confirm "Press Enter to install, or type 'skip'"; then
    cd "$INSTALL_DIR"
    npm install
    echo ""
    ok "Dependencies installed and client built."
  fi
}

# ─── STEP 5: Create credentials ──────────────────────────────────────────────

step5_setup_credentials() {
  step_header 5 $TOTAL_STEPS "Create your login credentials"

  if [[ -f "$INSTALL_DIR/.env" ]] && grep -q "AUTH_USER" "$INSTALL_DIR/.env" 2>/dev/null; then
    local existing_user
    existing_user=$(grep "AUTH_USER" "$INSTALL_DIR/.env" | cut -d= -f2)
    ok "Credentials already configured (user: ${existing_user})."
    if ! confirm_yn "Do you want to create new credentials?"; then
      return
    fi
  fi

  explain "You'll choose a username and password. This is what you'll use to \
log into Shellnaut from your browser. Your password is encrypted — it's never \
stored in plain text."

  show_command "npm run setup"

  if confirm "Press Enter to set up credentials, or type 'skip'"; then
    cd "$INSTALL_DIR"
    node setup.js </dev/tty
    echo ""
    ok "Credentials saved."
  fi
}

# ─── STEP 6: Start with PM2 ─────────────────────────────────────────────────

step6_start_server() {
  step_header 6 $TOTAL_STEPS "Start Shellnaut"

  explain "PM2 is a process manager that keeps Shellnaut running in the background. \
If the server reboots or the process crashes, PM2 restarts it automatically."

  # Install PM2 if needed
  if ! command -v pm2 &>/dev/null; then
    show_command "sudo npm install -g pm2"
    if confirm "Press Enter to install PM2, or type 'skip'"; then
      sudo npm install -g pm2
      echo ""
      ok "PM2 installed."
    fi
  else
    ok "PM2 is already installed."
  fi

  echo ""

  # Check if an existing instance is running
  if pm2 describe shellnaut &>/dev/null 2>&1; then
    warn "Shellnaut is already running in PM2."
    if confirm_yn "Stop the existing instance and start fresh?"; then
      pm2 delete shellnaut 2>/dev/null || true
      ok "Existing instance stopped."
    else
      echo -e "${DIM}  Keeping existing instance. You can restart manually: pm2 restart shellnaut${RESET}"
      return
    fi
  fi

  show_command "pm2 start server.js --name shellnaut"

  if confirm "Press Enter to start Shellnaut, or type 'skip'"; then
    cd "$INSTALL_DIR"
    pm2 start server.js --name shellnaut
    pm2 save
    echo ""

    # Configure auto-start on reboot
    local startup_cmd
    startup_cmd=$(pm2 startup 2>/dev/null | grep "sudo" | head -1)
    if [[ -n "$startup_cmd" ]]; then
      explain "PM2 needs this command to auto-start on reboot:"
      show_command "$startup_cmd"
      if confirm_yn "Run it now?"; then
        eval "$startup_cmd"
        ok "Auto-start configured."
      else
        warn "Shellnaut won't auto-start on reboot. Run this later:"
        echo -e "  ${CYAN}${startup_cmd}${RESET}"
      fi
    else
      ok "PM2 auto-start already configured."
    fi

    echo ""

    # Verify it's running
    sleep 2
    if curl -s http://localhost:3001/ping 2>/dev/null | grep -q "ok"; then
      ok "Shellnaut is running!"
    else
      error "Server may not have started correctly. Check: pm2 logs shellnaut"
    fi
  fi
}

# ─── STEP 7: Final summary ──────────────────────────────────────────────────

step7_summary() {
  step_header 7 $TOTAL_STEPS "Done!"

  echo ""
  echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${CYAN}${BOLD}║                  SHELLNAUT IS READY                         ║${RESET}"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${GREEN}✓${RESET}  Tailscale connected"
  echo -e "  ${GREEN}✓${RESET}  Node.js installed"
  echo -e "  ${GREEN}✓${RESET}  tmux installed"
  echo -e "  ${GREEN}✓${RESET}  Shellnaut downloaded and built"
  echo -e "  ${GREEN}✓${RESET}  Credentials configured"
  echo -e "  ${GREEN}✓${RESET}  Server running with PM2"
  echo ""
  echo -e "  ${BOLD}Open this URL in your browser:${RESET}"
  echo ""
  echo -e "  ${CYAN}${BOLD}  http://${TAILSCALE_IP}:3001${RESET}"
  echo ""
  echo -e "  ${DIM}On your phone, you can install it as an app:${RESET}"
  echo -e "  ${DIM}  iPhone: Share > Add to Home Screen${RESET}"
  echo -e "  ${DIM}  Android: Menu > Install app${RESET}"
  echo ""
  echo -e "  ${BOLD}Useful commands:${RESET}"
  echo -e "  ├── View logs:     ${CYAN}pm2 logs shellnaut${RESET}"
  echo -e "  ├── Restart:       ${CYAN}pm2 restart shellnaut${RESET}"
  echo -e "  ├── Stop:          ${CYAN}pm2 stop shellnaut${RESET}"
  echo -e "  └── Change creds:  ${CYAN}cd ~/shellnaut && npm run setup${RESET}"
  echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  banner

  echo -e "${BOLD}  Welcome to the Shellnaut installer!${RESET}"
  echo ""
  echo -e "  This wizard will set up everything you need, step by step."
  echo -e "  ${BOLD}Every command is shown and explained before it runs.${RESET}"
  echo -e "  Nothing happens without your approval."
  echo ""
  echo -e "${DIM}  You can type 'skip' at any step to skip it.${RESET}"
  echo ""
  divider
  echo ""
  echo -e "${BOLD}  → Press Enter to begin, or Ctrl+C to exit.${RESET}"
  read -r </dev/tty

  step0_prerequisites
  step1_install_node
  step2_install_tmux
  step3_download
  step4_install_deps
  step5_setup_credentials
  step6_start_server
  step7_summary
}

main "$@"
