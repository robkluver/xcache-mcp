# language: en
@rest @passthrough
Feature: REST passthrough at GET /2/*
  As a developer debugging X API responses
  I want to issue ad-hoc curl requests against /2/* through the proxy
  So that I can use jq pipelines and scripts while still benefiting from caching and throttling.

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps the "raw_get" operation to a 24h interval

  Scenario: GET /healthz returns liveness JSON
    When the client sends "GET /healthz"
    Then the response status is 200
    And the response body parses as JSON
    And the JSON has key "ok" with value true

  Scenario: GET / returns a short text help message
    When the client sends "GET /"
    Then the response status is 200
    And the body is plain text
    And the body mentions the routes "/healthz", "/2/*", and "/mcp"

  Scenario: First /2/* call forwards to the upstream X API
    Given there is no cached response for the path
    When the client sends "GET /2/users/by/username/xdevelopers"
    Then the proxy issues a single upstream GET to "{X_API_BASE}/2/users/by/username/xdevelopers"
    And the upstream request includes "Authorization: Bearer <X_BEARER_TOKEN>"
    And the response from the proxy mirrors the upstream status and body
    And the response includes a header "x-xcache-source: live"
    And url_cache is updated with the response
    And a fetch_gate row is written for ("raw_get", <fingerprint>)

  Scenario: Identical /2/* call within the throttle window is served from cache
    Given a successful "GET /2/users/by/username/xdevelopers" was made 1 hour ago
    When the client repeats the same request
    Then no upstream call is issued
    And the response body matches the cached body
    And the response includes a header "x-xcache-source: cache"

  Scenario: Cache key normalizes query parameter order
    Given a successful "GET /2/x?a=1&b=2" was made
    When the client sends "GET /2/x?b=2&a=1"
    Then the same url_cache entry is hit
    And no upstream call is issued

  Scenario: Bearer token added by the proxy is not visible to the caller
    When the client sends "GET /2/users/by/username/xdevelopers"
    Then the request received from the client does not need to include any Authorization header
    And the proxy's outbound request to upstream uses the configured X_BEARER_TOKEN
    And the response headers stored in url_cache have the Authorization key replaced with "<redacted>"

  Scenario: Stale cache fallback on upstream failure
    Given a successful "GET /2/users/by/username/xdevelopers" was made and cached
    And the gate has elapsed and is now open
    When the next call's upstream attempt returns a 503 error
    Then the proxy returns the previously-cached body
    And the response status is the cached status (e.g. 200)
    And the response includes a header "x-xcache-source: stale_cache"
    And a fetch_gate error row is written

  Scenario: Gate-closed and no cached response returns 429
    Given the gate is closed because of a recent error
    And no url_cache entry exists for this path
    When the client sends the matching request
    Then the response status is 429
    And the response body is JSON with error "gate_blocked"
    And the response includes a header "x-xcache-source: gate_blocked"
    And no upstream call is issued

  Scenario: Query string is preserved in the cache key
    Given a successful "GET /2/tweets/123?tweet.fields=created_at" was made
    When the client sends "GET /2/tweets/123?tweet.fields=public_metrics"
    Then the second request misses the cache
    And a separate url_cache entry is created for the new field set

  Scenario: Account ID for raw_get is a hash of (path, sorted params)
    Given two calls hit the same path with the same params in different order
    When the proxy computes the gate's account_id for each
    Then both account_ids are identical
    And only one gate row exists for this combination

  Scenario: Non-/2/ paths are not handled by the passthrough route
    When the client sends "GET /1.1/statuses/show.json"
    Then the proxy returns a 404 Fastify route-not-found response
    And no upstream call is issued

  Scenario: REST events are written to the JSONL log with client_kind=rest
    When the client makes any /2/* request
    Then an event line is enqueued to logs/events/<UTC-date>.jsonl
    And the entry has client_kind "rest"
    And the entry has method "GET"

  Scenario: X-Agent-Session header is captured into the event log
    When the client sends a request with header "X-Agent-Session: sess-abc"
    Then the resulting event log entry has agent_session_id "sess-abc"
