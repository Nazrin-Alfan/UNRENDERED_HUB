CREATE TABLE `draft_decision_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`decision` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'hub' NOT NULL,
	`decided_at` integer NOT NULL
);
