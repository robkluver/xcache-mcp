# language: en
@tool @x_get_tweet @deletion
Feature: Tool x_get_tweet
  As an MCP agent
  I want to look up a single tweet by ID or URL
  So that I can fetch its text and metrics, and so that the proxy can remember it forever even if X removes it.

  # Operation:    get_tweet
  # Default gate: never (once cached, never refresh upstream)
  # Account ID:   the tweet ID itself
  # Upstream:     GET /2/tweets/:id

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "get_tweet" to "never"
    And the throttle config maps the "404" error code to a 1h retry interval

  # ---------- ID extraction ----------

  Scenario: Numeric ID is accepted directly
    When the agent calls x_get_tweet with {"id_or_url": "1854823981273648129"}
    Then the upstream URL ends with "/2/tweets/1854823981273648129"

  Scenario Outline: URL form extracts the trailing numeric ID
    When the agent calls x_get_tweet with {"id_or_url": "<input>"}
    Then the proxy extracts tweet ID "<extracted>"
    And the upstream URL ends with "/2/tweets/<extracted>"

    Examples:
      | input                                            | extracted |
      | https://x.com/user/status/1234567890             | 1234567890|
      | https://twitter.com/user/status/9876543210       | 9876543210|
      | https://x.com/user/status/123?s=20&t=abc         | 123       |
      | x.com/user/status/42                             | 42        |

  Scenario: Invalid id_or_url returns a structured error
    When the agent calls x_get_tweet with {"id_or_url": "not-a-tweet"}
    Then the response is a JSON object with error "invalid_id_or_url"
    And no upstream call is made

  # ---------- Caching and gate=never semantics ----------

  Scenario: First successful lookup caches the response and the post row
    Given there is no cached entry for tweet "1234567890"
    When the agent calls x_get_tweet with {"id_or_url": "1234567890"}
    And upstream returns 200 with the tweet data
    Then url_cache is updated for the canonical URL
    And a row is upserted into the posts table for tweet_id "1234567890"
    And the gate is written with success status 200
    And the gate's effective interval is "never" → next_eligible_at is null

  Scenario: Subsequent calls always serve from cache (gate=never_after_success)
    Given a successful x_get_tweet for "1234567890" was made at any earlier time
    When the agent calls x_get_tweet again with {"id_or_url": "1234567890"}
    Then no upstream call is made
    And the cached response is returned
    And the response includes the cached_record from the posts table
    And deleted is false

  # ---------- Deletion detection on 404 ----------

  Scenario: 404 on a previously-cached tweet marks deleted_at and returns the cached version
    Given a successful x_get_tweet for "1234567890" was cached previously
    And the gate has been forced open (e.g. via test fixture or never-cached scenario)
    When the agent calls x_get_tweet with {"id_or_url": "1234567890"}
    And upstream returns 404
    Then the posts row for "1234567890" has deleted_at = now
    And the response is the cached record with deleted: true and a populated deleted_at ISO string
    And a fetch_gate error row is written with last_status 404

  Scenario: 404 on a tweet we have never cached returns not_found
    Given there is no cached entry and no posts row for tweet "9999999999"
    When the agent calls x_get_tweet with {"id_or_url": "9999999999"}
    And upstream returns 404
    Then the response is {"error": "not_found", "message": "..."}
    And a fetch_gate error row is written with last_status 404
    And no posts row is created

  Scenario: After a 404 with no cache, gate-closed-no-cache returns gate_blocked
    Given the previous scenario left a 404 gate row for "9999999999"
    When the agent retries x_get_tweet with {"id_or_url": "9999999999"} within the 1h retry window
    Then no upstream call is made
    And a structured "gate_blocked" result is returned with last_status 404 and next_eligible_at
    And an event log entry with source "gate_blocked" is recorded

  # ---------- Field expansion ----------

  Scenario: tweet.fields, expansions, and user.fields parameters affect the cache key
    Given a successful call with no extra fields was cached
    When the agent calls x_get_tweet with {"id_or_url": "1234567890", "tweet.fields": "created_at,public_metrics"}
    Then a separate url_cache entry is created
    And the second call hits upstream (because the gate's "never" only applies after a successful call against the same canonical URL)

  # ---------- Tool description ----------

  Scenario: Description marks deletion semantics and steers monitoring toward x_posts_since
    When the agent reads the tool's description
    Then the description explains that historical text and metrics are preserved on deletion
    And the description recommends x_posts_since for repeated monitoring

  # ---------- Event log ----------

  Scenario: Event log entry records this tool's name and the gate state
    When the agent calls x_get_tweet
    Then the event log entry has mcp_tool "x_get_tweet"
    And operation "get_tweet"
    And account_id matching the tweet ID
    And gate_state.open reflects whether the upstream call happened
