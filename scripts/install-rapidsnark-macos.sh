#!/usr/bin/env zsh
set -euo pipefail

# Simple installer for rapidsnark on macOS.
# Tries Homebrew first, then builds from source if brew not available or tap missing.
# Sets RAPIDSNARK_BIN in shell profile optionally.

print_usage() {
  echo "Usage: install-rapidsnark-macos.sh [--set-env]"
  echo "  --set-env    Append RAPIDSNARK_BIN export to ~/.zshrc"
}

SET_ENV=0
if [[ ${1:-} == "--help" ]]; then
  print_usage
  exit 0
fi
if [[ ${1:-} == "--set-env" ]]; then
  SET_ENV=1
fi

has_brew() {
  command -v brew >/dev/null 2>&1
}

install_via_brew() {
  echo "Attempting Homebrew install..."
  brew tap geometryxyz/snark || true
  brew install rapidsnark || return 1
  BIN=$(command -v rapidsnark)
  echo "rapidsnark installed at: $BIN"
  RAPIDSNARK_BIN="$BIN"
}

build_from_source() {
  echo "Building rapidsnark from source..."
  local dir="$HOME/src/rapidsnark"
  mkdir -p "$HOME/src"
  if [[ -d "$dir" ]]; then
    echo "Using existing directory: $dir"
    pushd "$dir" >/dev/null
    git pull || true
    git submodule init
    git submodule update
    else
      git clone https://github.com/iden3/rapidsnark.git "$dir"
      pushd "$dir" >/dev/null
      git submodule update --init --recursive || true
  
    # Install dependencies via Homebrew
    if has_brew; then
      brew install cmake ninja gmp libsodium libomp || true
    fi
  
    # Build with ASM/OMP disabled for macOS arm64
    mkdir -p build && cd build
    cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_ASM=OFF -DUSE_OPENMP=OFF ..
    ninja
    popd >/dev/null
  
    # Detect binary location (cmake bin or tasksfile prover)
    if [[ -x "$dir/build/bin/rapidsnark" ]]; then
      RAPIDSNARK_BIN="$dir/build/bin/rapidsnark"
    elif [[ -x "$dir/build/prover" ]]; then
      RAPIDSNARK_BIN="$dir/build/prover"
    else
      echo "Build finished but rapidsnark binary not found" >&2
      echo "Checked: $dir/build/bin/rapidsnark and $dir/build/prover" >&2
      exit 1
    fi
    echo "rapidsnark built at: $RAPIDSNARK_BIN"
  fi
  # Install dependencies (cmake, ninja) if using brew
  if has_brew; then
    brew install cmake ninja gmp || true
  fi
  # Build
  mkdir -p build && cd build
  cmake -G Ninja -DCMAKE_BUILD_TYPE=Release ..
  ninja
  popd >/dev/null
  RAPIDSNARK_BIN="$dir/build/prover"
  if [[ ! -x "$RAPIDSNARK_BIN" ]]; then
    echo "Build succeeded but binary not found: $RAPIDSNARK_BIN" >&2
    exit 1
  fi
  echo "rapidsnark built at: $RAPIDSNARK_BIN"
}

RAPIDSNARK_BIN=""
if has_brew; then
  install_via_brew || build_from_source
else
  echo "Homebrew not found; building from source."
  build_from_source
fi

echo "\nTo use rapidsnark in the SDK:"
echo "  export USE_RAPIDSNARK=1"
if [[ -n "$RAPIDSNARK_BIN" ]]; then
  echo "  export RAPIDSNARK_BIN=$RAPIDSNARK_BIN"
fi

if [[ $SET_ENV -eq 1 ]]; then
  echo "\nUpdating ~/.zshrc to set RAPIDSNARK_BIN..."
  echo "export RAPIDSNARK_BIN=$RAPIDSNARK_BIN" >> "$HOME/.zshrc"
  echo "Done. Restart your shell or run: source ~/.zshrc"
fi

echo "\nVerify: $RAPIDSNARK_BIN --version (or run which rapidsnark)"
