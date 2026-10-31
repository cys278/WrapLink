#!/usr/bin/env bash
# Fans tester.mjs out to every EC2 instance tagged Role=wraplink-tester using
# AWS Systems Manager, then collects and aggregates the results from S3.
#
# Requirements on each tester: the repo cloned at $REPO_DIR, `npm ci` done,
# the SSM agent running, and an instance profile allowed to write to the
# bucket and log group. Your workstation needs the AWS CLI.
#
#   TARGET_URL=http://10.0.1.20:5555/api/v1/links/demo \
#   BUCKET=my-bench-bucket ./ssm-run.sh run --duration 1800 --connections 400 --pipelining 5
#   ./ssm-run.sh status <command-id>
#   ./ssm-run.sh cancel <command-id>
#   BUCKET=my-bench-bucket ./ssm-run.sh collect <command-id>
#
# Cost warning: a 60-machine fleet costs real money per hour. Cancel runs you
# do not need and terminate the fleet when you are done.
set -euo pipefail

TAG_KEY="${TAG_KEY:-Role}"
TAG_VALUE="${TAG_VALUE:-wraplink-tester}"
REPO_DIR="${REPO_DIR:-/home/ubuntu/WrapLink}"
LOG_GROUP="${LOG_GROUP:-/aws/ssm/wraplink-benchmarks}"
START_DELAY_SECONDS="${START_DELAY_SECONDS:-60}"

command="${1:-}"
shift || true

case "$command" in
  run)
    : "${TARGET_URL:?TARGET_URL is required}"
    : "${BUCKET:?BUCKET is required}"

    # Every tester waits for the same instant, so SSM's fan-out delay does
    # not stagger the load.
    start_at="$(date -u -d "+${START_DELAY_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v+"${START_DELAY_SECONDS}"S +%Y-%m-%dT%H:%M:%SZ)"

    extra_args="$*"
    remote="cd ${REPO_DIR} && node benchmark/distributed/tester.mjs --url '${TARGET_URL}' --start-at ${start_at} --out /tmp/wraplink-results.json ${extra_args}"

    echo "Synchronized start: ${start_at}"

    # max-concurrency 100% sends to every instance at once. The default
    # (50) runs the command on batches of instances one after another.
    aws ssm send-command \
      --document-name "AWS-RunShellScript" \
      --targets "Key=tag:${TAG_KEY},Values=${TAG_VALUE}" \
      --max-concurrency "100%" \
      --max-errors "100%" \
      --timeout-seconds 7200 \
      --parameters "commands=[\"${remote//\"/\\\"}\"],executionTimeout=[\"7200\"]" \
      --output-s3-bucket-name "${BUCKET}" \
      --output-s3-key-prefix "wraplink" \
      --cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=${LOG_GROUP}" \
      --query "Command.CommandId" \
      --output text
    echo "Follow live output with: aws logs tail ${LOG_GROUP} --follow"
    ;;

  status)
    aws ssm list-command-invocations --command-id "${1:?command id}" \
      --query "CommandInvocations[].[InstanceId,Status]" --output table
    ;;

  cancel)
    aws ssm cancel-command --command-id "${1:?command id}"
    ;;

  collect)
    : "${BUCKET:?BUCKET is required}"
    id="${1:?command id}"
    mkdir -p "results/${id}"
    aws s3 sync "s3://${BUCKET}/wraplink/${id}" "results/${id}"
    node "$(dirname "$0")/aggregate.mjs" "results/${id}"
    ;;

  *)
    sed -n '2,20p' "$0"
    exit 2
    ;;
esac
