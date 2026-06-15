#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

load_brew_env() {
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

load_brew_env

if ! has_cmd node || ! has_cmd npm || ! has_cmd git; then
  if ! has_cmd brew; then
    echo "Installing Homebrew..."
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_brew_env
  fi
fi

if ! has_cmd node || ! has_cmd npm; then
  echo "Installing Node.js with Homebrew..."
  brew install node
fi

if ! has_cmd git; then
  echo "Installing Git with Homebrew..."
  brew install git
fi

npm run setup:install
