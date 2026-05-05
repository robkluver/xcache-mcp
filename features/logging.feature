# language: en
@logging
Feature: JSONL event and body logging
  As an offline AI analyzer reading the proxy's logs
  I want rich, structured, redacted event records on disk
  So that I can recommend tuning changes (longer gates, narrower fields, etc.) without ever needing real-time observability.

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And app.config.json logging.bodies is true unless otherwise stated

  # ---------- File layout and rotation ----------

  Scenario: Events log lives at events/<UTC-date>.jsonl
    When the proxy logs at any point during the UTC day "2026-05-05"
    Then the file path is "<storage.root>/logs/events/2026-05-05.jsonl"

  Scenario: Bodies log lives at bodies/<UTC-date>.jsonl
    When logging.bodies=true and a live upstream call is logged
    Then a body line is appended to "<storage.root>/logs/bodies/<UTC-date>.jsonl"

  Scenario: Daily rotation occurs at UTC midnight by filename
    Given an event is logged at 2026-05-05T23:59:59Z
    When the next event is logged at 2026-05-06T00:00:01Z
    Then the first lands in events/2026-05-05.jsonl
    And the second lands in events/2026-05-06.jsonl

  Scenario: Files older than 7 days are gzipped to *.jsonl.gz
    Given a JSONL file in events/ has mtime older than 7 days
    And it is not today's file
    When the rotation pass runs (hourly or on demand)
    Then the file is read, gzipped to "<name>.jsonl.gz" with mode 0600
    And the original .jsonl file is removed

  Scenario: Today's file is never rotated even if its mtime appears stale
    When the rotation pass encounters today's events file
    Then it is left in place

  Scenario: All log files are written with mode 0600
    When any log file is created
    Then its file mode is 0600
    And re-opening for append re-asserts mode 0600

  # ---------- Off-the-critical-path queue ----------

  Scenario: Request handlers do not block on the log queue
    Given the in-memory queue is at capacity (10000 entries)
    When the request handler enqueues a new entry
    Then enqueue returns immediately
    And the oldest item in the queue is dropped to make room
    And proxy_meta "dropped_log_entries" is incremented by 1

  Scenario: Periodic flush drains the queue every 250ms
    Given items are in the queue
    When 250ms passes
    Then the LogWriter flushes the queue to disk
    And the queue is empty (until new items arrive)

  Scenario: Concurrent flushes do not interleave
    Given a flush is currently in progress
    When another flush is invoked
    Then the second flush returns immediately as a no-op

  # ---------- Drain on shutdown ----------

  Scenario: SIGTERM drains the queue with a 5-second deadline
    Given items are in the queue at the moment of SIGTERM
    When the proxy shuts down
    Then drainWithDeadline(5000) is called
    And queued events are flushed to disk before process.exit
    And events generated up to ~1 second before SIGTERM appear in the JSONL files after termination

  Scenario: drainWithDeadline gives up after the deadline elapses
    Given the disk is unwriteable and all flush attempts fail
    When SIGTERM is received
    Then drainWithDeadline returns after 5 seconds
    And the process still exits cleanly

  # ---------- Event line shape ----------

  Scenario: Every event entry contains the required metadata fields
    When any event is logged
    Then the JSON line has all of:
      | ts                 |
      | request_id         |
      | client_kind        |
      | method             |
      | url                |
      | endpoint_template  |
      | query_fingerprint  |
      | requested_fields   |
      | is_paginated       |
      | status             |
      | source             |
      | cache_outcome      |
      | gate_state         |
      | duration_ms        |
      | response_bytes     |
      | rate_limit_limit   |
      | rate_limit_remaining|
      | rate_limit_reset   |
      | error_class        |
      | error_message      |
      | body_truncated     |
      | body_ref           |

  Scenario Outline: source values map to cache_outcome values
    When an event is logged with source "<source>"
    Then cache_outcome is "<outcome>"

    Examples:
      | source       | outcome       |
      | live         | miss          |
      | cache        | hit           |
      | gate_blocked | gate_blocked  |
      | error        | miss          |

  Scenario: body_ref is null when logging.bodies=false
    Given app.config.json logging.bodies is false
    When a live upstream call is logged
    Then the event entry's body_ref is null
    And no bodies/<date>.jsonl file is created

  Scenario: body_ref is "bodies/<UTC-date>.jsonl" when logging.bodies=true
    Given app.config.json logging.bodies is true
    When a live upstream call is logged
    Then the event entry's body_ref is "bodies/<UTC-date>.jsonl"
    And the body itself is enqueued to that file as {"request_id": ..., "body": ...}

  Scenario: agent_session_id is captured from X-Agent-Session header (HTTP/REST surfaces)
    When a request includes the header "X-Agent-Session: sess-abc"
    Then the resulting event entry has agent_session_id "sess-abc"

  Scenario: mcp_tool is null for REST passthrough events
    When a /2/* REST request is logged
    Then mcp_tool is null

  Scenario: mcp_tool is set for MCP-driven events
    When an MCP tools/call dispatches a tool
    Then the resulting event entries have mcp_tool equal to the tool name

  # ---------- Ordering guarantees ----------

  Scenario: Within a process lifetime, event lines are appended in enqueue order
    When N events are enqueued in order
    Then the JSONL lines appear in that same order
    And no reordering is performed by the writer

  # ---------- Stop semantics ----------

  Scenario: Enqueues after stop() are no-ops
    Given the LogWriter has been stopped
    When the request handler enqueues an event
    Then nothing is written to disk
    And the queue does not grow
