#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/waza-suites.sh"

readonly INSTALL_DIR="${1:-${HOME}/.local/bin}"

case "$(uname -s)" in
	Darwin) os="darwin" ;;
	Linux) os="linux" ;;
	*)
		echo "Unsupported operating system: $(uname -s)" >&2
		exit 1
		;;
esac

case "$(uname -m)" in
	x86_64 | amd64) arch="amd64" ;;
	arm64 | aarch64) arch="arm64" ;;
	*)
		echo "Unsupported architecture: $(uname -m)" >&2
		exit 1
		;;
esac

asset="waza-${os}-${arch}"
case "${asset}" in
	waza-darwin-amd64) expected_sha="508e0bf2c33bdddedb5e23ac486ac8accb632761de946fe67c772269a93f96d6" ;;
	waza-darwin-arm64) expected_sha="51bc2df29949f4ec3b34b38e6660dc5d63eaf6ad681a4912da05b5d0eecd9b3e" ;;
	waza-linux-amd64) expected_sha="fbb55d5ca373e2615ec103ecacf10811a020630884bd38e3ba036252abac4301" ;;
	waza-linux-arm64) expected_sha="afea3425621c99797c315112e325303b2e2ca525ceb54b1a76be566d98545e8d" ;;
	*)
		echo "No checksum configured for ${asset}" >&2
		exit 1
		;;
esac

mkdir -p "${INSTALL_DIR}"
tmp_file="$(mktemp "${INSTALL_DIR}/.waza.XXXXXX")"
trap 'rm -f "${tmp_file}"' EXIT

curl --fail --silent --show-error --location \
	--output "${tmp_file}" \
	"https://github.com/microsoft/waza/releases/download/v${WAZA_VERSION}/${asset}"

if command -v sha256sum >/dev/null 2>&1; then
	actual_sha="$(sha256sum "${tmp_file}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
	actual_sha="$(shasum -a 256 "${tmp_file}" | awk '{print $1}')"
else
	echo "A SHA-256 tool (sha256sum or shasum) is required" >&2
	exit 1
fi

if [[ "${actual_sha}" != "${expected_sha}" ]]; then
	echo "Checksum verification failed for ${asset}" >&2
	echo "Expected: ${expected_sha}" >&2
	echo "Actual:   ${actual_sha}" >&2
	exit 1
fi

chmod +x "${tmp_file}"
installed_version="$(WAZA_NO_UPDATE_CHECK=1 "${tmp_file}" --version)"
if [[ "${installed_version}" != "waza version ${WAZA_VERSION}" ]]; then
	echo "Unexpected Waza version: ${installed_version}" >&2
	exit 1
fi

mv -f "${tmp_file}" "${INSTALL_DIR}/waza"
trap - EXIT
echo "Installed ${installed_version} at ${INSTALL_DIR}/waza"
