# language: en
@consolidation
Feature: Offline log consolidation into a Markdown summary
  As an offline AI analyzer (or human operator)
  I want a token-efficient summary of recent proxy activity
  So that I can recommend tuning changes (longer gates, narrower fields, deduplication opportunities) without needing live observability.

  # Invocation:
  #   npx xcache-mcp consolidate --since 7d --output report.md
  #   npx xcache-mcp-consolidate --from 2026-04-29 --to 2026-05-05 --output report.md
  #   npm run consolidate -- --since 1d --output report.md
  # Reads from $STORAGE_ROOT/logs/events/*.jsonl[.gz] by default.

  # ---------- Window resolution ----------

  Scenario Outline: --since accepts standard interval syntax
    When the user runs the consolidate command with "--since <spec>"
    Then the window covers the last <duration>

    Examples:
      | spec | duration  |
      | 1d   | 1 day     |
      | 7d   | 7 days    |
      | 24h  | 24 hours  |
      | 60m  | 60 minutes|

  Scenario: --from / --to define a closed window
    When the user runs the command with "--from 2026-04-29 --to 2026-05-05"
    Then the window starts at 2026-04-29T00:00:00Z
    And the window ends at 2026-05-05T00:00:00Z

  Scenario: Default window is the last 7 days
    When the user runs the command with no --since/--from/--to
    Then the window covers the last 7 days ending now

  Scenario: --logs-dir overrides the default log location
    Given a custom logs directory was passed via --logs-dir
    When the consolidate command runs
    Then it reads only events files from that directory

  # ---------- File discovery ----------

  Scenario: Reads .jsonl files
    Given events/2026-05-05.jsonl exists with N lines in the window
    When the consolidate command runs
    Then all N event lines are processed

  Scenario: Reads gzipped .jsonl.gz files transparently
    Given events/2026-05-04.jsonl.gz exists
    When the consolidate command runs
    Then the file is decompressed in memory and processed

  Scenario: Files outside the window are ignored
    Given an events file dated 60 days ago exists
    When the user runs with --since 7d
    Then that file is not opened

  Scenario: Malformed JSON lines are silently skipped
    Given an events file contains a line that fails JSON.parse
    When the consolidate command runs
    Then the bad line is skipped
    And the report's processing notes record the count of skipped lines (or zero if everything parsed)

  # ---------- Report sections ----------

  Scenario: Empty window produces a minimal report with a (no events in window) note
    Given there are no events in the requested window
    When the consolidate command runs
    Then the report includes the "## window" section with all-zero totals
    And it includes the line "(no events in window)"
    And it does not include any other section

  Scenario: Populated window produces all relevant sections
    Given the events files contain a mix of live, cache, gate_blocked, error, and paginated events
    When the consolidate command runs
    Then the report includes the sections (each only when it has data):
      | window                            |
      | top endpoints by upstream calls   |
      | upstream-call hotspots            |
      | redundancy hotspots               |
      | field-set drift                   |
      | pagination depth                  |
      | rate-limit incidents              |
      | errors                            |
      | hourly time series                |
      | raw samples                       |
      | processing notes                  |

  Scenario: window section reflects accurate totals
    Given the window contains R requests, U upstream calls, H cache hits, B gate-blocked, E errors, BY total bytes
    When the report is generated
    Then the "## window" JSON block has fields matching those values

  Scenario: top endpoints by upstream calls aggregates by endpoint_template
    Given two events with different URLs but the same endpoint_template
    When the report is generated
    Then both events count toward a single endpoint row
    And the row shows aggregate upstream count, byte total, hit_rate, and gate_block_rate

  Scenario: upstream-call hotspots groups by (operation, account_id)
    Given multiple upstream events for ("get_latest_posts", "12345")
    When the report is generated
    Then a row appears showing operation, account_id, upstream_calls, and median_minutes_between
    And rows are sorted descending by upstream_calls
    And at most 10 rows appear

  Scenario: redundancy hotspots flag query fingerprints with multiple upstream calls
    Given two or more upstream events share the same query_fingerprint
    When the report is generated
    Then the redundancy hotspots section lists the fingerprint with its upstream count
    And it omits fingerprints with only 1 upstream call

  Scenario: field-set drift surfaces inconsistent field requests
    Given multiple upstream events have the same query_fingerprint but different requested_fields sets
    When the report is generated
    Then the field-set drift section lists the endpoint, fingerprint, and observed sets with their counts

  Scenario: pagination depth reports p50/p90/p99/max per endpoint
    Given paginated events grouped under multiple chain IDs
    When the report is generated
    Then each endpoint that paginated has a row with p50, p90, p99, and max depths

  Scenario: rate-limit incidents flag low remaining quotas
    Given an event with rate_limit_remaining <= 20% of rate_limit_limit
    When the report is generated
    Then a row appears with the endpoint, hour bucket, min remaining, limit, and calls in that hour

  Scenario: errors are aggregated by class and code
    Given events with statuses 401, 401, 404, 503
    When the report is generated
    Then the errors section's JSON has {"4xx": {"401": 2, "404": 1}, "5xx": {"503": 1}}

  Scenario: hourly time series is dense and parsable
    When the report is generated
    Then it includes a "## hourly time series" section with schema "[hour, requests, upstream, hit_rate, errors]"
    And each row is a JSON array, sorted ascending by hour

  Scenario: raw samples are capped at 5 per category
    When the report is generated
    Then no raw-sample category lists more than 5 entries

  # ---------- Token efficiency ----------

  Scenario: Aggregates first, samples second; both capped
    When the report is generated
    Then aggregate tables come before raw samples
    And table rows are capped at 10
    And byte counts are rounded (e.g. "92e6", not the exact byte count)

  Scenario: Endpoint templates, never raw URLs in tables
    When the report is generated
    Then endpoint columns show "/2/users/{id}/tweets" not "/2/users/2244994945/tweets"

  Scenario: Empty sections are dropped entirely
    Given a category has no qualifying data (e.g. no rate-limit incidents)
    When the report is generated
    Then the corresponding "## ..." heading is absent from the output
