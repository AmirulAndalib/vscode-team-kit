#!/usr/bin/env bash

# shellcheck disable=SC2034
readonly WAZA_VERSION="0.38.5"
readonly WAZA_SKILL_ROOTS=(
	"ban-ast/skills"
	"component-explorer/skills"
	"model-council/skills"
	"review-areas/skills"
)
readonly WAZA_SKILL_EVAL_PAIRS=(
	"ban-ast/skills/manage-bans|ban-ast/skills/manage-bans/evals/eval.yaml"
	"component-explorer/skills/setup-component-explorer|component-explorer/skills/setup-component-explorer/evals/eval.yaml"
	"component-explorer/skills/setup-component-explorer-full|component-explorer/skills/setup-component-explorer-full/evals/eval.yaml"
	"component-explorer/skills/setup-component-explorer-light|component-explorer/skills/setup-component-explorer-light/evals/eval.yaml"
	"component-explorer/skills/use-component-explorer|component-explorer/skills/use-component-explorer/evals/eval.yaml"
	"model-council/skills/council-plan|model-council/skills/council-plan/evals/eval.yaml"
	"model-council/skills/council-review|model-council/skills/council-review/evals/eval.yaml"
	"review-areas/skills/review-areas|review-areas/skills/review-areas/evals/eval.yaml"
)
readonly WAZA_SUITE_COUNT="${#WAZA_SKILL_EVAL_PAIRS[@]}"
