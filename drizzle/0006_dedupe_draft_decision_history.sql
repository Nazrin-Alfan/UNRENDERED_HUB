DELETE FROM draft_decision_history
WHERE id NOT IN (
  SELECT MIN(id) FROM draft_decision_history GROUP BY content_id, decision, note, source
);
