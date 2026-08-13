#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/waza-suites.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly OUTPUT_DIR="${1:-${REPO_ROOT}/.waza-results/live}"

expected_version="waza version ${WAZA_VERSION}"
actual_version="$(WAZA_NO_UPDATE_CHECK=1 waza --version)"
if [[ "${actual_version}" != "${expected_version}" ]]; then
	echo "Expected ${expected_version}, got ${actual_version}" >&2
	exit 1
fi

if [[ -z "${COPILOT_SDK_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
	echo "COPILOT_SDK_TOKEN or GITHUB_TOKEN must contain a Copilot-capable token for live Waza evaluations" >&2
	exit 1
fi

results_dir="${OUTPUT_DIR}/results"
transcripts_dir="${OUTPUT_DIR}/transcripts"
comments_dir="${OUTPUT_DIR}/comments"
logs_dir="${OUTPUT_DIR}/logs"
comment_file="${OUTPUT_DIR}/comment.md"
mkdir -p "${results_dir}" "${transcripts_dir}" "${comments_dir}" "${logs_dir}"

# Renders "<value> (threshold <threshold>) — passed|failed" from a result JSON,
# or a placeholder when the metric or the file is unavailable.
trigger_accuracy_summary() {
	local result_file="$1"

	if [[ ! -s "${result_file}" ]] || ! command -v jq >/dev/null 2>&1; then
		echo "not reported"
		return 0
	fi

	jq -r '
		.metrics.trigger_accuracy as $m
		| if $m == null then
			"not reported"
		  else
			"\($m.value) (threshold \($m.threshold)) — \(if $m.passed then "passed" else "failed" end)"
		  end
	' "${result_file}" 2>/dev/null || echo "not reported"
}

formatted_report() {
	local report_file="$1"
	local log_file="$2"

	awk '
		/^## .*Waza Eval Results$/ { found = 1 }
		found && /^Results saved to:/ { exit }
		found { print }
		END {
			if (!found) {
				print "> Waza did not emit a formatted report."
			}
		}
	' "${report_file}"

	if ! grep -q '^## .*Waza Eval Results$' "${report_file}"; then
		if grep -q 'copilot is not authenticated' "${log_file}"; then
			echo
			echo "> Copilot authentication failed. Configure a valid repository \`COPILOT_TOKEN\` secret; Waza receives it as \`COPILOT_SDK_TOKEN\`."
		else
			local diagnostic
			diagnostic="$(
				grep -Ev '^(time=.* level=(WARN|INFO) |$)' "${log_file}" |
					tail -n 1 |
					tr '\n' ' ' |
					cut -c1-500
			)"
			if [[ -n "${diagnostic}" ]]; then
				echo
				echo "> Failure detail: \`${diagnostic}\`"
			fi
		fi
		echo
		echo "> See the workflow artifact for raw output."
	fi
}

{
	echo "<!-- vscode-team-kit-waza-eval -->"
	echo "# Waza evaluation"
	echo
	echo "Complete non-blocking live-model evaluation with Waza ${WAZA_VERSION}."
} >"${comment_file}"

cd "${REPO_ROOT}"
overall_status=0
for pair in "${WAZA_SKILL_EVAL_PAIRS[@]}"; do
	skill_path="${pair%%|*}"
	eval_path="${pair#*|}"
	skill_name="$(basename "${skill_path}")"
	report_file="${comments_dir}/${skill_name}.md"
	result_file="${results_dir}/${skill_name}.json"
	log_file="${logs_dir}/${skill_name}.stderr.log"

	args=(
		run "${eval_path}"
		--no-cache
		--output "${result_file}"
		--transcript-dir "${transcripts_dir}/${skill_name}"
		--format github-comment
	)
	if [[ "${WAZA_VERBOSE:-false}" == "true" ]]; then
		args+=(--verbose)
	fi

	# Keep stderr out of the report markdown: it is captured in logs/ and
	# echoed to this script's stderr so it stays visible in CI logs.
	set +e
	WAZA_NO_UPDATE_CHECK=1 waza "${args[@]}" 2>"${log_file}" | tee "${report_file}"
	status="${PIPESTATUS[0]}"
	set -e

	if [[ -s "${log_file}" ]]; then
		cat "${log_file}" >&2
	fi

	trigger_summary="$(trigger_accuracy_summary "${result_file}")"

	{
		echo
		echo "---"
		echo
		echo "## ${skill_name}"
		echo
		formatted_report "${report_file}" "${log_file}"
		echo
		echo "**Trigger accuracy:** ${trigger_summary}"
		if [[ "${status}" -eq 0 ]]; then
			echo "**Command status:** passed"
		else
			echo "**Command status:** failed (exit ${status})"
		fi
	} >>"${comment_file}"

	if [[ "${status}" -ne 0 ]]; then
		overall_status=1
	fi
done

{
	echo
	echo "---"
	echo
	if [[ "${overall_status}" -eq 0 ]]; then
		echo "**Overall status:** all ${WAZA_SUITE_COUNT} suites passed."
	else
		echo "**Overall status:** one or more suites failed. This evaluation is informational and does not block merges."
	fi
} >>"${comment_file}"

exit "${overall_status}"
