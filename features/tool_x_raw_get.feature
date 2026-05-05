# language: en
@tool @x_raw_get @escape_hatch
Feature: Tool x_raw_get
  As an MCP agent or developer
  I want an escape hatch for arbitrary GET requests against /2/*
  So that endpoints not covered by the higher-level tools are still reachable through the proxy.

  # Operation:    raw_get
  # Default gate: 24h
  # Account ID:   sha256(path + sorted_params).slice(0,16)
  # Upstream:     GET <path> on api.x.com

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "raw_get" to a 24h interval

  Scenario: Path must start with "/2/"
    When the agent calls x_raw_get with {"path": "/1.1/statuses/show.json"}
    Then the response is {"error": "invalid_path", "message": "..."}
    And no upstream call is issued

  Scenario: Forwards a successful GET to upstream and caches the response
    When the agent calls x_raw_get with {"path": "/2/some/endpoint", "params": {"a": 1, "b": "x"}}
    Then the proxy issues GET /2/some/endpoint with the params attached
    And the response is cached in url_cache
    And a fetch_gate row is written for ("raw_get", <fingerprint>)

  Scenario: Account ID is a stable hash of (path, sorted params)
    Given two calls hit "/2/x" with params {"a":"1","b":"2"} in different orders
    When the proxy computes the gate's account_id
    Then both calls resolve to the same account_id
    And both calls hit the same fetch_gate row

  Scenario: Different params yield different account IDs and gate rows
    Given a call with {"a":"1"} was made and cached
    When the agent calls again with {"a":"2"}
    Then a different account_id is computed
    And a new fetch_gate row is written
    And the second call hits upstream (no shared cache between distinct param sets)

  Scenario: Repeated identical call within 24h serves from cache
    Given a successful x_raw_get for "/2/some/endpoint" with params P was made 23h ago
    When the agent calls x_raw_get with the same path and params P
    Then no upstream call is issued
    And the cached body is returned

  Scenario: Tool description discourages use when a higher-level tool exists
    When the agent reads the tool's description
    Then the description recommends x_posts_since, x_follows_changes_since, x_get_user_by_username, x_get_user_by_id, x_get_tweet for any operation they cover

  Scenario: params accepts string, number, and boolean values
    When the agent calls x_raw_get with {"path": "/2/x", "params": {"s": "abc", "n": 42, "b": true}}
    Then the upstream URL is "{X_API_BASE}/2/x?b=true&n=42&s=abc"
    And params are URL-encoded as needed

  Scenario: Event log entry records this tool's name
    When the agent calls x_raw_get
    Then the event log entry has mcp_tool "x_raw_get"
    And operation "raw_get"
    And endpoint_template equals the requested path
    And account_id is the (path, sorted-params) fingerprint
