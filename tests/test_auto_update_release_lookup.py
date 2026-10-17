import subprocess
import tempfile
import pytest


SCRIPT_TEMPLATE = """
set -eo pipefail
RESPONSE='{api_response}'

LATEST_RELEASE=$(echo "$RESPONSE" | jq -r '.tag_name // empty' 2>/dev/null)
if [ -z "$LATEST_RELEASE" ] || [ "$LATEST_RELEASE" = "null" ]; then
  echo "Error: Failed to get a valid release tag from GitHub API." >&2
  echo "API Response: $RESPONSE" >&2
  exit 1
fi

VERSION=$(echo "$LATEST_RELEASE" | sed 's/^v//')
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ] || ! [[ "$VERSION" =~ ^[0-9a-zA-Z_][0-9a-zA-Z_.-]*$ ]]; then
  echo "Error: Invalid version '$VERSION'" >&2
  exit 1
fi
echo "version=$VERSION"
"""


def run_script(api_response):
    script = SCRIPT_TEMPLATE.format(api_response=api_response)
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
    )


def test_valid_release_tag():
    res = run_script('{"tag_name": "v2026.1.29"}')
    assert res.returncode == 0
    assert "version=2026.1.29" in res.stdout


def test_valid_release_tag_without_v():
    res = run_script('{"tag_name": "2026.9.9"}')
    assert res.returncode == 0
    assert "version=2026.9.9" in res.stdout


def test_rate_limit_api_error_is_logged_and_rejected():
    error_payload = '{"message": "API rate limit exceeded", "documentation_url": "https://docs.github.com"}'
    res = run_script(error_payload)
    assert res.returncode != 0
    assert "Error: Failed to get a valid release tag from GitHub API." in res.stderr
    assert "API rate limit exceeded" in res.stderr


def test_null_tag_name_rejected():
    res = run_script('{"tag_name": null}')
    assert res.returncode != 0
    assert "Error: Failed to get a valid release tag from GitHub API." in res.stderr


def test_literal_null_string_tag_rejected():
    res = run_script('{"tag_name": "vnull"}')
    assert res.returncode != 0
    assert "Error: Invalid version 'null'" in res.stderr
