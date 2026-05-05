# language: en
@deletion
Feature: Deletion detection and historical preservation
  As a personal-scale archive
  I want to detect when X removes a post upstream
  So that I can flag it as deleted while keeping the historical text and metrics forever.

  # Three detection mechanisms — listed by likelihood and cost.
  # Posts are NEVER removed from the local store regardless of upstream state.

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And there is at least one row in the posts table

  # ---------- Mechanism 1: x_get_tweet 404 ----------

  Scenario: x_get_tweet 404 marks the cached row as deleted
    Given a posts row exists for tweet_id "T1" with deleted_at = null
    And the gate for ("get_tweet", "T1") is open
    When x_get_tweet is called for "T1"
    And upstream returns 404
    Then the posts row for "T1" has deleted_at = now
    And the response includes deleted: true and the ISO deleted_at

  Scenario: x_get_tweet 404 with no cached row simply records not_found
    Given there is no posts row for tweet_id "T2"
    When x_get_tweet is called for "T2"
    And upstream returns 404
    Then no posts row is created
    And the response is {"error": "not_found", "message": "..."}

  # ---------- Mechanism 2: bulk lookup error array ----------

  Scenario: /2/tweets?ids= errors[] entry marks deletion
    Given x_verify_posts batches a request including tweet_id "T3"
    And upstream responds with errors[] containing {"resource_type": "tweet", "value": "T3", "type": "not_found"}
    When the proxy processes the batch
    Then the posts row for "T3" has deleted_at = now
    And response.newly_deleted is incremented

  Scenario: /2/tweets?ids= missing-from-data is also treated as deletion
    Given x_verify_posts batches 100 IDs
    And the response data array contains 95 of them
    And errors[] is empty
    When the proxy processes the batch
    Then the 5 missing IDs have deleted_at = now

  # ---------- Mechanism 3: x_verify_posts deliberate sweep ----------

  Scenario: x_verify_posts sweeps a window of cached posts in 100-ID batches
    Given the cache contains 350 live posts for the user with created_at >= since_iso
    And the gate is open
    When x_verify_posts is called
    Then 4 batches are issued: 100 + 100 + 100 + 50 IDs
    And response.checked is 350

  Scenario: x_verify_posts is gated under the verify_posts interval (default 7d)
    Given x_verify_posts ran successfully 1 day ago
    When the agent calls x_verify_posts again
    Then the response is {"verified": false, "reason": "gate_closed", "next_eligible_at": "..."}
    And no upstream calls are made

  # ---------- Invariants ----------

  Scenario: Posts are never deleted from the local store
    Given a posts row has deleted_at set
    When the proxy continues running indefinitely
    Then the posts row is still queryable
    And subsequent x_posts_since calls still return it (with deleted: true)
    And no automatic purge ever removes it

  Scenario: markPostDeleted is idempotent
    Given a posts row already has deleted_at = T0
    When markPostDeleted is invoked again at T1
    Then deleted_at remains T0
    And no duplicate "newly_deleted" count is recorded

  Scenario: Reposting (rather than re-observing) does not undelete
    Given a posts row has deleted_at set (X had removed it upstream)
    When the same tweet_id reappears in upstream data via x_posts_since
    Then the row's metrics and text may update
    But deleted_at is preserved
    And subsequent reads still report deleted: true

  Scenario: x_posts_since's normal since_id flow does NOT detect deletions
    Given a posts row has been live and is later deleted upstream
    When x_posts_since runs (using since_id = newest seen)
    Then upstream returns only newer tweets — never the older deleted one
    And deleted_at remains null
    And the proxy does NOT mark it deleted
    # Spec note: this is intentional. Use x_verify_posts for active deletion detection.

  # ---------- Returned shape always includes deletion fields ----------

  Scenario: PostRecord always includes deleted and deleted_at fields
    When any tool returns a post (x_posts_since or x_get_tweet)
    Then the record has "deleted" (boolean)
    And it has "deleted_at" (ISO string or null)
