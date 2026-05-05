# language: en
@caching @philosophy
Feature: Infinite-retention caching
  As a personal-scale archive of X content
  I want cached responses to live forever
  So that historical data is never lost — even if X deletes the upstream record.

  # The throttle gate is the only mechanism that limits upstream calls.
  # Cache age plays no role in deciding whether to refresh.

  Scenario: A cached response is never expired by age
    Given an entry in url_cache fetched 30 days ago
    When the proxy reads it back
    Then the entry is returned regardless of its age

  Scenario: Cache decides freshness via the gate, not via TTL
    Given the gate for "(op, acct)" is closed
    And the cache has a stored response from 6 months ago
    When a request matching that operation arrives
    Then the 6-month-old cached body is returned
    And no upstream call is made

  Scenario: First call with no cache populates the cache and gate
    Given there is no url_cache entry and no fetch_gate row for the requested URL
    When the proxy makes a successful upstream call
    Then the response body is written to url_cache with first_fetched_at = now and last_fetched_at = now
    And a fetch_gate row is written with last_status from the response

  Scenario: Subsequent successful refreshes preserve first_fetched_at
    Given a url_cache entry exists with first_fetched_at = T0
    When the proxy refreshes upstream and writes the cache again at T1
    Then first_fetched_at remains T0
    And last_fetched_at is updated to T1
    And the body is replaced with the latest response

  Scenario: Stale-cache fallback when upstream errors
    Given a url_cache entry exists from a previous successful call
    And the gate is open
    When the upstream call fails with a 5xx error
    Then the proxy returns the cached body to the caller
    And a fetch_gate error row is written with last_status of the failed response
    And the response includes a header "x-xcache-source: stale_cache" (REST surface only)
    And no cache eviction occurs

  Scenario: Cache key is canonical (sorted query params, normalized path)
    Given two requests with the same params in different orders
    When the proxy computes the cache key for each
    Then both requests resolve to the same url_cache row

  Scenario: posts table is a permanent accumulator
    Given a tweet was inserted via x_posts_since
    When the same tweet is observed again on a later poll
    Then first_observed_at is preserved
    And last_observed_at is updated
    And public_metrics fields are updated to the latest values

  Scenario: posts table never deletes rows
    Given the posts table contains a tweet
    When the tweet is observed missing on the next poll or via x_verify_posts
    Then the row is NOT deleted
    And deleted_at is set to the observation time
    And the row remains queryable forever

  Scenario: follow_snapshots are append-only
    Given a follow snapshot was inserted at T0
    When a new follow snapshot is inserted at T1
    Then both snapshots remain in the database
    And neither is overwritten or removed

  Scenario: Database schema is bootstrapped idempotently on startup
    Given the database file exists from a previous run
    When the proxy starts
    Then no schema is dropped or recreated
    And missing tables are created via "CREATE TABLE IF NOT EXISTS"

  Scenario: SQLite uses WAL mode for concurrent readers
    Given the proxy has opened the SQLite database
    When the proxy queries the journal_mode pragma
    Then the result is "wal"
