#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/waza-suites.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly OUTPUT_DIR="${1:-${REPO_ROOT}/.waza-results/validation}"

expected_version="waza version ${WAZA_VERSION}"
actual_version="$(WAZA_NO_UPDATE_CHECK=1 waza --version)"
if [[ "${actual_version}" != "${expected_version}" ]]; then
	echo "Expected ${expected_version}, got ${actual_version}" >&2
	exit 1
fi

mkdir -p "${OUTPUT_DIR}"
coverage_file="${OUTPUT_DIR}/coverage.json"

cd "${REPO_ROOT}"

validate_schema_url() {
	local file_path="$1"
	local schema_name="$2"
	local expected_url="https://raw.githubusercontent.com/microsoft/waza/v${WAZA_VERSION}/schemas/${schema_name}.schema.json"
	local expected_directive="# yaml-language-server: \$schema=${expected_url}"
	local schema_urls

	if [[ "$(grep -Fxc "${expected_directive}" "${file_path}" || true)" -ne 1 ]]; then
		echo "Expected exactly one Waza ${schema_name} schema directive using v${WAZA_VERSION}: ${file_path}" >&2
		exit 1
	fi

	schema_urls="$(grep -Eo 'https://raw\.githubusercontent\.com/microsoft/waza/[^[:space:]]+/schemas/[^[:space:]]+' "${file_path}" || true)"
	if [[ "${schema_urls}" != "${expected_url}" ]]; then
		echo "Unexpected Waza schema URL in ${file_path}; expected ${expected_url}" >&2
		printf '%s\n' "${schema_urls}" >&2
		exit 1
	fi
}

validate_schema_url ".waza.yaml" "config"
for pair in "${WAZA_SKILL_EVAL_PAIRS[@]}"; do
	eval_path="${pair#*|}"
	validate_schema_url "${eval_path}" "eval"

	tasks_dir="$(dirname "${eval_path}")/tasks"
	if [[ ! -d "${tasks_dir}" ]]; then
		echo "Missing Waza tasks directory: ${tasks_dir}" >&2
		exit 1
	fi
	while IFS= read -r task_path; do
		validate_schema_url "${task_path}" "task"
	done < <(find "${tasks_dir}" -type f \( -name '*.yaml' -o -name '*.yml' \) | LC_ALL=C sort)
done

coverage_args=(coverage --format json)
for skill_root in "${WAZA_SKILL_ROOTS[@]}"; do
	coverage_args+=(--path "${skill_root}")
done
WAZA_NO_UPDATE_CHECK=1 waza "${coverage_args[@]}" >"${coverage_file}"

expected_skills=()
for pair in "${WAZA_SKILL_EVAL_PAIRS[@]}"; do
	expected_skills+=("$(basename "${pair%%|*}")")
done
expected_skills_csv="$(IFS=,; echo "${expected_skills[*]}")"

EXPECTED_SKILLS="${expected_skills_csv}" node - "${coverage_file}" <<'NODE'
const fs = require('node:fs');

const coverage = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expectedSkills = process.env.EXPECTED_SKILLS.split(',').sort();
const actualSkills = coverage.skills.map(entry => entry.skill).sort();
const expectedSummary = {
	total_skills: expectedSkills.length,
	covered: expectedSkills.length,
	partial: 0,
	uncovered: 0,
	coverage_pct: 100,
};

for (const [field, expected] of Object.entries(expectedSummary)) {
	if (coverage[field] !== expected) {
		throw new Error(`Expected coverage.${field}=${expected}, got ${coverage[field]}`);
	}
}

if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
	throw new Error(`Expected skills ${expectedSkills.join(', ')}, got ${actualSkills.join(', ')}`);
}
NODE

for pair in "${WAZA_SKILL_EVAL_PAIRS[@]}"; do
	skill_path="${pair%%|*}"
	eval_path="${pair#*|}"
	if [[ ! -f "${skill_path}/SKILL.md" || ! -f "${eval_path}" ]]; then
		echo "Missing Waza skill/eval pair: ${skill_path} | ${eval_path}" >&2
		exit 1
	fi
	WAZA_NO_UPDATE_CHECK=1 waza spec verify \
		--skill "${skill_path}" \
		--eval "${eval_path}" \
		--format github-actions \
		--fail
done

echo "Waza validation passed for ${WAZA_SUITE_COUNT} skills"
